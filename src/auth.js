// Stratego / L'Attaque — accounts: signup/login/logout/session.
// Uses WebCrypto (PBKDF2-SHA256) — no external crypto libraries.
// Storage is Cloudflare D1 via env.DB (see schema.sql).

const PBKDF2_ITERS = 100_000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const COOKIE_NAME = 'session';

// ---------- small utilities ----------

const json = (obj, status = 200, extraHeaders = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });

function bytesToB64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function b64ToBytes(b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
function b64url(bytes) {
  return bytesToB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Constant-time byte comparison.
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function pbkdf2(password, salt, iters) {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: iters, hash: 'SHA-256' },
    keyMaterial,
    256,
  );
  return new Uint8Array(bits);
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERS);
  return { saltB64: bytesToB64(salt), hashB64: bytesToB64(hash), iters: PBKDF2_ITERS };
}

async function verifyPassword(password, saltB64, hashB64, iters) {
  const salt = b64ToBytes(saltB64);
  const expected = b64ToBytes(hashB64);
  const actual = await pbkdf2(password, salt, iters);
  return timingSafeEqual(actual, expected);
}

// ---------- cookies ----------

function parseCookies(request) {
  const header = request.headers.get('Cookie') || '';
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

// Secure only over HTTPS so the cookie also works under local `wrangler dev` (http).
function sessionCookie(request, token, maxAgeSec) {
  const secure = new URL(request.url).protocol === 'https:' ? ' Secure;' : '';
  return `${COOKIE_NAME}=${token}; HttpOnly;${secure} SameSite=Lax; Path=/; Max-Age=${maxAgeSec}`;
}
function clearCookie(request) {
  return sessionCookie(request, '', 0);
}

// ---------- validation ----------

const USERNAME_RE = /^[A-Za-z0-9_-]{3,20}$/;
function validateCredentials(username, password) {
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
    return '3-20 characters, letters/numbers/_/- only';
  }
  if (typeof password !== 'string' || password.length < 8 || password.length > 200) {
    return 'password must be 8-200 characters';
  }
  return null;
}

function publicUser(row) {
  return {
    id: row.id,
    username: row.username,
    wins: row.wins,
    losses: row.losses,
    draws: row.draws,
    rating: row.rating,
    createdAt: row.created_at,
  };
}

// ---------- sessions ----------

async function createSession(env, userId, request) {
  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const now = Date.now();
  await env.DB.prepare(
    'INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
  )
    .bind(token, userId, now, now + SESSION_TTL_MS)
    .run();
  return { token, cookie: sessionCookie(request, token, Math.floor(SESSION_TTL_MS / 1000)) };
}

// Resolve the current user from the session cookie (or null). Cleans up if expired.
async function getSessionUser(env, request) {
  const token = parseCookies(request)[COOKIE_NAME];
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT u.*, s.expires_at AS _exp
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ?`,
  )
    .bind(token)
    .first();
  if (!row) return null;
  if (row._exp <= Date.now()) {
    await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
    return null;
  }
  return row;
}

// ---------- request handlers ----------

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

async function handleSignup(request, env) {
  const body = await readJson(request);
  if (!body) return json({ error: 'invalid request body' }, 400);
  const username = (body.username || '').trim();
  const { password } = body;
  const invalid = validateCredentials(username, password);
  if (invalid) return json({ error: invalid }, 400);

  const { saltB64, hashB64, iters } = await hashPassword(password);
  let result;
  try {
    result = await env.DB.prepare(
      `INSERT INTO users (username, pw_hash, pw_salt, pw_iters, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(username, hashB64, saltB64, iters, Date.now())
      .run();
  } catch (e) {
    // UNIQUE (username) collision -> taken. Any other DB error -> 500.
    if (String(e).includes('UNIQUE')) return json({ error: 'username already taken' }, 409);
    return json({ error: 'could not create account' }, 500);
  }

  const userId = result.meta.last_row_id;
  const row = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first();
  const { cookie } = await createSession(env, userId, request);
  return json({ user: publicUser(row) }, 200, { 'Set-Cookie': cookie });
}

async function handleLogin(request, env) {
  const body = await readJson(request);
  if (!body) return json({ error: 'invalid request body' }, 400);
  const username = (body.username || '').trim();
  const { password } = body;
  if (typeof username !== 'string' || typeof password !== 'string') {
    return json({ error: 'invalid username or password' }, 401);
  }

  const row = await env.DB.prepare('SELECT * FROM users WHERE username = ?')
    .bind(username)
    .first();
  // Enumeration-safe: same generic error whether the user exists or the password is wrong.
  const ok = row && (await verifyPassword(password, row.pw_salt, row.pw_hash, row.pw_iters));
  if (!ok) return json({ error: 'invalid username or password' }, 401);

  const { cookie } = await createSession(env, row.id, request);
  return json({ user: publicUser(row) }, 200, { 'Set-Cookie': cookie });
}

async function handleLogout(request, env) {
  const token = parseCookies(request)[COOKIE_NAME];
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
  return json({ ok: true }, 200, { 'Set-Cookie': clearCookie(request) });
}

async function handleMe(request, env) {
  const row = await getSessionUser(env, request);
  if (!row) return json({ error: 'not authenticated' }, 401);
  return json({ user: publicUser(row) });
}

// Router entry for /api/auth/*. Returns a Response, or null if no auth route matched.
export async function handleAuth(request, env, pathname) {
  const post = request.method === 'POST';
  const get = request.method === 'GET';
  if (pathname === '/api/auth/signup' && post) return handleSignup(request, env);
  if (pathname === '/api/auth/login' && post) return handleLogin(request, env);
  if (pathname === '/api/auth/logout' && post) return handleLogout(request, env);
  if (pathname === '/api/auth/me' && get) return handleMe(request, env);
  return null;
}

export { getSessionUser, publicUser };
