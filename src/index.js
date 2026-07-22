// Stratego Online — Cloudflare Worker entry point.
//
// Phase 1: the Worker just fronts the static game. Static asset requests
// (index.html, stratego.js, style.css, images, audio) are served directly by
// Cloudflare from the [assets] directory and never reach this code. Only
// non-asset paths fall through to the fetch handler below.
//
// Later phases add here:
//   - /api/auth/*      signup, login, logout, session (D1 + PBKDF2)
//   - /api/match/*     create/join game, matchmaking
//   - WebSocket upgrade -> routed to the GameRoom Durable Object (authoritative board)

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      // Health check so we can confirm the Worker is live before any real API exists.
      if (url.pathname === '/api/health' && request.method === 'GET') {
        return Response.json({
          ok: true,
          service: 'stratego',
          phase: 1,
          ts: Date.now(),
        });
      }
      return new Response('Not found', { status: 404 });
    }

    // Non-API, non-asset paths (e.g. a deep link) fall back to the game shell.
    return env.ASSETS.fetch(request);
  },
};

// GameRoom Durable Object and D1 helpers are added in later phases.
