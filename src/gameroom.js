// GameRoom — authoritative Durable Object for ONE online Stratego match.
// Holds the true board and coordinates two players over hibernatable WebSockets.
// The server is the referee: a player is never sent an enemy piece's hidden rank.
//
// Identity: the Worker authenticates the user (session cookie -> D1) and passes
// userId/username to this DO via headers (WS) or the JSON body (HTTP commands);
// the DO does not re-auth.
//
// Phase 4c: matchmaking + match state (create/join, players, persisted state,
// connect + reconnect + broadcast). Setup (P4d) and moves (P4e) extend this.

import { DurableObject } from 'cloudflare:workers';
import {
  Piece, Board, PIECE_COUNTS,
  buildPlayerView, serializeBoard, deserializeBoard,
} from '../public/game-core.js';

const RED = 0;
const BLUE = 1;

// Each side sets up on its own back rows (rows 4-5 are the middle/lakes).
const ZONE = { [RED]: [0, 3], [BLUE]: [6, 9] };

// Validate a submitted army: exactly the right pieces, all inside the player's
// own zone, one per square. Returns an error string, or null if valid.
function validateSetup(pieces, color) {
  if (!Array.isArray(pieces)) return 'setup must be a list';
  if (pieces.length !== 40) return `expected 40 pieces, got ${pieces.length}`;
  const [minR, maxR] = ZONE[color];
  const counts = {};
  const seen = new Set();
  for (const p of pieces) {
    if (!Number.isInteger(p.rank) || !(p.rank in PIECE_COUNTS)) return 'invalid piece rank';
    if (!Number.isInteger(p.r) || !Number.isInteger(p.c)) return 'invalid position';
    if (p.r < minR || p.r > maxR || p.c < 0 || p.c > 9) return 'piece outside your zone';
    const key = p.r * 10 + p.c;
    if (seen.has(key)) return 'two pieces on the same square';
    seen.add(key);
    counts[p.rank] = (counts[p.rank] || 0) + 1;
  }
  for (const [rank, n] of Object.entries(PIECE_COUNTS)) {
    if ((counts[rank] || 0) !== n) return 'wrong piece counts';
  }
  return null;
}

// Standard Elo update for a decisive result (K=32). Returns [newWinner, newLoser].
function elo(Rw, Rl, K = 32) {
  const eW = 1 / (1 + 10 ** ((Rl - Rw) / 400));
  const eL = 1 / (1 + 10 ** ((Rw - Rl) / 400));
  return [Math.round(Rw + K * (1 - eW)), Math.round(Rl + K * (0 - eL))];
}

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

export class GameRoom extends DurableObject {
  // ---- persisted match state (survives hibernation) ----
  async loadState() {
    if (this._state !== undefined) return this._state;
    this._state = (await this.ctx.storage.get('state')) || null;
    return this._state;
  }
  async saveState(state) {
    this._state = state;
    await this.ctx.storage.put('state', state);
  }

  colorOfUser(state, userId) {
    if (!state) return null;
    if (state.players[RED] && state.players[RED].userId === userId) return RED;
    if (state.players[BLUE] && state.players[BLUE].userId === userId) return BLUE;
    return null;
  }

