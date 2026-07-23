// GameRoom — authoritative Durable Object for ONE online Stratego match.
// Holds the true board and coordinates two players over hibernatable WebSockets.
// The server is the referee: it never sends a player an enemy piece's hidden rank.
//
// Phase 4a: skeleton — accept a WebSocket upgrade and echo. Match state, setup,
// authoritative moves, and per-player filtered views are added in P4c-P4e.

import { DurableObject } from 'cloudflare:workers';

export class GameRoom extends DurableObject {
  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('GameRoom: expected a WebSocket upgrade', { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Hibernatable WebSocket: the runtime can evict this DO from memory between
    // messages and rehydrate it, so we must not rely on in-memory-only state.
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({ type: 'connected', ts: Date.now() }));

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    // Skeleton: echo back. Real protocol (setup/move/state) lands in P4c-P4e.
    let payload;
    try {
      payload = JSON.parse(message);
    } catch {
      ws.send(JSON.stringify({ type: 'error', error: 'invalid JSON' }));
      return;
    }
    ws.send(JSON.stringify({ type: 'echo', received: payload }));
  }

  async webSocketClose(ws, code, reason, wasClean) {
    try {
      ws.close(code, reason);
    } catch {
      /* already closing */
    }
  }

  async webSocketError(ws, error) {
    // Nothing to clean up yet; connection bookkeeping is added with match state.
  }
}
