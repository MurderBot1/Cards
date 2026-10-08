/**
 * setup.js
 * The first-run "setting up the app for you" screen. The backend reports whatever it is busy doing in the
 * background (downloading the card catalog, and any future first-run work) at GET /api/setup as
 * { active, task, detail, bytes, total, error }; this polls it and shows the current task under a spinner. When nothing
 * is running the screen never appears.
 */
const POLL_MS = 1000;

const screen = document.getElementById('setup-screen');
const taskEl = document.getElementById('setup-task');
const detailEl = document.getElementById('setup-detail');
const errorEl = document.getElementById('setup-error');
const barEl = document.getElementById('setup-bar');
const spinnerEl = document.getElementById('setup-spinner');
const continueBtn = document.getElementById('setup-continue');

let dismissedError = '';
let lastError = '';

function formatBytes(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + ' GB';
  if (n >= 1e6) return (n / 1e6).toFixed(0) + ' MB';
  if (n >= 1e3) return (n / 1e3).toFixed(0) + ' KB';
  return n + ' B';
}

function render(status) {
  const failed = !status.active && status.error && status.error !== dismissedError;
  screen.classList.toggle('hidden', !(status.active || failed));
  spinnerEl.classList.toggle('hidden', !status.active);
  continueBtn.classList.toggle('hidden', !failed);
  errorEl.classList.toggle('hidden', !failed);
  if (failed) {
    lastError = status.error;
    taskEl.textContent = 'Setup didn\u2019t finish';
    detailEl.textContent = '';
    errorEl.textContent = status.error + '. It will try again the next time the app starts.';
    return;
  }
  taskEl.textContent = status.task || '';
  let progress = '';
  if (status.total) {
    const done = Math.min(status.bytes || 0, status.total);
    progress = ' \u2014 ' + formatBytes(done) + ' of ' + formatBytes(status.total) +
      ' (' + Math.floor((done / status.total) * 100) + '%)';
  } else if (status.bytes) {
    progress = ' \u2014 ' + formatBytes(status.bytes);
  }
  detailEl.textContent = (status.detail || '') + (status.detail ? progress : '');
  barEl.classList.toggle('hidden', !status.total);
  if (status.total) {
    barEl.max = status.total;
    barEl.value = Math.min(status.bytes || 0, status.total);
  }
}

async function poll() {
  let status = null;
  try {
    const res = await fetch('/api/setup', { cache: 'no-store' });
    if (res.ok) status = await res.json();
  } catch (e) { /* server not reachable yet; keep the current screen and retry */ }
  if (status) render(status);
  // keep polling while setup is running; otherwise one more look in case a later task starts
  setTimeout(poll, status && status.active ? POLL_MS : POLL_MS * 3);
}

export function initSetupScreen() {
  continueBtn.addEventListener('click', () => {
    dismissedError = lastError;
    screen.classList.add('hidden');
  });
  poll();
}
