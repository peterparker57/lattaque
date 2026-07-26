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
  serializeBoard, deserializeBoard, buildPlayerView,
} from '../public/game-core.js';
import { handleAuth, getSessionUser } from './auth.js';
import { GameRoom } from './gameroom.js';

// Durable Object classes must be exported from the Worker entry so the runtime can register them.
export { GameRoom };

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

      // --- Matchmaking (all require a logged-in user) ---

      // Start a game vs a username (WWF-style instant start, no accept step):
      // seed the GameRoom with BOTH players and record the match row for lists.
      if (url.pathname === '/api/match/challenge' && request.method === 'POST') {
        const user = await getSessionUser(env, request);
        if (!user) return Response.json({ error: 'login required' }, { status: 401 });
        const body = await request.json().catch(() => ({}));
        const oppName = String(body.opponent || '').trim();
        if (!oppName) return Response.json({ error: 'enter an opponent username' }, { status: 400 });
        const opp = await env.DB.prepare('SELECT id, username FROM users WHERE username = ?')
          .bind(oppName).first();
        if (!opp) return Response.json({ error: `no player named "${oppName}"` }, { status: 404 });
        if (opp.id === user.id) return Response.json({ error: 'you cannot challenge yourself' }, { status: 400 });

        for (let attempt = 0; attempt < 6; attempt++) {
          const id = genRoomCode();
          const stub = env.GAME_ROOMS.get(env.GAME_ROOMS.idFromName(id));
          const res = await stub.fetch(doReq('create', {
            id,
            red: { userId: user.id, username: user.username },
            blue: { userId: opp.id, username: opp.username },
          }));
          if (res.status === 409) continue; // id collision — retry with a fresh one
          if (res.status !== 200) return Response.json({ error: 'could not create match' }, { status: 500 });
          const now = Date.now();
          await env.DB.prepare(
            `INSERT INTO matches (id, red_id, blue_id, status, red_ready, blue_ready, created_at, updated_at)
             VALUES (?, ?, ?, 'setup', 0, 0, ?, ?)`,
          ).bind(id, user.id, opp.id, now, now).run();
          return Response.json({ id, color: 0, opponent: opp.username });
        }
        return Response.json({ error: 'could not allocate a match id' }, { status: 503 });
      }

      // My games list (both colors), most recently active first.
      if (url.pathname === '/api/match/mine' && request.method === 'GET') {
        const user = await getSessionUser(env, request);
        if (!user) return Response.json({ error: 'login required' }, { status: 401 });
        const rows = await env.DB.prepare(
          `SELECT m.id, m.status, m.turn, m.winner, m.red_ready, m.blue_ready, m.updated_at,
                  m.red_id, ru.username AS red_name, bu.username AS blue_name
             FROM matches m
             JOIN users ru ON ru.id = m.red_id
             JOIN users bu ON bu.id = m.blue_id
            WHERE m.red_id = ? OR m.blue_id = ?
            ORDER BY m.updated_at DESC LIMIT 30`,
        ).bind(user.id, user.id).all();
        const games = (rows.results || []).map((m) => {
          const myColor = m.red_id === user.id ? 0 : 1;
          return {
            id: m.id,
            myColor,
            opponent: myColor === 0 ? m.blue_name : m.red_name,
            status: m.status,
            turn: m.turn,
            winner: m.winner,
            myReady: !!(myColor === 0 ? m.red_ready : m.blue_ready),
            oppReady: !!(myColor === 0 ? m.blue_ready : m.red_ready),
            updatedAt: m.updated_at,
          };
        });
        return Response.json({ games });
      }

      // Match WebSocket -> resolve the user, then route the upgrade to the GameRoom DO.
      const wsMatch = url.pathname.match(/^\/api\/match\/([A-Za-z0-9]{1,12})\/ws$/);
      if (wsMatch) {
        const user = await getSessionUser(env, request);
        if (!user) return new Response('login required', { status: 401 });
        const code = wsMatch[1].toUpperCase();
        const stub = env.GAME_ROOMS.get(env.GAME_ROOMS.idFromName(code));
        const headers = new Headers(request.headers);
        headers.set('X-User-Id', String(user.id));
        headers.set('X-User-Name', user.username);
        return stub.fetch(new Request(request, { headers }));
      }

      // Leaderboard: top players by rating (public).
      if (url.pathname === '/api/leaderboard' && request.method === 'GET') {
        const rows = await env.DB.prepare(
          'SELECT username, wins, losses, draws, rating FROM users ORDER BY rating DESC, wins DESC LIMIT 20',
        ).all();
        return Response.json({ players: rows.results || [] });
      }

      if (url.pathname === '/api/health' && request.method === 'GET') {
        return Response.json({ ok: true, service: 'lattaque', phase: 5, ts: Date.now() });
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

// Room code: 5 chars from an unambiguous alphabet (no I/O/0/1) — easy to share verbally.
function genRoomCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  let s = '';
  for (let i = 0; i < 5; i++) s += A[bytes[i] % A.length];
  return s;
}

// Build an internal HTTP request carrying a JSON command to a GameRoom Durable Object.
function doReq(cmd, body) {
  return new Request(`https://gameroom/${cmd}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

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

  // --- serialize/deserialize round-trip ---
  const sb = new Board();
  const marshal = new Piece(RED, RANK.MARSHAL, 10);
  const general = new Piece(BLUE, RANK.GENERAL, 20);
  general.known = true; // pretend revealed via combat
  sb.setPiece(2, 4, marshal);
  sb.setPiece(6, 4, general);
  const round = deserializeBoard(JSON.parse(JSON.stringify(serializeBoard(sb))));
  check('serialize round-trip: piece rank', round.getPiece(2, 4).rank, RANK.MARSHAL);
  check('serialize round-trip: known flag', round.getPiece(6, 4).known, true);

  // --- anti-cheat: buildPlayerView hides enemy hidden ranks, shows own + revealed ---
  const vb = new Board();
  const redMarshal = new Piece(RED, RANK.MARSHAL, 11);      // RED's own, hidden
  const blueSpy = new Piece(BLUE, RANK.SPY, 21);            // enemy, hidden
  const blueMiner = new Piece(BLUE, RANK.MINER, 22);        // enemy, revealed
  blueMiner.known = true;
  vb.setPiece(1, 1, redMarshal);
  vb.setPiece(8, 8, blueSpy);
  vb.setPiece(8, 7, blueMiner);
  const redView = buildPlayerView(vb, RED);
  check('view: RED sees own marshal rank', redView.grid[1][1].rank, RANK.MARSHAL);
  check('view: RED CANNOT see hidden enemy spy rank', redView.grid[8][8].rank, null);
  check('view: RED sees revealed enemy miner rank', redView.grid[8][7].rank, RANK.MINER);
  const blueView = buildPlayerView(vb, BLUE);
  check('view: BLUE sees own spy rank', blueView.grid[8][8].rank, RANK.SPY);
  check('view: BLUE CANNOT see hidden enemy marshal rank', blueView.grid[1][1].rank, null);

  const passed = checks.filter(c => c.pass).length;
  return {
    ok: passed === checks.length,
    phase: 4,
    passed,
    total: checks.length,
    ranAt: Date.now(),
    checks,
  };
}
