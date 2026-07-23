// Auth UI — session bar + login/signup modal. Talks to /api/auth/*.
// Loaded as its own ES module; independent of the game (stratego.js).

const $ = (id) => document.getElementById(id);

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  return { ok: res.ok, status: res.status, data };
}

let currentUser = null;
let modalMode = 'login'; // 'login' | 'signup'

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderBar() {
  const bar = $('auth-bar');
  if (!bar) return;
  if (currentUser) {
    bar.innerHTML =
      `<span class="auth-user" title="Rating">▸ ${escapeHtml(currentUser.username)}` +
      ` <span class="auth-rating">${currentUser.rating}</span></span>` +
      `<button id="btn-logout" class="auth-btn">Log out</button>`;
    $('btn-logout').addEventListener('click', doLogout);
  } else {
    bar.innerHTML =
      `<button id="btn-login" class="auth-btn">Log in</button>` +
      `<button id="btn-signup" class="auth-btn auth-btn-primary">Sign up</button>`;
    $('btn-login').addEventListener('click', () => openModal('login'));
    $('btn-signup').addEventListener('click', () => openModal('signup'));
  }
}

function openModal(mode) {
  modalMode = mode;
  $('auth-title').textContent = mode === 'signup' ? 'Create Account' : 'Log In';
  $('btn-auth-submit').textContent = mode === 'signup' ? 'Sign Up' : 'Log In';
  $('auth-toggle').innerHTML = mode === 'signup'
    ? `Already have an account? <a href="#" id="auth-switch">Log in</a>`
    : `New here? <a href="#" id="auth-switch">Create an account</a>`;
  $('auth-switch').addEventListener('click', (e) => {
    e.preventDefault();
    openModal(mode === 'signup' ? 'login' : 'signup');
  });
  $('auth-username').value = '';
  $('auth-password').value = '';
  $('auth-password').setAttribute('autocomplete', mode === 'signup' ? 'new-password' : 'current-password');
  hideError();
  $('auth-modal').classList.remove('hidden');
  $('auth-username').focus();
}
function closeModal() { $('auth-modal').classList.add('hidden'); }

function showError(msg) { const e = $('auth-error'); e.textContent = msg; e.classList.remove('hidden'); }
function hideError() { $('auth-error').classList.add('hidden'); }

async function doSubmit() {
  const username = $('auth-username').value.trim();
  const password = $('auth-password').value;
  if (!username || !password) { showError('Enter a username and password.'); return; }
  const btn = $('btn-auth-submit');
  btn.disabled = true;
  const path = modalMode === 'signup' ? '/api/auth/signup' : '/api/auth/login';
  const { ok, data } = await api(path, { method: 'POST', body: { username, password } });
  btn.disabled = false;
  if (!ok) { showError((data && data.error) || 'Something went wrong.'); return; }
  currentUser = data.user;
  closeModal();
  renderBar();
  window.dispatchEvent(new CustomEvent('auth:changed', { detail: currentUser }));
}

async function doLogout() {
  await api('/api/auth/logout', { method: 'POST' });
  currentUser = null;
  renderBar();
  window.dispatchEvent(new CustomEvent('auth:changed', { detail: null }));
}

async function restore() {
  const { ok, data } = await api('/api/auth/me');
  currentUser = ok && data ? data.user : null;
  renderBar();
}

function wire() {
  $('btn-auth-submit').addEventListener('click', doSubmit);
  $('btn-auth-cancel').addEventListener('click', closeModal);
  $('auth-username').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('auth-password').focus(); });
  $('auth-password').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSubmit(); });
  // Expose a tiny API for the game / debugging (Phase 4 will read the logged-in user).
  window.auth = { get user() { return currentUser; }, restore, logout: doLogout, open: openModal };
  restore();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
else wire();
