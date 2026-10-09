/**
 * updates.js
 * Tells the user when a newer release of the app exists, and installs it.
 *
 * On startup (at most every few hours) and on request from the Account tab, the list of releases on GitHub is read
 * and the newest published version (vX.Y.Z; the rolling "latest" build and drafts don't count) is compared with this
 * build's version (version.js). If it is newer, a banner offers it.
 *
 * "Update" downloads this platform's installer inside the app (the backend checks it against the SHA-256 GitHub
 * publishes for the release asset) and runs it: on Windows, macOS and Linux the app then closes and the new version
 * starts; on Android the system's installer opens over the downloaded APK (it replaces the old app only if both are
 * signed with the same key, see BUILDING.md "Updates"). iOS can't install anything itself, so there (and wherever
 * the in-app way isn't available) the download opens in the browser instead. "Install updates automatically" (Account
 * tab, on by default) does all that without a tap: when the app launches (behind a "Checking for updates" screen, then
 * an "Updating Binder" screen with the download's progress), and for later checks while the app is open it only
 * downloads, leaving a "Restart to update" button so nothing closes in the middle of a scan.
 */
import { APP_VERSION } from './version.js';

const RELEASES_URL = 'https://api.github.com/repos/MurderBot1/Cards/releases?per_page=15';
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const LAUNCH_CHECK_TIMEOUT_MS = 6000;  // how long the launch screen waits for GitHub
const LAST_CHECK_KEY = 'binder_update_last_check';
const DISMISSED_KEY = 'binder_update_dismissed';
const AUTO_KEY = 'binder_auto_update';
const FAILED_KEY = 'binder_update_failed';  // the release whose automatic install failed (not retried by itself)

// ---- pure helpers (tested in app/test/updates.test.mjs) ------------------------------------------

export function parseVersion(tag) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(tag || '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

// true when version `a` is newer than `b` (both tags like 'v1.2.3'); false if either isn't a version
export function isNewer(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] > y[i];
  }
  return false;
}

// The highest published (not draft, not pre-release) vX.Y.Z release, or null.
export function pickLatest(releases) {
  let best = null;
  for (const release of Array.isArray(releases) ? releases : []) {
    if (!release || release.draft || release.prerelease || !parseVersion(release.tag_name)) continue;
    if (!best || isNewer(release.tag_name, best.tag_name)) best = release;
  }
  return best;
}

export function detectPlatform(userAgent, platform = '', touchPoints = 0) {
  const ua = `${userAgent || ''} ${platform || ''}`;
  if (/android/i.test(ua)) return 'android';
  // iOS says "like Mac OS X" in its user agent, so it has to be recognised before macOS; an iPad can even pretend to
  // be a Mac, but a Mac has no touch screen
  if (/iphone|ipad|ipod/i.test(ua) || (/mac/i.test(ua) && touchPoints > 1)) return 'ios';
  if (/win/i.test(ua) && !/darwin/i.test(ua)) return 'windows';
  if (/mac/i.test(ua)) return 'macos';
  if (/linux|x11/i.test(ua)) return 'linux';
  return null;
}

const ASSET_NAMES = {
  android: 'Binder-android-debug.apk',
  ios: 'Binder-ios-unsigned.ipa',
  windows: 'Binder-windows-setup.exe',
  macos: 'Binder-macos-arm64.dmg',
  linux: 'Binder-linux-amd64.deb',
};

// This platform's file in a release (an asset object from the GitHub API), or null.
export function pickAsset(release, platform) {
  const name = ASSET_NAMES[platform];
  return name && release && Array.isArray(release.assets) ? release.assets.find((a) => a.name === name) || null : null;
}

// The download URL of this platform's file in a release, falling back to the release page.
export function pickDownload(release, platform) {
  const asset = pickAsset(release, platform);
  return asset ? asset.browser_download_url : release.html_url;
}

