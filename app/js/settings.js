/**
 * settings.js
 * Handles the Account tab: sign-in / account creation (backed by the Cloudflare
 * account service in /cloudflare, via api.js),
 * loading/saving preferences via api.js, applying appearance changes
 * live (theme + font size), and wiring up the scanner preference controls.
 */
import { api } from './api.js';
import { showToast } from './ui.js';
import { clearSession, getSession, setSession } from './session.js';
import { onSyncStatus, syncNow } from './sync.js';

let currentSettings = null;
const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');

// -----------------------------------------------------------------
// sign in / create account
// -----------------------------------------------------------------
// The account service hands back a session token on sign-in / account creation. The username and token are
// remembered locally so they survive a reload; on startup the token is checked with the service, and a session
// that has expired (or was signed out elsewhere) quietly returns the app to guest mode.
// (kept by session.js)
let signInMode = 'login'; // 'login' | 'register'

const accountEls = {
  card: document.getElementById('account-card'),
  name: document.getElementById('account-name'),
  hint: document.getElementById('account-hint'),
  signinBtn: document.getElementById('account-signin-btn'),
  modal: document.getElementById('modal-signin'),
  title: document.getElementById('signin-title'),
  username: document.getElementById('signin-email'), // field id kept from markup; holds a username, not an email
  email: document.getElementById('signin-email-address'),
  emailGroup: document.getElementById('signin-email-group'),
  password: document.getElementById('signin-password'),
  error: document.getElementById('signin-error'),
  cancel: document.getElementById('signin-cancel'),
  submit: document.getElementById('signin-submit'),
  modeToggle: document.getElementById('signin-mode-toggle'),
  sync: document.getElementById('account-sync'),
  syncNow: document.getElementById('sync-now-btn'),
};

function updateAccountUI() {
  const session = getSession();
  const isSignedIn = !!session;
  accountEls.card.classList.toggle('is-signed-in', isSignedIn);
  accountEls.name.textContent = isSignedIn ? session.username : "You're browsing as a guest";
  accountEls.hint.textContent = isSignedIn
    ? 'Signed in on this device'
    : 'Sign in to sync your collections across devices';
  accountEls.sync.classList.toggle('hidden', !isSignedIn);
  accountEls.syncNow.classList.toggle('hidden', !isSignedIn);
  accountEls.signinBtn.textContent = isSignedIn ? 'Sign out' : 'Sign in';
}

function setSignInMode(mode) {
  signInMode = mode;
  const isRegister = mode === 'register';
  accountEls.title.textContent = isRegister ? 'Create account' : 'Sign in';
  accountEls.submit.textContent = isRegister ? 'Create account' : 'Sign in';
  accountEls.emailGroup.classList.toggle('hidden', !isRegister);
  accountEls.password.autocomplete = isRegister ? 'new-password' : 'current-password';
  accountEls.modeToggle.textContent = isRegister
    ? 'Already have an account? Sign in'
    : "New here? Create an account";
  hideSignInError();
}

function showSignInError(message) {
  accountEls.error.textContent = message;
  accountEls.error.classList.remove('hidden');
}
function hideSignInError() {
  accountEls.error.classList.add('hidden');
}

function openSignInModal() {
  accountEls.username.value = '';
  accountEls.email.value = '';
  accountEls.password.value = '';
  setSignInMode('login');
  updateSignInSubmitState();
  accountEls.modal.classList.remove('hidden');
  setTimeout(() => accountEls.username.focus(), 50);
}
function closeSignInModal() {
  accountEls.modal.classList.add('hidden');
}
function updateSignInSubmitState() {
  const needsEmail = signInMode === 'register';
  accountEls.submit.disabled = !(
    accountEls.username.value.trim() && accountEls.password.value && (!needsEmail || accountEls.email.value.trim())
  );
}

accountEls.signinBtn.addEventListener('click', () => {
  const session = getSession();
  if (session) {
    clearSession();
    api.logout(session.token).catch(() => { /* already signed out locally; the session expires on its own */ });
    updateAccountUI();
    showToast('Signed out');
  } else {
    openSignInModal();
  }
});
accountEls.username.addEventListener('input', updateSignInSubmitState);
accountEls.password.addEventListener('input', updateSignInSubmitState);
accountEls.email.addEventListener('input', updateSignInSubmitState);
accountEls.cancel.addEventListener('click', closeSignInModal);
accountEls.modal.addEventListener('click', (e) => { if (e.target === accountEls.modal) closeSignInModal(); });
accountEls.modeToggle.addEventListener('click', () => {
  setSignInMode(signInMode === 'login' ? 'register' : 'login');
  updateSignInSubmitState();
  (signInMode === 'register' ? accountEls.email : accountEls.password).focus();
});

