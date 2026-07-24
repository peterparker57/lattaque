// Online multiplayer client: lobby (create/join) + WebSocket + wiring to the
// existing game UI. Requires a logged-in user (window.auth). The server is
// authoritative; this module only sends intent (setup, moves) and renders the
// filtered board views it receives.
import { Board, Piece, RANK, RED, BLUE, ROWS, COLS } from './game-core.js';

const $ = (id) => document.getElementById(id);

const net = { ws: null, code: null, myColor: null, wantOpen: false, phase: null, lastCombatKey: null, version: null, lastRecv: 0, pendingSince: 0 };

// Reconstruct a Board from the server's filtered view. Hidden enemy pieces
// (rank === null) become RANK.UNKNOWN so the existing UI renders them as '?'.
function boardFromView(view) {
  const b = new Board();
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const cell = view.grid[r][c];
      if (!cell) continue;
      const rank = cell.rank !== null ? cell.rank : RANK.UNKNOWN;
      const p = new Piece(cell.color, rank, cell.id);
      p.known = !!cell.known;
      p.moved = !!cell.moved;
      b.setPiece(r, c, p);
    }
  }
  const cap = (arr) => (arr || []).map((x) => { const p = new Piece(x.color, x.rank, -1); p.known = true; return p; });
  b.capturedRed = cap(view.capturedRed);
  b.capturedBlue = cap(view.capturedBlue);
  b.lastMove = view.lastMove || null;
  return b;
}

function setStatus(msg, isError) {
  const el = $('online-status');
  el.textContent = msg || '';
  el.classList.toggle('online-error', !!isError);
}

function requireLogin() {
  if (window.auth && window.auth.user) return true;
  setStatus('Please log in first.', true);
  if (window.auth) window.auth.open('login');
  return false;
}