  // Which colors currently have a live WebSocket (derived, not persisted).
  connectedColors(state) {
    const set = new Set();
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() || {};
      const c = this.colorOfUser(state, att.userId);
      if (c !== null) set.add(c);
    }
    return set;
  }

  // The message a given player is allowed to see.
  stateMessage(state, forColor) {
    const live = this.connectedColors(state);
    const p = (c) =>
      state.players[c]
        ? { username: state.players[c].username, ready: !!state.players[c].ready, connected: live.has(c) }
        : null;
    return {
      type: 'state',
      status: state.status,
      code: state.code,
      you: forColor === null ? null : { color: forColor, username: state.players[forColor]?.username },
      players: { red: p(RED), blue: p(BLUE) },
      turn: state.turn,
      winner: state.winner,
      result: forColor !== null && state.results ? state.results[forColor] || null : null,
      lastCombat: state.lastCombat || null,
      // At gameover, reveal the whole board so both players see the opponent's army.
      board: state.board
        ? buildPlayerView(deserializeBoard(state.board), forColor, state.status === 'gameover')
        : null,
    };
  }

  async broadcastState() {
    const state = await this.loadState();
    if (!state) return;
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() || {};
      const color = this.colorOfUser(state, att.userId);
      try { ws.send(JSON.stringify(this.stateMessage(state, color))); } catch { /* closing */ }
    }
  }

  // ---- routing ----
  async fetch(request) {
    if (request.headers.get('Upgrade') === 'websocket') {
      const userId = Number(request.headers.get('X-User-Id'));
      const username = request.headers.get('X-User-Name') || 'player';
      return this.handleWsConnect(userId, username);
    }
    const url = new URL(request.url);
    const body = await request.json().catch(() => ({}));
    if (url.pathname.endsWith('/create')) return this.handleCreate(body);
    if (url.pathname.endsWith('/join')) return this.handleJoin(body);
    return new Response('not found', { status: 404 });
  }

  async handleCreate({ userId, username }) {
    if (!userId) return json({ error: 'auth required' }, 401);
    const existing = await this.loadState();
    if (existing) return json({ error: 'code in use' }, 409); // Worker retries with a new code
    const state = {
      code: null, // set by the Worker's idFromName; carried for display via join/ws below
      status: 'waiting',
      players: { [RED]: { userId, username, ready: false }, [BLUE]: null },
      board: null,
      turn: RED,
      winner: null,
      createdAt: Date.now(),
    };
    await this.saveState(state);
    return json({ ok: true, color: RED }, 200);
  }

  async handleJoin({ userId, username, code }) {
    if (!userId) return json({ error: 'auth required' }, 401);
    const state = await this.loadState();
    if (!state) return json({ error: 'no such match' }, 404);
    if (code && !state.code) state.code = code; // stamp display code on first join

    // Rejoin if already a player.
    const existing = this.colorOfUser(state, userId);
    if (existing !== null) {
      await this.saveState(state);
      return json({ ok: true, color: existing, rejoin: true });
    }
    if (state.players[BLUE]) return json({ error: 'match is full' }, 409);

    state.players[BLUE] = { userId, username, ready: false };
    if (state.status === 'waiting') state.status = 'setup';
    await this.saveState(state);
    await this.broadcastState();
    return json({ ok: true, color: BLUE }, 200);
  }

  async handleWsConnect(userId, username) {
    const state = await this.loadState();
    const color = this.colorOfUser(state, userId);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ userId, username });

    if (!state || color === null) {
      // Not a player in this match (spectators not supported yet).
      try { server.send(JSON.stringify({ type: 'error', error: 'not a player in this match' })); } catch {}
      try { server.close(1008, 'not a player'); } catch {}
      return new Response(null, { status: 101, webSocket: client });
    }

    server.send(JSON.stringify(this.stateMessage(state, color)));
    // Let the opponent know someone (re)connected.
    await this.broadcastState();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    let msg;
    try { msg = JSON.parse(message); } catch { return; }
    const state = await this.loadState();
    const att = ws.deserializeAttachment() || {};
    const color = this.colorOfUser(state, att.userId);
    if (color === null) return;

    // Client can request a fresh state snapshot (e.g. after reconnect).
    if (msg.type === 'sync') {
      ws.send(JSON.stringify(this.stateMessage(state, color)));
      return;
    }

    // Submit your army during setup.
    if (msg.type === 'setup') {
      if (state.status !== 'setup') return this.err(ws, 'not in setup phase');
      if (state.players[color].ready) return this.err(ws, 'you already submitted your setup');
      const invalid = validateSetup(msg.pieces, color);
      if (invalid) return this.err(ws, invalid);

      state.setups = state.setups || { [RED]: null, [BLUE]: null };
      state.setups[color] = msg.pieces.map((p) => ({ rank: p.rank, r: p.r, c: p.c }));
      state.players[color].ready = true;

      // Both armies in -> build the authoritative board and start play (RED first).
      if (state.players[RED].ready && state.players[BLUE].ready) {
        const board = new Board();
        let id = 0;
        for (const s of state.setups[RED]) board.setPiece(s.r, s.c, new Piece(RED, s.rank, id++));
        id = 40;
        for (const s of state.setups[BLUE]) board.setPiece(s.r, s.c, new Piece(BLUE, s.rank, id++));
        state.board = serializeBoard(board);
        state.status = 'playing';
        state.turn = RED;
        delete state.setups;
      }

      await this.saveState(state);
      ws.send(JSON.stringify({ type: 'setup_ok' }));
      await this.broadcastState();
      return;
    }

    // Rematch: when both players agree, reset the room and swap colors.
    if (msg.type === 'rematch') {
      if (state.status !== 'gameover') return this.err(ws, 'no finished game to rematch');
      state.rematch = state.rematch || {};
      state.rematch[color] = true;
      if (state.rematch[RED] && state.rematch[BLUE]) {
        const oldRed = state.players[RED], oldBlue = state.players[BLUE];
        state.players = {
          [RED]: { userId: oldBlue.userId, username: oldBlue.username, ready: false },
          [BLUE]: { userId: oldRed.userId, username: oldRed.username, ready: false },
        };
        state.board = null;
        state.turn = RED;
        state.winner = null;
        state.lastCombat = null;
        state.results = null;
        state.recorded = false;
        state.setups = null;
        state.rematch = null;
        state.status = 'setup';
      }
      await this.saveState(state);
      await this.broadcastState();
      return;
    }

    // Make a move. The server is authoritative: it re-validates everything.
    if (msg.type === 'move') {
      if (state.status !== 'playing') return this.err(ws, 'the game is not in play');
      if (state.turn !== color) return this.err(ws, 'not your turn');
      const { fromR, fromC, toR, toC } = msg;
      if (![fromR, fromC, toR, toC].every(Number.isInteger)) return this.err(ws, 'invalid move');

      const board = deserializeBoard(state.board);
      const piece = board.getPiece(fromR, fromC);
      if (!piece || piece.color !== color) return this.err(ws, 'not your piece');
      const legal = board.getValidMoves(fromR, fromC).some((m) => m.toR === toR && m.toC === toC);
      if (!legal) return this.err(ws, 'illegal move');

      const record = board.executeMove(fromR, fromC, toR, toC);
      const winner = board.checkWin(); // RED, BLUE, or -1 (continue)

      state.board = serializeBoard(board);
      // Combat reveals both ranks to both players (that's how Stratego works).
      state.lastCombat = record.result !== null
        ? {
            from: { r: fromR, c: fromC }, to: { r: toR, c: toC },
            attacker: { color: record.attacker.color, rank: record.attacker.rank },
            defender: { color: record.defender.color, rank: record.defender.rank },
            result: record.result, // 1 attacker wins, 0 defender wins, -1 both die
          }
        : null;

      if (winner === RED || winner === BLUE) {
        state.status = 'gameover';
        state.winner = winner;
        await this.recordResult(state);
      } else {
        state.turn = state.turn === RED ? BLUE : RED;
      }

      await this.saveState(state);
      await this.broadcastState();
      return;
    }
  }

  // Record a finished game to D1 exactly once: W/L counts + Elo ratings.
  async recordResult(state) {
    if (state.recorded) return;
    state.recorded = true;
    const wc = state.winner;
    const lc = wc === RED ? BLUE : RED;
    const wId = state.players[wc]?.userId;
    const lId = state.players[lc]?.userId;
    if (!wId || !lId) return;
    try {
      const wRow = await this.env.DB.prepare('SELECT rating FROM users WHERE id=?').bind(wId).first();
      const lRow = await this.env.DB.prepare('SELECT rating FROM users WHERE id=?').bind(lId).first();
      const Rw = wRow?.rating ?? 1000;
      const Rl = lRow?.rating ?? 1000;
      const [nRw, nRl] = elo(Rw, Rl);
      await this.env.DB.prepare('UPDATE users SET wins=wins+1, rating=? WHERE id=?').bind(nRw, wId).run();
      await this.env.DB.prepare('UPDATE users SET losses=losses+1, rating=? WHERE id=?').bind(nRl, lId).run();
      state.results = {
        [wc]: { won: true, before: Rw, after: nRw, delta: nRw - Rw },
        [lc]: { won: false, before: Rl, after: nRl, delta: nRl - Rl },
      };
    } catch (e) {
      // Don't let a stats write break the game result.
      state.results = null;
    }
  }

  err(ws, error) {
    try { ws.send(JSON.stringify({ type: 'error', error })); } catch { /* closing */ }
  }

  async webSocketClose(ws, code, reason) {
    try { ws.close(code, reason); } catch { /* already closing */ }
    // Notify the remaining player of the disconnect.
    await this.broadcastState();
  }

  async webSocketError() { /* connection bookkeeping handled on close */ }
}
