// Online multiplayer client: lobby (create/join) + WebSocket + wiring to the
// existing game UI. Requires a logged-in user (window.auth). The server is
// authoritative; this module only sends intent (setup, moves) and renders the
// filtered board views it receives.
import { Board, Piece, RANK, RED, BLUE, ROWS, COLS } from './game-core.js';

const $ = (id) => document.getElementById(id);

const net = { ws: null, code: null, myColor: null, wantOpen: false, phase: null, lastCombatKey: null };

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
  net.code = data.code;
  net.myColor = data.color; // 0 = RED (creator moves first)
  net.phase = null;
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
  net.code = code;
  net.myColor = data.color; // 1 = BLUE
  net.phase = null;
  connect();
}

function connect() {
  net.wantOpen = true;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/api/match/${net.code}/ws`);
  net.ws = ws;
  ws.addEventListener('open', () => setStatus('Connected. Waiting for the game…'));
  ws.addEventListener('message', (ev) => handleMessage(JSON.parse(ev.data)));
  ws.addEventListener('close', () => {
    if (!net.wantOpen) return;
    setStatus('Connection lost — reconnecting…', true);
    setTimeout(connect, 1500);
  });
  ws.addEventListener('error', () => {});
}

function handleMessage(msg) {
  if (msg.type === 'error') { setStatus(msg.error, true); return; }
  if (msg.type === 'setup_ok') { window.ui && window.ui.setStatus('Army sent. Waiting for your opponent…'); return; }
  if (msg.type !== 'state') return;

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
    closeModal();
    maybeAnimateCombat(msg.lastCombat);
    const board = boardFromView(msg.board);
    g.setOnlineBoard(board, msg.status === 'gameover' ? 'gameover' : 'playing', msg.turn);
    if (msg.status === 'playing') {
      net.phase = 'playing';
      const oppColor = net.myColor === RED ? 'blue' : 'red';
      const oppConnected = msg.players[oppColor] && msg.players[oppColor].connected;
      if (!oppConnected) {
        window.ui.setStatus('Opponent disconnected — waiting for them to reconnect…');
      } else {
        const mine = msg.turn === net.myColor;
        window.ui.setStatus(mine ? 'Your turn — select a piece to move.' : "Opponent's turn…");
      }
    } else if (net.phase !== 'gameover') {
      net.phase = 'gameover';
      g.showOnlineGameOver(msg.winner === net.myColor, msg.result);
      if (window.auth) window.auth.restore(); // refresh the rating shown in the toolbar
    }
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
      net.ws.send(JSON.stringify({ type: 'move', fromR: g.selectedCell.r, fromC: g.selectedCell.c, toR: r, toC: c }));
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
  $('online-modal').classList.remove('hidden');
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
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
else wire();