async function createMatch() {
  if (!requireLogin()) return;
  setStatus('Creating game…');
  const res = await fetch('/api/match/create', { method: 'POST', credentials: 'same-origin' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return setStatus(data.error || 'Could not create game.', true);
  leaveMatch(); // drop any previous game's connection before joining the new room
  net.code = data.code;
  net.myColor = data.color; // 0 = RED (creator moves first)
  $('online-code-box').classList.remove('hidden');
  $('online-code-value').textContent = data.code;
  connect();
}

async function joinMatch() {
  if (!requireLogin()) return;
  const code = ($('online-join-code').value || '').trim().toUpperCase();
  if (!code) return setStatus('Enter a game code.', true);
  setStatus('Joining…');
  const res = await fetch(`/api/match/${code}/join`, { method: 'POST', credentials: 'same-origin' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return setStatus(data.error || 'Could not join game.', true);
  leaveMatch(); // drop any previous game's connection before joining the new room
  net.code = code;
  net.myColor = data.color; // 1 = BLUE
  connect();
}

const MATCH_KEY = 'lattaque-match';
let reconnectTimer = null;
let heartbeat = null;

function saveMatch() { try { sessionStorage.setItem(MATCH_KEY, net.code || ''); } catch { /* private mode */ } }
function clearMatch() { try { sessionStorage.removeItem(MATCH_KEY); } catch { /* ignore */ } }

// Fully drop the current match connection — used when starting a new game or
// walking away from a finished one. Without this, the old match's heartbeat
// keeps echoing states that fight the new lobby/game UI.
function leaveMatch() {
  net.wantOpen = false;
  stopHeartbeat();
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (net.ws) { try { net.ws.close(); } catch { /* ignore */ } }
  net.ws = null;
  net.code = null; net.myColor = null; net.phase = null; net.version = null;
  net.lastCombatKey = null; net.pendingSince = 0;
  clearMatch();
}

function scheduleReconnect(delay = 1200) {
  if (reconnectTimer || !net.wantOpen) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
}

// Pull the latest state now — over the live socket if we have one, else reconnect
// (the server resends full state on connect).
function requestSync() {
  if (net.ws && net.ws.readyState === 1) {
    try { net.ws.send(JSON.stringify({ type: 'sync' })); } catch { /* dead socket */ }
  } else {
    scheduleReconnect(200);
  }
}

// Mobile browsers (esp. iOS Safari) suspend WebSockets when backgrounded and can
// silently drop messages. Periodically resync so a missed broadcast is recovered
// within a few seconds, and reconnect if the socket has gone quiet (half-open).
function startHeartbeat() {
  stopHeartbeat();
  net.lastRecv = Date.now();
  heartbeat = setInterval(() => {
    if (!net.wantOpen) return;
    const ws = net.ws;
    if (ws && ws.readyState === 1) {
      try { ws.send(JSON.stringify({ type: 'sync' })); } catch { /* dead */ }
      // No traffic for a while on an "open" socket = zombie (common after iOS
      // suspend). Close it; the close handler reconnects and state is resent.
      if (Date.now() - (net.lastRecv || 0) > 12000) { try { ws.close(); } catch { /* ignore */ } }
    } else if (!ws || ws.readyState === 3) {
      scheduleReconnect(500);
    }
  }, 5000);
}
function stopHeartbeat() { if (heartbeat) { clearInterval(heartbeat); heartbeat = null; } }

function connect() {
  if (!net.code) return;
  net.wantOpen = true;
  saveMatch();
  if (net.ws && (net.ws.readyState === 0 || net.ws.readyState === 1)) return; // already connecting/open
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/api/match/${net.code}/ws`);
  net.ws = ws;
  ws.addEventListener('open', () => { net.lastRecv = Date.now(); startHeartbeat(); });
  ws.addEventListener('message', (ev) => { net.lastRecv = Date.now(); handleMessage(JSON.parse(ev.data)); });
  ws.addEventListener('close', () => {
    if (!net.wantOpen) return;
    setStatus('Connection lost — reconnecting…', true);
    scheduleReconnect();
  });
  ws.addEventListener('error', () => {});
}

function handleMessage(msg) {
  if (msg.type === 'error') {
    // The match no longer knows us (expired/invalid) — stop trying to rejoin it.
    if (/not a player/i.test(msg.error)) {
      net.wantOpen = false; clearMatch(); net.code = null;
      setStatus(msg.error, true);
      return;
    }
    // In-game errors (e.g. a rejected move) must show on the GAME screen — the
    // lobby modal is closed — and usually mean we're stale: pull fresh state.
    if (net.phase === 'playing' && window.ui) {
      window.ui.setStatus(msg.error + ' — syncing…');
      requestSync();
    } else {
      setStatus(msg.error, true);
    }
    return;
  }
  if (msg.type === 'setup_ok') { window.ui && window.ui.setStatus('Army sent. Waiting for your opponent…'); return; }
  if (msg.type !== 'state') return;

  // Version discipline: drop strictly-older snapshots; an EQUAL version (heartbeat
  // echo) refreshes only the status line — never the board, so an in-progress
  // piece selection survives; a NEWER version applies fully.
  const v = msg.version;
  if (v != null && net.version != null && v < net.version) return;
  const isNew = v == null || net.version == null || v > net.version;
  if (v != null) net.version = v;
  if (isNew) net.pendingSince = 0; // our sent move (if any) is confirmed

  const g = window.game;
  if (msg.you) net.myColor = msg.you.color; // authoritative — handles rematch color swap
  const red = msg.players.red ? msg.players.red.username : '—';
  const blue = msg.players.blue ? msg.players.blue.username : 'waiting…';
  setStatus(`Red: ${red}    Blue: ${blue}`);

  if (msg.status === 'setup') {
    // Enter (or, for a rematch, re-enter) local army-arranging once both are present.
    if (msg.players.red && msg.players.blue && net.phase !== 'setup') {
      net.phase = 'setup';
      net.lastCombatKey = null;
      setTimeout(closeModal, 400);
      g.initOnlineSetup(net.myColor);
    }
    return;
  }

  if (msg.status === 'playing' || msg.status === 'gameover') {
    if (!isNew) {
      // Same snapshot we already rendered (heartbeat echo) — refresh only the
      // status line (opponent connected flags can change without a version bump).
      if (msg.status === 'playing' && net.phase === 'playing') updateTurnStatus(msg);
      return;
    }
    maybeAnimateCombat(msg.lastCombat);
    const board = boardFromView(msg.board);
    g.setOnlineBoard(board, msg.status === 'gameover' ? 'gameover' : 'playing', msg.turn, net.myColor);
    if (msg.status === 'playing') {
      // Close the lobby only when ENTERING play — routine updates must never
      // slam a lobby the player deliberately opened.
      if (net.phase !== 'playing') closeModal();
      net.phase = 'playing';
      updateTurnStatus(msg);
    } else if (net.phase !== 'gameover') {
      net.phase = 'gameover';
      closeModal();
      clearMatch(); // a refresh after a finished game lands in the lobby, not a stale banner
      g.showOnlineGameOver(msg.winner === net.myColor, msg.result);
      if (window.auth) window.auth.restore(); // refresh the rating shown in the toolbar
    }
  }
}

function updateTurnStatus(msg) {
  const opp = msg.players[net.myColor === RED ? 'blue' : 'red'];
  if (!opp || !opp.connected) {
    window.ui.setStatus('Opponent disconnected — waiting for them to reconnect…');
  } else {
    const mine = msg.turn === net.myColor;
    window.ui.setStatus(mine ? 'Your turn — select a piece to move.' : "Opponent's turn…");
  }
}

// Animate a combat that just happened (board is already post-combat). Keyed so a
// resent/reconnect state doesn't replay the same fight.
function maybeAnimateCombat(lc) {
  if (!lc) return;
  const key = `${lc.from.r},${lc.from.c}-${lc.to.r},${lc.to.c}-${lc.attacker.rank}-${lc.defender.rank}-${lc.result}`;
  if (key === net.lastCombatKey) return;
  net.lastCombatKey = key;
  const record = {
    attacker: { rank: lc.attacker.rank, color: lc.attacker.color },
    defender: { rank: lc.defender.rank, color: lc.defender.color },
    result: lc.result, fromR: lc.from.r, fromC: lc.from.c, toR: lc.to.r, toC: lc.to.c,
  };
  try { window.ui.playCombatAnimation(record); } catch { /* animation is best-effort */ }
}

function requestRematch() {
  if (net.ws && net.ws.readyState === 1) net.ws.send(JSON.stringify({ type: 'rematch' }));
  window.ui.setStatus('Rematch requested — waiting for your opponent…');
}

// Called by stratego.js when the player clicks Start Game in online mode.
function submitSetup() {
  const g = window.game;
  const pieces = [];
  for (const r of g.playerRows) {
    for (let c = 0; c < COLS; c++) {
      const p = g.board.getPiece(r, c);
      if (p && p.color === g.playerColor) pieces.push({ rank: p.rank, r, c });
    }
  }
  if (pieces.length !== 40) { window.ui.setStatus('Place all 40 pieces first.'); return; }
  net.ws.send(JSON.stringify({ type: 'setup', pieces }));
  window.ui.setStatus('Army sent. Waiting for your opponent…');
}

// Called by stratego.js handleCellClick during online play.
function handleMoveClick(r, c) {
  const g = window.game;
  if (g.status !== 'playing') return;
  if (g.turn !== g.playerColor) { window.ui.setStatus('Not your turn yet…'); return; }
  const piece = g.board.getPiece(r, c);
  if (g.selectedCell) {
    const move = g.validMoves.find((m) => m.toR === r && m.toC === c);
    if (move) {
      if (!net.ws || net.ws.readyState !== 1) {
        window.ui.setStatus('Reconnecting — try that move again in a second…');
        scheduleReconnect(200);
        return;
      }
      net.ws.send(JSON.stringify({ type: 'move', fromR: g.selectedCell.r, fromC: g.selectedCell.c, toR: r, toC: c }));
      // Watchdog: if the confirming state doesn't come back, chase it, then
      // force a reconnect. Prevents the silent "nobody can move" freeze.
      net.pendingSince = Date.now();
      setTimeout(() => { if (net.pendingSince) requestSync(); }, 1500);
      setTimeout(() => {
        if (net.pendingSince && net.ws) { try { net.ws.close(); } catch { /* ignore */ } }
      }, 5000);
      g.deselect();
      window.ui.setStatus('Move sent…');
      return;
    }
    if (piece && piece.color === g.playerColor && piece.isMovable()) { g.selectPiece(r, c); return; }
    g.deselect();
    return;
  }
  if (piece && piece.color === g.playerColor && piece.isMovable()) g.selectPiece(r, c);
}

function openModal() {
  // Opening the lobby after a finished game means "I'm done with that match" —
  // drop its connection so its heartbeat can't interfere with the new lobby.
  if (net.phase === 'gameover') {
    leaveMatch();
    document.getElementById('game-over-banner').classList.add('hidden');
  }
  $('online-modal').classList.remove('hidden');
  $('online-code-box').classList.add('hidden'); // stale code from a previous create
  const logged = !!(window.auth && window.auth.user);
  setStatus(logged ? '' : 'Log in to play online.', !logged);
}
function closeModal() { $('online-modal').classList.add('hidden'); }

function wire() {
  $('btn-play-online').addEventListener('click', openModal);
  $('btn-online-create').addEventListener('click', createMatch);
  $('btn-online-join').addEventListener('click', joinMatch);
  $('btn-online-close').addEventListener('click', closeModal);
  $('online-join-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinMatch(); });
  window.online = { submitSetup, handleMoveClick, requestRematch };

  // Wake handling: iOS freezes timers AND sockets while the tab sleeps, and a
  // suspended socket can look open while receiving nothing (zombie). On any wake
  // signal, sync — and if nothing arrives within 2.5s, force a reconnect.
  const wakeResync = () => {
    if (!net.wantOpen) return;
    const before = net.lastRecv;
    if (net.ws && net.ws.readyState === 1) {
      try { net.ws.send(JSON.stringify({ type: 'sync' })); } catch { /* ignore */ }
      setTimeout(() => {
        if (net.wantOpen && net.lastRecv === before) {
          try { net.ws.close(); } catch { /* ignore */ }
          scheduleReconnect(300);
        }
      }, 2500);
    } else {
      scheduleReconnect(200);
    }
  };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') wakeResync(); });
  window.addEventListener('pageshow', wakeResync); // bfcache restore (iOS back/forward)
  window.addEventListener('focus', wakeResync);
  window.addEventListener('online', wakeResync);

  // Rejoin an in-progress match after a refresh / accidental reload.
  let saved = null;
  try { saved = sessionStorage.getItem(MATCH_KEY); } catch { /* ignore */ }
  if (saved) { net.code = saved; net.phase = null; connect(); }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
else wire();
