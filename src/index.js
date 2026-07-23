// Stratego Online — Cloudflare Worker entry point.
//
// The Worker fronts the static game and (in later phases) runs the API and the
// authoritative GameRoom Durable Object. Crucially, it imports the SAME rules
// module the browser uses (../public/game-core.js) so move/combat judging is
// identical on both sides — the foundation for a cheat-resistant server.
//
// Static asset requests (index.html, stratego.js, game-core.js, style.css,
// images, audio) are served directly by Cloudflare and never reach this code;
// only non-asset paths fall through to the fetch handler.
//
// Later phases add here:
//   - /api/auth/*      signup, login, logout, session (D1 + PBKDF2)
//   - /api/match/*     create/join game, matchmaking
//   - WebSocket upgrade -> routed to the GameRoom Durable Object

import {
  RED, BLUE, RANK,
  Piece, Board, generateSetup,
} from '../public/game-core.js';
import { handleAuth } from './auth.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      // Accounts: /api/auth/signup|login|logout|me (returns null if not an auth route).
      if (url.pathname.startsWith('/api/auth/')) {
        const res = await handleAuth(request, env, url.pathname);
        if (res) return res;
        return new Response('Not found', { status: 404 });
      }
      if (url.pathname === '/api/health' && request.method === 'GET') {
        return Response.json({ ok: true, service: 'lattaque', phase: 3, ts: Date.now() });
      }
      // Proves the shared rules module runs server-side and agrees with the client.
      if (url.pathname === '/api/rules/selftest' && request.method === 'GET') {
        return Response.json(rulesSelfTest());
      }
      return new Response('Not found', { status: 404 });
    }

    // Static assets are served by the assets layer before this handler runs.
    // Reaching here means no asset matched a non-API path.
    return new Response('Not found', { status: 404 });
  },
};

// Exercise game-core.js inside the Worker runtime and report parity results.
// If this passes on the server, the authoritative GameRoom can trust the same
// code the browser runs.
function rulesSelfTest() {
  const checks = [];
  const check = (name, got, want) => checks.push({ name, got, want, pass: got === want });

  // --- combat rules (Piece.winFight): 1=attacker wins, 0=defender wins, -1=both die ---
  const p = (color, rank) => new Piece(color, rank, 0);
  check('spy beats marshal (attacking)',
    Piece.winFight(p(RED, RANK.SPY), p(BLUE, RANK.MARSHAL)), 1);
  check('marshal loses to nothing vs general',
    Piece.winFight(p(RED, RANK.GENERAL), p(BLUE, RANK.MARSHAL)), 0);
  check('equal ranks both die',
    Piece.winFight(p(RED, RANK.MAJOR), p(BLUE, RANK.MAJOR)), -1);
  check('miner defuses bomb',
    Piece.winFight(p(RED, RANK.MINER), p(BLUE, RANK.BOMB)), 1);
  check('scout dies to bomb',
    Piece.winFight(p(RED, RANK.SCOUT), p(BLUE, RANK.BOMB)), 0);
  check('any attacker captures flag',
    Piece.winFight(p(RED, RANK.SCOUT), p(BLUE, RANK.FLAG)), 1);

  // --- Board.executeMove resolves a combat and captures correctly ---
  const b = new Board();
  b.setPiece(3, 0, new Piece(RED, RANK.MARSHAL, 1));   // attacker
  b.setPiece(4, 0, new Piece(BLUE, RANK.GENERAL, 2));  // defender (weaker)
  const rec = b.executeMove(3, 0, 4, 0);
  check('executeMove: attacker wins combat', rec.result, 1);
  check('executeMove: attacker now on target square',
    b.getPiece(4, 0) && b.getPiece(4, 0).rank, RANK.MARSHAL);
  check('executeMove: source square emptied', b.getPiece(3, 0), null);
  check('executeMove: defender captured', b.capturedBlue.length, 1);

  // --- generateSetup produces a full, legal-count army on the right side ---
  const setup = generateSetup(RED);
  check('generateSetup piece count', setup.length, 40);
  const allInRedZone = setup.every(s => s.r >= 0 && s.r <= 3);
  check('generateSetup all pieces in red back rows (0-3)', allInRedZone, true);
  const flags = setup.filter(s => s.piece.rank === RANK.FLAG).length;
  check('generateSetup exactly one flag', flags, 1);

  const passed = checks.filter(c => c.pass).length;
  return {
    ok: passed === checks.length,
    phase: 2,
    passed,
    total: checks.length,
    ranAt: Date.now(),
    checks,
  };
}
