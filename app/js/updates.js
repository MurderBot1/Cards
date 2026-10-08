/**
 * updates.js
 * Tells the user when a newer release of the app exists, and gets them its download.
 *
 * On startup (at most every few hours) and on request from the Account tab, the list of releases on GitHub is read
 * and the newest published version (vX.Y.Z; the rolling "latest" build and drafts don't count) is compared with this
 * build's version (version.js). If it is newer, a banner offers the right download for this platform: the Android
 * APK on Android, the unsigned IPA on iPhone/iPad, the zip for Windows, macOS or Linux on a computer. "Update" opens
 * that download (in the system browser; the page can't install anything itself). Android installs the downloaded
 * APK over the old one, provided both are signed with the same key (see BUILDING.md, "Updates"); an iOS IPA has to
 * be installed with a sideloading tool; on a computer you unzip it over the old copy.
 */
import { APP_VERSION } from './version.js';

const RELEASES_URL = 'https://api.github.com/repos/MurderBot1/Cards/releases?per_page=15';
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const LAST_CHECK_KEY = 'binder_update_last_check';
const DISMISSED_KEY = 'binder_update_dismissed';

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
  windows: 'Binder-windows.zip',
  macos: 'Binder-macos-arm64.zip',
  linux: 'Binder-linux.zip',
};

// The download URL of this platform's file in a release, falling back to the release page.
export function pickDownload(release, platform) {
  const name = ASSET_NAMES[platform];
  const asset = name && Array.isArray(release.assets) ? release.assets.find((a) => a.name === name) : null;
  return asset ? asset.browser_download_url : release.html_url;
}

// ---- checking and the banner ---------------------------------------------------------------------

function load(key) {
  try { return localStorage.getItem(key); } catch (e) { return null; }
}
function store(key, value) {
  try { localStorage.setItem(key, value); } catch (e) { /* ignore */ }
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

let banner = null;
let latestFound = null;

function showBanner(release) {
  latestFound = release;
  banner.querySelector('.update-banner-text').textContent = `Update available: ${release.tag_name}`;
  banner.classList.remove('hidden');
}

// Resolves to { state: 'newer', release } | { state: 'current' } | { state: 'dev' } | { state: 'error', message }
export async function checkForUpdates({ manual = false } = {}) {
  if (!parseVersion(APP_VERSION)) return { state: 'dev' };
  try {
    const res = await fetch(RELEASES_URL, { headers: { Accept: 'application/vnd.github+json' } });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const latest = pickLatest(await res.json());
    store(LAST_CHECK_KEY, String(Date.now()));
    if (latest && isNewer(latest.tag_name, APP_VERSION)) {
      if (manual || load(DISMISSED_KEY) !== latest.tag_name) showBanner(latest);
      return { state: 'newer', release: latest };
    }
    return { state: 'current' };
  } catch (err) {
    return { state: 'error', message: err.message };
  }
}

export function initUpdates({ onToast = () => {} } = {}) {
  banner = document.getElementById('update-banner');
  const version = document.getElementById('app-version');
  const checkBtn = document.getElementById('check-updates-btn');
  if (version) version.textContent = `Binder ${parseVersion(APP_VERSION) ? APP_VERSION : '(development build)'}`;

  banner.querySelector('[data-action="update"]').addEventListener('click', async () => {
    if (!latestFound) return;
    const url = pickDownload(latestFound, detectPlatform(navigator.userAgent, navigator.platform, navigator.maxTouchPoints));
    if (!(await openExternal(url))) onToast(`Couldn't open the download — get it from ${latestFound.html_url}`);
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

  if (!parseVersion(APP_VERSION)) return;
  const due = () => Date.now() - Number(load(LAST_CHECK_KEY) || 0) > CHECK_EVERY_MS;
  if (due()) checkForUpdates();
  setInterval(() => { if (due()) checkForUpdates(); }, CHECK_EVERY_MS);
}
