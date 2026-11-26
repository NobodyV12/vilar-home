import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

// Public by design: Supabase's access rules decide who sees what, not this key.
const SUPABASE_URL = "https://fpbhxqcxtnumnwombxjm.supabase.co";
const SUPABASE_KEY = "sb_publishable_DrGq96fErruJ-R2NNchKWw_3W5mXckt";
const BUCKET = "tv-home";
const TV_EDGE = 1920; // TV pictures are shrunk on the phone before upload
const THUMB_EDGE = 480;
const SIGNED_URL_SECONDS = 60 * 60;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: true } });
const $ = (id) => document.getElementById(id);
const state = { tab: "family", photos: [], viewing: null, user: null };

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
    load();
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
    toast(error ? "Couldn't change the TV. Try again." : "The TV will switch in a minute or two.");
  }),
);

// ---------- photos ----------
const TAB_HINTS = {
  family: "These rotate on the TV. Wide photos fill the screen; tall ones show three across.",
  scenery: "One of these fills the TV each day.",
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
    supabase.from("tv_home_settings").select("background").single(),
    supabase.from("tv_home_photos").select("*").order("created_at", { ascending: false }),
  ]);
  if (settings) paintBackground(settings.background);
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
  $("count-family").textContent = state.photos.filter((p) => p.kind === "family").length || "";
  $("count-scenery").textContent = state.photos.filter((p) => p.kind === "scenery").length || "";
  $("tab-hint").textContent = TAB_HINTS[state.tab];
  $("empty").hidden = list.length > 0;
  const grid = $("grid");
  grid.replaceChildren(
    ...list.map((photo) => {
      const tile = document.createElement("button");
      tile.className = "tile" + (photo.height > photo.width ? " tall" : "");
      const img = document.createElement("img");
      img.loading = "lazy";
      img.alt = "";
      if (photo.thumb) img.src = photo.thumb;
      tile.append(img);
      tile.addEventListener("click", () => openViewer(photo));
      return tile;
    }),
  );
}

// ---------- viewer / delete ----------
async function openViewer(photo) {
  state.viewing = photo;
  $("viewer-img").src = photo.thumb || "";
  const added = new Date(photo.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  $("viewer-meta").textContent = "Added " + added + (photo.added_by ? " by " + nameFor(photo.added_by) : "");
  $("viewer").hidden = false;
  const { data } = await supabase.storage.from(BUCKET).createSignedUrl(photo.path, SIGNED_URL_SECONDS);
  if (data && state.viewing === photo) $("viewer-img").src = data.signedUrl;
}
$("viewer-close").addEventListener("click", () => ($("viewer").hidden = true));
$("viewer-delete").addEventListener("click", async () => {
  const photo = state.viewing;
  if (!photo || !confirm("Remove this picture from the TV?")) return;
  const { error } = await supabase.from("tv_home_photos").delete().eq("id", photo.id);
  if (error) return toast("Couldn't remove it. Try again.");
  await supabase.storage.from(BUCKET).remove([photo.path, "thumbs/" + photo.path]);
  state.photos = state.photos.filter((p) => p.id !== photo.id);
  $("viewer").hidden = true;
  render();
  toast("Removed. The TV will drop it in a few minutes.");
});

// ---------- upload ----------
const shrink = async (file, edge, quality) => {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
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
  for (const file of files) {
    toast(`Adding ${done + failed + 1} of ${files.length}…`, 0);
    try {
      const full = await shrink(file, TV_EDGE, 0.85);
      const thumb = await shrink(file, THUMB_EDGE, 0.78);
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
    }
  }
  toast(
    failed
      ? `Added ${done}. ${failed} couldn't be added (unsupported picture type?).`
      : `Added ${done} picture${done === 1 ? "" : "s"}. They'll show on the TV in a few minutes.`,
    4000,
  );
  load();
});

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");
