import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import Sortable from "https://esm.sh/sortablejs@1.15.6";

// Public by design: Supabase's access rules decide who sees what, not this key.
const SUPABASE_URL = "https://fpbhxqcxtnumnwombxjm.supabase.co";
const SUPABASE_KEY = "sb_publishable_DrGq96fErruJ-R2NNchKWw_3W5mXckt";
const BUCKET = "tv-home";
const TV_EDGE = 1920; // TV pictures are shrunk on the phone before upload
const THUMB_EDGE = 480;
const SIGNED_URL_SECONDS = 60 * 60;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: true } });
const $ = (id) => document.getElementById(id);
const state = { tab: "family", photos: [], viewing: null, user: null, choosing: false, arranging: false };
let sortable = null;

const NAMES = {
  "ricardovilar@gmail.com": "Dad",
  "resvilar@gmail.com": "Mom",
  "nicnicvilar@gmail.com": "Nic",
  "luclucvilar@gmail.com": "Lucas",
};
const nameFor = (email) => NAMES[email] || email || "";

const toast = (text, ms = 2600) => {
  const el = $("toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toast.timer);
  if (ms) toast.timer = setTimeout(() => (el.hidden = true), ms);
};

const show = (screen) => {
  $("signin").hidden = screen !== "signin";
  $("app").hidden = screen !== "app";
};

// ---------- sign in ----------
$("signin-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("signin-error").hidden = true;
  const { error } = await supabase.auth.signInWithPassword({
    email: $("email").value.trim().toLowerCase(),
    password: $("password").value,
  });
  if (error) {
    $("signin-error").textContent = "That email and password didn't work.";
    $("signin-error").hidden = false;
  }
});
$("signout").addEventListener("click", () => supabase.auth.signOut());

supabase.auth.onAuthStateChange((_event, session) => {
  state.user = session?.user || null;
  if (state.user) {
    $("who").textContent = "Signed in as " + nameFor(state.user.email);
    show("app");
    setTimeout(load, 0);
  } else {
    show("signin");
  }
});

// ---------- TV background ----------
const paintBackground = (value) =>
  document.querySelectorAll("[data-bg]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.bg === value)));

document.querySelectorAll("[data-bg]").forEach((button) =>
  button.addEventListener("click", async () => {
    const background = button.dataset.bg;
    paintBackground(background);
    const { error } = await supabase
      .from("tv_home_settings")
      .update({ background, updated_at: new Date().toISOString() })
      .eq("id", 1);
    toast(error ? "Couldn't change the TV. Try again." : "The TV switches within a minute.");
  }),
);

// ---------- photos ----------
const TAB_HINTS = {
  family: "In play order, first to last. Tap one to see it, hide it, or delete it. New pictures go to the end.",
  scenery: "One scenery picture marked On TV fills the screen each day.",
};

document.querySelectorAll("[data-tab]").forEach((button) =>
  button.addEventListener("click", () => {
    state.tab = button.dataset.tab;
    document.querySelectorAll("[data-tab]").forEach((b) => b.classList.toggle("active", b === button));
    render();
  }),
);

async function load() {
  const [{ data: settings }, { data: photos, error }] = await Promise.all([
    supabase.from("tv_home_settings").select("background, shuffle").single(),
    supabase
      .from("tv_home_photos")
      .select("*")
      .order("position", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: true }),
  ]);
  if (settings) {
    paintBackground(settings.background);
    $("shuffle").checked = settings.shuffle;
  }
  if (error) {
    toast("Couldn't load the pictures.");
    return;
  }
  const paths = photos.map((p) => "thumbs/" + p.path);
  const signed = paths.length ? (await supabase.storage.from(BUCKET).createSignedUrls(paths, SIGNED_URL_SECONDS)).data || [] : [];
  const urlByPath = new Map(signed.map((s) => [s.path, s.signedUrl]));
  state.photos = photos.map((p) => ({ ...p, thumb: urlByPath.get("thumbs/" + p.path) }));
  render();
}

function render() {
  const list = state.photos.filter((p) => p.kind === state.tab);
  const onTv = list.filter((p) => p.shown !== false).length;
  $("on-count").textContent = list.length ? `${onTv} of ${list.length} on the TV` : "";
  $("count-family").textContent = state.photos.filter((p) => p.kind === "family").length || "";
  $("count-scenery").textContent = state.photos.filter((p) => p.kind === "scenery").length || "";
  $("tab-hint").textContent = state.arranging
    ? ARRANGE_HINT
    : state.choosing
      ? "Tap pictures to put them on or take them off the TV."
      : TAB_HINTS[state.tab];
  $("empty").hidden = list.length > 0;
  const grid = $("grid");
  grid.replaceChildren(
    ...list.map((photo) => {
      const tile = document.createElement("button");
      tile.className = "tile";
      tile.dataset.shown = String(photo.shown !== false);
      const img = document.createElement("img");
      img.loading = "lazy";
      img.alt = "";
      if (photo.thumb) img.src = photo.thumb;
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = photo.shown === false ? "Off TV" : "On TV";
      tile.append(img, badge);
      tile.dataset.id = photo.id;
      tile.addEventListener("click", () => {
        if (state.arranging) return;
        if (state.choosing) toggleShown(photo);
        else openViewer(photo);
      });
      return tile;
    }),
  );
}

// ---------- shuffle ----------
$("shuffle").addEventListener("change", async (event) => {
  const shuffle = event.target.checked;
  const { error } = await supabase.from("tv_home_settings").update({ shuffle }).eq("id", 1);
  if (error) {
    event.target.checked = !shuffle;
    return toast("Couldn't change shuffle. Try again.");
  }
  toast(shuffle ? "Shuffle on. The TV mixes them up within a minute." : "Shuffle off. The TV plays them in your order.");
});

