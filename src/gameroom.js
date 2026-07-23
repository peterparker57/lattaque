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
import { buildPlayerView, deserializeBoard } from '../public/game-core.js';

const RED = 0;
const BLUE = 1;

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
      board: state.board ? buildPlayerView(deserializeBoard(state.board), forColor) : null,
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
    // setup (P4d) and move (P4e) commands handled here next.
  }

  async webSocketClose(ws, code, reason) {
    try { ws.close(code, reason); } catch { /* already closing */ }
    // Notify the remaining player of the disconnect.
    await this.broadcastState();
  }

  async webSocketError() { /* connection bookkeeping handled on close */ }
}
