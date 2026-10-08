/**
 * settings.js
 * Handles the Account tab: sign-in / account creation (backed by the Cloudflare
 * account service in /cloudflare, via api.js),
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
// The account service hands back a session token on sign-in / account creation. The username and token are
// remembered locally so they survive a reload; on startup the token is checked with the service, and a session
// that has expired (or was signed out elsewhere) quietly returns the app to guest mode.
const SIGNED_IN_KEY = 'binder_signed_in_user';
const TOKEN_KEY = 'binder_session_token';
let signedInUsername = localStorage.getItem(SIGNED_IN_KEY);
let sessionToken = localStorage.getItem(TOKEN_KEY);
if (!sessionToken) signedInUsername = null; // signed in under the old, tokenless flow: ask again
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

function clearSession() {
  signedInUsername = null;
  sessionToken = null;
  localStorage.removeItem(SIGNED_IN_KEY);
  localStorage.removeItem(TOKEN_KEY);
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
  if (signedInUsername) {
    const token = sessionToken;
    clearSession();
    api.logout(token).catch(() => { /* already signed out locally; the session expires on its own */ });
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

    signedInUsername = result.username;
    sessionToken = result.token;
    localStorage.setItem(SIGNED_IN_KEY, signedInUsername);
    localStorage.setItem(TOKEN_KEY, sessionToken);
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

// Checks the remembered session with the account service in the background. Only a definite "not signed in" (401)
// signs the user out; being offline or the service being down leaves them signed in.
async function validateSession() {
  if (!sessionToken) return;
  try {
    await api.me(sessionToken);
  } catch (err) {
    if (err.status === 401) {
      clearSession();
      updateAccountUI();
    }
  }
}

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