// ---------- arrange the play order ----------
const ARRANGE_HINT = "Press and hold a picture, then drag it to where it should play. Tap Save when done.";

$("arrange").addEventListener("click", async () => {
  if (!state.arranging) {
    state.arranging = true;
    state.choosing = false;
    $("choose").textContent = "Choose what's on TV";
    $("choose").classList.remove("on");
    $("arrange").textContent = "Save order";
    $("arrange").classList.add("on");
    $("tab-hint").textContent = ARRANGE_HINT;
    $("grid").classList.add("arranging");
    sortable = Sortable.create($("grid"), { animation: 150, delay: 180, delayOnTouchOnly: true, ghostClass: "drag-ghost" });
    return;
  }
  const ids = [...$("grid").children].map((tile) => tile.dataset.id);
  sortable?.destroy();
  sortable = null;
  state.arranging = false;
  $("arrange").textContent = "Arrange";
  $("arrange").classList.remove("on");
  $("grid").classList.remove("arranging");
  const { error } = await supabase.rpc("tv_home_reorder", { ordered: ids });
  toast(error ? "Couldn't save the order. Try again." : "Order saved. The TV follows it within a minute (when shuffle is off).");
  load();
});

// ---------- on / off the TV ----------
async function toggleShown(photo) {
  const shown = photo.shown === false;
  photo.shown = shown;
  render();
  const { error } = await supabase.from("tv_home_photos").update({ shown }).eq("id", photo.id);
  if (error) {
    photo.shown = !shown;
    render();
    toast("Couldn't change that one. Try again.");
  }
}

$("choose").addEventListener("click", () => {
  if (state.arranging) return toast("Save the order first.");
  state.choosing = !state.choosing;
  $("choose").textContent = state.choosing ? "Done" : "Choose what's on TV";
  $("choose").classList.toggle("on", state.choosing);
  $("tab-hint").textContent = state.arranging
    ? ARRANGE_HINT
    : state.choosing
      ? "Tap pictures to put them on or take them off the TV."
      : TAB_HINTS[state.tab];
});

// ---------- viewer / delete ----------
async function openViewer(photo) {
  state.viewing = photo;
  $("viewer-img").src = photo.thumb || "";
  const added = new Date(photo.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  $("viewer-meta").textContent = "Added " + added + (photo.added_by ? " by " + nameFor(photo.added_by) : "");
  $("viewer-toggle").textContent = photo.shown === false ? "Show on TV" : "Take off TV";
  $("viewer").hidden = false;
  const { data } = await supabase.storage.from(BUCKET).createSignedUrl(photo.path, SIGNED_URL_SECONDS);
  if (data && state.viewing === photo) $("viewer-img").src = data.signedUrl;
}
$("viewer-toggle").addEventListener("click", async () => {
  if (!state.viewing) return;
  await toggleShown(state.viewing);
  $("viewer-toggle").textContent = state.viewing.shown === false ? "Show on TV" : "Take off TV";
});
$("viewer-close").addEventListener("click", () => ($("viewer").hidden = true));
$("viewer-delete").addEventListener("click", async () => {
  const photo = state.viewing;
  if (!photo || !confirm("Delete this picture for good? (To just hide it, use Take off TV.)")) return;
  const { error } = await supabase.from("tv_home_photos").delete().eq("id", photo.id);
  if (error) return toast("Couldn't remove it. Try again.");
  await supabase.storage.from(BUCKET).remove([photo.path, "thumbs/" + photo.path]);
  state.photos = state.photos.filter((p) => p.id !== photo.id);
  $("viewer").hidden = true;
  render();
  toast("Deleted. The TV drops it within a minute.");
});

// ---------- upload ----------
const decode = async (file) => {
  try {
    // Decoding at reduced width keeps 50-200 MP phone photos from running out of memory.
    return await createImageBitmap(file, { imageOrientation: "from-image", resizeWidth: 2400, resizeQuality: "high" });
  } catch {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    }
  }
};

const shrink = async (source, edge, quality) => {
  const bitmap = source;
  const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
  return { blob, width: canvas.width, height: canvas.height };
};

$("picker").addEventListener("change", async (event) => {
  const files = [...event.target.files];
  event.target.value = "";
  if (!files.length) return;
  const kind = state.tab;
  let done = 0;
  let failed = 0;
  let lastError = "";
  for (const file of files) {
    toast(`Adding ${done + failed + 1} of ${files.length}…`, 0);
    try {
      const picture = await decode(file);
      const full = await shrink(picture, TV_EDGE, 0.85);
      const thumb = await shrink(picture, THUMB_EDGE, 0.78);
      picture.close?.();
      const path = `${kind}/${crypto.randomUUID()}.jpg`;
      const store = supabase.storage.from(BUCKET);
      const up1 = await store.upload(path, full.blob, { contentType: "image/jpeg" });
      if (up1.error) throw up1.error;
      const up2 = await store.upload("thumbs/" + path, thumb.blob, { contentType: "image/jpeg" });
      if (up2.error) throw up2.error;
      const { error } = await supabase
        .from("tv_home_photos")
        .insert({ path, kind, width: full.width, height: full.height, added_by: state.user.email });
      if (error) throw error;
      done += 1;
    } catch (error) {
      console.error(error);
      failed += 1;
      lastError = error?.message || String(error);
    }
  }
  toast(
    failed
      ? `Added ${done}. ${failed} couldn't be added: ${lastError}`
      : `Added ${done} picture${done === 1 ? "" : "s"}. They're at the end of the list and show on the TV within a minute.`,
    failed ? 9000 : 4000,
  );
  load();
});

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");