// The SHA-256 GitHub publishes for an asset ("sha256:<hex>"), as lower-case hex; null if it doesn't.
export function assetSha256(asset) {
  const m = /^sha256:([0-9a-f]{64})$/i.exec(String((asset && asset.digest) || ''));
  return m ? m[1].toLowerCase() : null;
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} KB`;
  return `${n} B`;
}

// What the banner says while an update downloads: "Downloading v1.0.8 — 12 MB of 98 MB".
export function progressText(status) {
  const name = (status && status.version) || 'the update';
  const done = Number(status && status.bytes) || 0;
  const total = Number(status && status.total) || 0;
  if (!total) return done ? `Downloading ${name} — ${formatBytes(done)}` : `Downloading ${name}…`;
  return `Downloading ${name} — ${formatBytes(done)} of ${formatBytes(total)}`;
}

// ---- checking and the banner ---------------------------------------------------------------------

function load(key) {
  try { return localStorage.getItem(key); } catch (e) { return null; }
}
function store(key, value) {
  try { localStorage.setItem(key, value); } catch (e) { /* ignore */ }
}

export function autoUpdateEnabled() {
  return load(AUTO_KEY) !== 'off';
}

// Opens a download outside the page: through the Android bridge, or the local backend on a computer.
async function openExternal(url) {
  try {
    if (window.BinderAndroid && typeof window.BinderAndroid.openExternal === 'function') {
      if (window.BinderAndroid.openExternal(url)) return true;
    } else if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.binderOpen) {
      window.webkit.messageHandlers.binderOpen.postMessage(url);  // the iOS app hands it to Safari
      return true;
    } else {
      const res = await fetch('/api/open-url', { method: 'POST', body: JSON.stringify({ url }) });
      if (res.ok) return true;
    }
  } catch (e) { /* fall through to the plain way */ }
  return !!window.open(url, '_blank', 'noopener');
}

// How this build downloads and installs an update itself: { download(url, sha256), status(), install() }, each
// resolving to { ok, error?, status? }; null where it can't (iOS, or a backend without the update routes).
function updateBridge(platform) {
  if (platform === 'ios') return null;
  if (platform === 'android') {
    const native = window.BinderAndroid;
    if (!native || typeof native.updateStart !== 'function') return null;
    const call = (fn, ...args) => {
      try { return JSON.parse(native[fn](...args)); } catch (e) { return { ok: false, error: e.message }; }
    };
    return {
      download: async (url, sha256) => call('updateStart', url, sha256),
      status: async () => call('updateStatus'),
      install: async () => call('updateInstall'),
    };
  }
  const post = async (path, body) => {
    try {
      const res = await fetch(path, { method: 'POST', body: JSON.stringify(body || {}) });
      const data = await res.json().catch(() => ({}));
      return res.ok ? { ok: true } : { ok: false, unsupported: res.status === 501, error: data.error || `HTTP ${res.status}` };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  };
  return {
    download: (url, sha256) => post('/api/update/download', { url, sha256 }),
    status: async () => {
      try {
        const res = await fetch('/api/update/status');
        return res.ok ? { ok: true, ...(await res.json()) } : { ok: false, unsupported: res.status === 501, error: `HTTP ${res.status}` };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },
    install: () => post('/api/update/install'),
  };
}

let latestFound = null;
let toast = () => {};
let phase = 'idle';  // idle | downloading | ready | installing
let skipInstall = false;  // "Not now" on the updating screen: finish downloading, but wait for a tap to install

const $ = (id) => document.getElementById(id);

// ---- the full-screen "Checking for updates" / "Updating Binder" screen shown at launch ----------------------------

let screenOpen = false;

function openScreen(title) {
  screenOpen = true;
  $('update-title').textContent = title;
  $('update-task').textContent = '';
  $('update-detail').textContent = '';
  $('update-bar').classList.add('hidden');
  $('update-skip').classList.add('hidden');
  $('update-screen').classList.remove('hidden');
}

function closeScreen() {
  screenOpen = false;
  $('update-screen').classList.add('hidden');
}

function screenProgress(task, { detail = '', done = 0, total = 0, skippable = false } = {}) {
  $('update-title').textContent = 'Updating Binder';
  $('update-task').textContent = task;
  $('update-detail').textContent = detail;
  const bar = $('update-bar');
  bar.classList.toggle('hidden', !total);
  if (total) {
    bar.max = total;
    bar.value = Math.min(done, total);
  }
  $('update-skip').classList.toggle('hidden', !skippable);
}

// ---- the banner ------------------------------------------------------------------------------------------------

function setBanner(text, { button = 'Update', busy = false, dismissable = true } = {}) {
  const banner = $('update-banner');
  banner.querySelector('.update-banner-text').textContent = text;
  const update = banner.querySelector('[data-action="update"]');
  update.textContent = button;
  update.classList.toggle('hidden', busy);
  banner.querySelector('[data-action="later"]').classList.toggle('hidden', !dismissable);
  banner.classList.remove('hidden');
}

function showBanner(release) {
  latestFound = release;
  if (phase === 'idle') setBanner(`Update available: ${release.tag_name}`);
}

// Progress of the update in the one place the user is looking: the updating screen at launch, else the banner.
function showProgress(release, status, { installing = false, platform = null } = {}) {
  if (installing) {
    const task = platform === 'android' ? `Installing ${release.tag_name}` : `Installing ${release.tag_name}`;
    const detail = platform === 'android' ? 'Confirm in the installer that opens' : 'Binder will restart in a moment';
    if (screenOpen) screenProgress(task, { detail });
    else setBanner(platform === 'android' ? `Installing ${release.tag_name}…` : `Installing ${release.tag_name} — Binder will restart…`, { busy: true, dismissable: false });
    return;
  }
  if (screenOpen) {
    const done = Number(status && status.bytes) || 0;
    const total = Number(status && status.total) || 0;
    const percent = total ? ` (${Math.floor((Math.min(done, total) / total) * 100)}%)` : '';
    const detail = total ? `${formatBytes(done)} of ${formatBytes(total)}${percent}` : done ? formatBytes(done) : '';
    screenProgress(`Downloading ${release.tag_name}`, { detail, done, total, skippable: true });
  } else {
    setBanner(progressText({ ...(status || {}), version: release.tag_name }), { busy: true, dismissable: false });
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Downloads the update inside the app, then installs it unless `install` is false (the banner then waits for a tap).
// `byUser`: the person asked for it (a tap on Update). Without that, wherever the app can't update itself it just
// leaves the banner, rather than opening a browser by itself.
async function runUpdate(release, { install = true, byUser = false } = {}) {
  if (phase === 'downloading' || phase === 'installing') return;
  const platform = detectPlatform(navigator.userAgent, navigator.platform, navigator.maxTouchPoints);
  const asset = pickAsset(release, platform);
  const sha256 = assetSha256(asset);
  const bridge = asset && sha256 ? updateBridge(platform) : null;
  const leaveToBanner = async (openDownload) => {
    phase = 'idle';
    closeScreen();
    showBanner(release);
    if (openDownload && !(await openExternal(pickDownload(release, platform)))) {
      toast(`Couldn't open the download — get it from ${release.html_url}`);
    }
  };
  if (!bridge) return leaveToBanner(byUser);

  const fail = (message) => {
    store(FAILED_KEY, release.tag_name);
    toast(message || "Couldn't install the update");
    phase = 'idle';
    closeScreen();
    showBanner(release);
    setBanner(`Update available: ${release.tag_name}`, { button: 'Try again' });
  };

  phase = 'downloading';
  skipInstall = false;
  showProgress(release, null);
  const started = await bridge.download(asset.browser_download_url, sha256);
  if (!started.ok) {
    if (started.unsupported) return leaveToBanner(byUser);
    return fail(started.error);
  }
  for (;;) {
    await sleep(500);
    const status = await bridge.status();
    if (!status.ok) return fail(status.error);
    if (status.state === 'error') return fail(status.error);
    if (status.state === 'ready') break;
    if (status.state === 'downloading' && !skipInstall) showProgress(release, status);
    else if (status.state === 'downloading') setBanner(progressText({ ...status, version: release.tag_name }), { busy: true, dismissable: false });
  }

  phase = 'ready';
  if (!install || skipInstall) {
    closeScreen();
    setBanner(`${release.tag_name} is ready to install`, { button: platform === 'android' ? 'Install' : 'Restart to update' });
    return;
  }
  await installNow(release, bridge, platform);
}

