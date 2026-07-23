// Leaderboard + profile popups (competitive stats layer).
const $ = (id) => document.getElementById(id);
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function loadLeaderboard() {
  const body = $('leaderboard-body');
  body.innerHTML = '<div class="lb-loading">Loading…</div>';
  try {
    const data = await (await fetch('/api/leaderboard')).json();
    const me = window.auth && window.auth.user ? window.auth.user.username.toLowerCase() : null;
    if (!data.players || !data.players.length) {
      body.innerHTML = '<div class="lb-loading">No games played yet — be the first!</div>';
      return;
    }
    body.innerHTML = data.players.map((p, i) => {
      const isMe = me && p.username.toLowerCase() === me;
      return `<div class="lb-row${isMe ? ' lb-me' : ''}">
        <span class="lb-rank">${i + 1}</span>
        <span class="lb-name">${escapeHtml(p.username)}</span>
        <span class="lb-rating">${p.rating}</span>
        <span class="lb-wl">${p.wins}W&nbsp;${p.losses}L</span>
      </div>`;
    }).join('');
  } catch {
    body.innerHTML = '<div class="lb-loading">Could not load the leaderboard.</div>';
  }
}

function openLeaderboard() { $('leaderboard-modal').classList.remove('hidden'); loadLeaderboard(); }
function closeLeaderboard() { $('leaderboard-modal').classList.add('hidden'); }

function openProfile() {
  const u = window.auth && window.auth.user;
  if (!u) { if (window.auth) window.auth.open('login'); return; }
  const games = u.wins + u.losses + (u.draws || 0);
  const pct = games ? Math.round((u.wins / games) * 100) : 0;
  $('profile-name').textContent = u.username;
  $('profile-body').innerHTML =
    `<div class="profile-stat"><span>Rating</span><b>${u.rating}</b></div>` +
    `<div class="profile-stat"><span>Wins</span><b>${u.wins}</b></div>` +
    `<div class="profile-stat"><span>Losses</span><b>${u.losses}</b></div>` +
    `<div class="profile-stat"><span>Games</span><b>${games}</b></div>` +
    `<div class="profile-stat"><span>Win rate</span><b>${pct}%</b></div>`;
  $('profile-modal').classList.remove('hidden');
}
function closeProfile() { $('profile-modal').classList.add('hidden'); }

function wire() {
  $('btn-leaderboard').addEventListener('click', openLeaderboard);
  $('btn-leaderboard-close').addEventListener('click', closeLeaderboard);
  $('btn-profile-close').addEventListener('click', closeProfile);
  $('btn-profile-leaderboard').addEventListener('click', () => { closeProfile(); openLeaderboard(); });
  // Clicking your name in the toolbar (delegated — the auth bar re-renders) opens your profile.
  $('auth-bar').addEventListener('click', (e) => { if (e.target.closest('.auth-user')) openProfile(); });
  window.stats = { openLeaderboard, openProfile };
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
else wire();
