/**
 * settings.js
 * Handles the Account tab: sign-in / account creation (backed by the C++
 * LoginServer via app.py's /api/auth/* bridge — see loginserver/README.md),
 * loading/saving preferences via api.js, applying appearance changes
 * live (theme + font size), and wiring up the scanner preference controls.
 */
import { api } from './api.js';
import { showToast } from './ui.js';

let currentSettings = null;
const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');

// -----------------------------------------------------------------
// sign in / create account
// -----------------------------------------------------------------
// LoginServer's LOGIN command only ever answers "does this
// username/password pair match?" — it doesn't hand back a session
// token. So "being signed in" here just means "the last username we
// successfully authenticated as", remembered locally so it survives a
// page reload. There's no server-side session to invalidate on sign
// out, which is fine for this single-device flow.
const SIGNED_IN_KEY = 'binder_signed_in_user';
let signedInUsername = localStorage.getItem(SIGNED_IN_KEY);
let signInMode = 'login'; // 'login' | 'register'

const accountEls = {
  card: document.getElementById('account-card'),
  name: document.getElementById('account-name'),
  hint: document.getElementById('account-hint'),
  signinBtn: document.getElementById('account-signin-btn'),
  modal: document.getElementById('modal-signin'),
  title: document.getElementById('signin-title'),
  username: document.getElementById('signin-email'), // field id kept from markup; holds a username, not an email
  password: document.getElementById('signin-password'),
  error: document.getElementById('signin-error'),
  cancel: document.getElementById('signin-cancel'),
  submit: document.getElementById('signin-submit'),
  modeToggle: document.getElementById('signin-mode-toggle'),
};

function updateAccountUI() {
  const isSignedIn = !!signedInUsername;
  accountEls.card.classList.toggle('is-signed-in', isSignedIn);
  accountEls.name.textContent = isSignedIn ? signedInUsername : "You're browsing as a guest";
  accountEls.hint.textContent = isSignedIn
    ? 'Signed in on this device'
    : 'Sign in to sync your collections across devices';
  accountEls.signinBtn.textContent = isSignedIn ? 'Sign out' : 'Sign in';
}

function setSignInMode(mode) {
  signInMode = mode;
  const isRegister = mode === 'register';
  accountEls.title.textContent = isRegister ? 'Create account' : 'Sign in';
  accountEls.submit.textContent = isRegister ? 'Create account' : 'Sign in';
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
  accountEls.submit.disabled = !(accountEls.username.value.trim() && accountEls.password.value);
}

accountEls.signinBtn.addEventListener('click', () => {
  if (signedInUsername) {
    signedInUsername = null;
    localStorage.removeItem(SIGNED_IN_KEY);
    updateAccountUI();
    showToast('Signed out');
  } else {
    openSignInModal();
  }
});
accountEls.username.addEventListener('input', updateSignInSubmitState);
accountEls.password.addEventListener('input', updateSignInSubmitState);
accountEls.cancel.addEventListener('click', closeSignInModal);
accountEls.modal.addEventListener('click', (e) => { if (e.target === accountEls.modal) closeSignInModal(); });
accountEls.modeToggle.addEventListener('click', () => {
  setSignInMode(signInMode === 'login' ? 'register' : 'login');
});

accountEls.submit.addEventListener('click', async () => {
  const username = accountEls.username.value.trim();
  const password = accountEls.password.value;
  if (!username || !password) return;

  hideSignInError();
  accountEls.submit.disabled = true;
  const busyText = signInMode === 'register' ? 'Creating account…' : 'Signing in…';
  const restoreText = accountEls.submit.textContent;
  accountEls.submit.textContent = busyText;

  try {
    const result = signInMode === 'register'
      ? await api.register(username, password)
      : await api.login(username, password);

    signedInUsername = result.username;
    localStorage.setItem(SIGNED_IN_KEY, signedInUsername);
    updateAccountUI();
    closeSignInModal();
    showToast(signInMode === 'register' ? `Account created — welcome, ${signedInUsername}` : `Signed in as ${signedInUsername}`);
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

export async function initSettings() {
  updateAccountUI();

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