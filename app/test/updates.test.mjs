import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectPlatform, isNewer, parseVersion, pickDownload, pickLatest } from '../js/updates.js';

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

  const r = release('v1.0.5', {
    assets: [
      { name: 'SHA256SUMS.txt', browser_download_url: 'https://x/sums' },
      { name: 'Binder-windows.zip', browser_download_url: 'https://x/win.zip' },
      { name: 'Binder-android-debug.apk', browser_download_url: 'https://x/app.apk' },
      { name: 'Binder-linux.zip', browser_download_url: 'https://x/linux.zip' },
      { name: 'Binder-macos-arm64.zip', browser_download_url: 'https://x/mac.zip' },
    ],
  });
  assert.equal(pickDownload(r, 'android'), 'https://x/app.apk');
  assert.equal(pickDownload(r, 'windows'), 'https://x/win.zip');
  assert.equal(pickDownload(r, 'macos'), 'https://x/mac.zip');
  assert.equal(pickDownload(r, 'linux'), 'https://x/linux.zip');
  assert.equal(pickDownload(r, null), r.html_url, 'unknown platform: the release page');
  assert.equal(pickDownload(release('v1.0.5'), 'linux'), 'https://github.com/MurderBot1/Cards/releases/tag/v1.0.5', 'no assets: the release page');
});
