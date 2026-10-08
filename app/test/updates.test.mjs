import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assetSha256, detectPlatform, formatBytes, isNewer, parseVersion, pickAsset, pickDownload, pickLatest, progressText } from '../js/updates.js';

test('versions', () => {
  assert.deepEqual(parseVersion('v1.0.4'), [1, 0, 4]);
  assert.deepEqual(parseVersion('2.10.0'), [2, 10, 0]);
  for (const bad of ['latest', 'Assets', 'v1.0', 'v1.0.4-beta', '', null, undefined]) assert.equal(parseVersion(bad), null);
  assert.equal(isNewer('v1.0.5', 'v1.0.4'), true);
  assert.equal(isNewer('v1.1.0', 'v1.0.9'), true);
  assert.equal(isNewer('v1.10.0', 'v1.9.0'), true); // numeric, not alphabetical
  assert.equal(isNewer('v2.0.0', 'v1.99.99'), true);
  assert.equal(isNewer('v1.0.4', 'v1.0.4'), false);
  assert.equal(isNewer('v1.0.3', 'v1.0.4'), false);
  assert.equal(isNewer('v1.0.5', 'dev'), false);
  assert.equal(isNewer('latest', 'v1.0.4'), false);
});

const release = (tag, over = {}) => ({ tag_name: tag, draft: false, prerelease: false, html_url: `https://github.com/MurderBot1/Cards/releases/tag/${tag}`, assets: [], ...over });

test('the newest published version is picked, ignoring the rolling build, drafts and non-version tags', () => {
  const latest = pickLatest([
    release('latest', { prerelease: true }),
    release('Assets'),
    release('v1.0.3'),
    release('v1.0.5', { draft: true }),
    release('v1.0.4'),
    release('v1.0.6', { prerelease: true }),
  ]);
  assert.equal(latest.tag_name, 'v1.0.4');
  assert.equal(pickLatest([]), null);
  assert.equal(pickLatest([release('Assets'), release('latest', { prerelease: true })]), null);
  assert.equal(pickLatest(null), null);
});

test('platforms and downloads', () => {
  assert.equal(detectPlatform('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36', 'Linux armv8l'), 'android');
  assert.equal(detectPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Win32'), 'windows');
  assert.equal(detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'MacIntel'), 'macos');
  assert.equal(detectPlatform('Mozilla/5.0 (X11; Linux x86_64)', 'Linux x86_64'), 'linux');
  assert.equal(detectPlatform('', ''), null);
  // iOS says "like Mac OS X", and an iPad can claim to be a Mac; a real Mac has no touch screen
  assert.equal(detectPlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148', 'iPhone'), 'ios');
  assert.equal(detectPlatform('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15', 'iPad'), 'ios');
  assert.equal(detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', 'MacIntel', 5), 'ios');
  assert.equal(detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', 'MacIntel', 0), 'macos');

  const r = release('v1.0.5', {
    assets: [
      { name: 'SHA256SUMS.txt', browser_download_url: 'https://x/sums' },
      { name: 'Binder-windows-setup.exe', browser_download_url: 'https://x/win.exe', digest: `sha256:${'ab'.repeat(32)}` },
      { name: 'Binder-android-debug.apk', browser_download_url: 'https://x/app.apk' },
      { name: 'Binder-linux-amd64.deb', browser_download_url: 'https://x/linux.deb' },
      { name: 'Binder-macos-arm64.dmg', browser_download_url: 'https://x/mac.dmg' },
      { name: 'Binder-ios-unsigned.ipa', browser_download_url: 'https://x/app.ipa' },
    ],
  });
  assert.equal(pickDownload(r, 'android'), 'https://x/app.apk');
  assert.equal(pickDownload(r, 'windows'), 'https://x/win.exe');
  assert.equal(pickDownload(r, 'macos'), 'https://x/mac.dmg');
  assert.equal(pickDownload(r, 'linux'), 'https://x/linux.deb');
  assert.equal(pickDownload(r, 'ios'), 'https://x/app.ipa');
  assert.equal(pickDownload(r, null), r.html_url, 'unknown platform: the release page');
  assert.equal(pickDownload(release('v1.0.5'), 'linux'), 'https://github.com/MurderBot1/Cards/releases/tag/v1.0.5', 'no assets: the release page');
});

test('installer assets, their checksums and the progress text', () => {
  const asset = { name: 'Binder-windows-setup.exe', browser_download_url: 'https://x/win.exe', digest: `sha256:${'AB'.repeat(32)}` };
  const r = release('v1.0.8', { assets: [asset] });
  assert.equal(pickAsset(r, 'windows'), asset);
  assert.equal(pickAsset(r, 'linux'), null);
  assert.equal(pickAsset(r, null), null);
  assert.equal(pickAsset(null, 'windows'), null);
  assert.equal(assetSha256(asset), 'ab'.repeat(32), 'lower-cased');
  for (const bad of [{}, { digest: 'sha1:abc' }, { digest: `sha256:${'a'.repeat(63)}` }, { digest: null }, null]) assert.equal(assetSha256(bad), null);

  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(2048), '2 KB');
  assert.equal(formatBytes(98_400_000), '98 MB');
  assert.equal(formatBytes(1_200_000_000), '1.2 GB');
  assert.equal(progressText({ version: 'v1.0.8' }), 'Downloading v1.0.8…');
  assert.equal(progressText({ version: 'v1.0.8', bytes: 12_000_000 }), 'Downloading v1.0.8 — 12 MB');
  assert.equal(progressText({ version: 'v1.0.8', bytes: 12_000_000, total: 98_000_000 }), 'Downloading v1.0.8 — 12 MB of 98 MB');
  assert.equal(progressText(null), 'Downloading the update…');
});