accountEls.submit.addEventListener('click', async () => {
  const username = accountEls.username.value.trim();
  const email = accountEls.email.value.trim();
  const password = accountEls.password.value;
  if (!username || !password) return;
  if (signInMode === 'register' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showSignInError('Enter a valid email address');
    return;
  }

  hideSignInError();
  accountEls.submit.disabled = true;
  const busyText = signInMode === 'register' ? 'Creating account…' : 'Signing in…';
  const restoreText = accountEls.submit.textContent;
  accountEls.submit.textContent = busyText;

  try {
    const result = signInMode === 'register'
      ? await api.register(username, email, password)
      : await api.login(username, password);

    setSession(result.username, result.token);
    updateAccountUI();
    closeSignInModal();
    showToast(signInMode === 'register' ? `Account created — welcome, ${result.username}` : `Signed in as ${result.username}`);
  } catch (err) {
    showSignInError(err.message || 'Something went wrong — try again');
  } finally {
    accountEls.submit.textContent = restoreText;
    updateSignInSubmitState();
  }
});

export function applyAppearance(settings) {
  const root = document.documentElement;

  const resolvedTheme = settings.theme === 'system'
    ? (mediaQuery.matches ? 'dark' : 'light')
    : settings.theme;

  root.setAttribute('data-theme', resolvedTheme);
  root.setAttribute('data-font-size', settings.fontSize);
}

function setSegmentedValue(group, value) {
  group.querySelectorAll('button').forEach((btn) => {
    btn.classList.toggle('is-selected', btn.dataset.value === value);
    btn.setAttribute('aria-selected', btn.dataset.value === value ? 'true' : 'false');
  });
}

function wireSegmented(group, onChange) {
  group.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      setSegmentedValue(group, btn.dataset.value);
      onChange(btn.dataset.value);
    });
  });
}

async function persist(partial) {
  currentSettings = { ...currentSettings, ...partial };
  await api.saveSettings(partial);
  if ('theme' in partial || 'fontSize' in partial) {
    applyAppearance(currentSettings);
  }
}

// Checks the remembered session with the account service in the background. Only a definite "not signed in" (401)
// signs the user out; being offline or the service being down leaves them signed in.
async function validateSession() {
  const session = getSession();
  if (!session) return;
  try {
    await api.me(session.token);
  } catch (err) {
    if (err.status === 401) clearSession();
  }
}

// signing in or out (here, or sync.js noticing an expired session) refreshes the Account card
window.addEventListener('binder:session', updateAccountUI);

// the line under the account name: how the last sync went
function timeAgo(ms) {
  const secs = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (secs < 45) return 'just now';
  if (secs < 3600) return `${Math.round(secs / 60)} min ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)} h ago`;
  return `${Math.round(secs / 86400)} d ago`;
}
function renderSyncStatus(status) {
  if (status.state === 'syncing') accountEls.sync.textContent = 'Syncing…';
  else if (status.state === 'error') accountEls.sync.textContent = `Couldn't sync — ${status.error || 'will retry'}`;
  else if (status.at) accountEls.sync.textContent = `Synced ${timeAgo(status.at)}`;
  else accountEls.sync.textContent = 'Not synced yet';
  accountEls.syncNow.disabled = status.state === 'syncing';
}
accountEls.syncNow.addEventListener('click', () => syncNow());
onSyncStatus(renderSyncStatus);
setInterval(() => { if (getSession()) renderSyncStatus(lastSyncStatus); }, 30000);
let lastSyncStatus = { state: 'idle', at: 0, error: '' };
onSyncStatus((status) => { lastSyncStatus = status; });

export async function initSettings() {
  updateAccountUI();
  validateSession();

  currentSettings = await api.getSettings();
  applyAppearance(currentSettings);

  const groups = document.querySelectorAll('.segmented[data-setting]');
  groups.forEach((group) => {
    const key = group.dataset.setting;
    setSegmentedValue(group, currentSettings[key]);
    wireSegmented(group, (value) => persist({ [key]: value }));
  });

  // keep appearance in sync if the OS theme changes while "system" is selected
  mediaQuery.addEventListener('change', () => {
    if (currentSettings.theme === 'system') applyAppearance(currentSettings);
  });
}

export function getSettings() {
  return currentSettings;
}