async function installNow(release, bridge, platform) {
  phase = 'installing';
  showProgress(release, null, { installing: true, platform });
  const result = await bridge.install();
  if (!result.ok) {
    phase = 'ready';
    closeScreen();
    store(FAILED_KEY, release.tag_name);
    toast(result.error || "Couldn't install the update");
    setBanner(`${release.tag_name} is ready to install`, { button: platform === 'android' ? 'Install' : 'Restart to update' });
    return;
  }
  if (platform === 'android') {
    // the system installer is showing; if it was cancelled, the update stays ready to try again
    phase = 'ready';
    closeScreen();
    setBanner(`${release.tag_name} is ready to install`, { button: 'Install' });
  }
}

// Resolves to { state: 'newer', release } | { state: 'current' } | { state: 'dev' } | { state: 'error', message }
// `auto`: 'install' downloads and installs a newer release by itself, 'download' only gets it ready, 'none' leaves it
// to the banner. Automatic installs are skipped if the setting is off or this release already failed once.
export async function checkForUpdates({ manual = false, auto = 'none', timeoutMs = 0 } = {}) {
  if (!parseVersion(APP_VERSION)) return { state: 'dev' };
  const controller = timeoutMs && typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetch(RELEASES_URL, { headers: { Accept: 'application/vnd.github+json' }, signal: controller ? controller.signal : undefined });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const latest = pickLatest(await res.json());
    store(LAST_CHECK_KEY, String(Date.now()));
    if (latest && isNewer(latest.tag_name, APP_VERSION)) {
      if (manual || load(DISMISSED_KEY) !== latest.tag_name) showBanner(latest);
      if (auto !== 'none' && !manual && autoUpdateEnabled() && load(FAILED_KEY) !== latest.tag_name && phase === 'idle') {
        runUpdate(latest, { install: auto === 'install' });
      }
      return { state: 'newer', release: latest };
    }
    return { state: 'current' };
  } catch (err) {
    return { state: 'error', message: err.message };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Runs when the app launches, before anything else is shown: a "Checking for updates" screen while the newest release
 * is looked up (it gives up after a few seconds, so being offline doesn't hold the app up), then, if there is a newer
 * one and automatic updates are on, an "Updating Binder" screen with the download's progress that ends with the app
 * restarting into the new version. Otherwise the screen goes away and the app is there. Development builds skip it.
 */
export async function launchUpdateCheck() {
  if (!parseVersion(APP_VERSION)) return;
  openScreen('Checking for updates');
  $('update-task').textContent = `Binder ${APP_VERSION}`;
  $('update-skip').addEventListener('click', () => {
    skipInstall = true;
    closeScreen();
    if (latestFound) setBanner(progressText({ version: latestFound.tag_name }), { busy: true, dismissable: false });
  });
  try {
    await checkForUpdates({ auto: 'install', timeoutMs: LAUNCH_CHECK_TIMEOUT_MS });
  } finally {
    // nothing to install (or no automatic update): the app takes over; otherwise runUpdate owns the screen
    if (phase === 'idle') closeScreen();
  }
}

export function initUpdates({ onToast = () => {} } = {}) {
  toast = onToast;
  const banner = $('update-banner');
  const version = $('app-version');
  const checkBtn = $('check-updates-btn');
  if (version) version.textContent = `Binder ${parseVersion(APP_VERSION) ? APP_VERSION : '(development build)'}`;

  banner.querySelector('[data-action="update"]').addEventListener('click', async () => {
    if (!latestFound) return;
    store(FAILED_KEY, '');  // a tap is an explicit retry
    if (phase === 'ready') {
      const platform = detectPlatform(navigator.userAgent, navigator.platform, navigator.maxTouchPoints);
      return installNow(latestFound, updateBridge(platform), platform);
    }
    runUpdate(latestFound, { install: true, byUser: true });
  });
  banner.querySelector('[data-action="later"]').addEventListener('click', () => {
    if (latestFound) store(DISMISSED_KEY, latestFound.tag_name);
    banner.classList.add('hidden');
  });
  if (checkBtn) {
    checkBtn.addEventListener('click', async () => {
      checkBtn.disabled = true;
      const result = await checkForUpdates({ manual: true });
      checkBtn.disabled = false;
      if (result.state === 'dev') onToast('This is a development build, so it does not check for updates');
      else if (result.state === 'newer') onToast(`${result.release.tag_name} is available`);
      else if (result.state === 'current') onToast(`You're up to date (${APP_VERSION})`);
      else onToast("Couldn't check for updates — are you online?");
    });
  }

  // "Install updates automatically": On / Off
  const autoSetting = $('auto-update-setting');
  if (autoSetting) {
    const paint = () => {
      const value = autoUpdateEnabled() ? 'on' : 'off';
      autoSetting.querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', b.dataset.value === value ? 'true' : 'false'));
    };
    autoSetting.addEventListener('click', (event) => {
      const button = event.target.closest('button');
      if (!button) return;
      store(AUTO_KEY, button.dataset.value === 'off' ? 'off' : 'on');
      paint();
    });
    paint();
  }

  // The launch check (launchUpdateCheck) covers startup; while the app stays open, look again every few hours and
  // only download, so nothing closes in the middle of a scan.
  if (!parseVersion(APP_VERSION)) return;
  setInterval(() => {
    if (Date.now() - Number(load(LAST_CHECK_KEY) || 0) > CHECK_EVERY_MS) checkForUpdates({ auto: 'download' });
  }, CHECK_EVERY_MS / 6);
}
