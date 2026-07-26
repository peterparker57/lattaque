-- Stratego / L'Attaque — accounts schema (Cloudflare D1 / SQLite)
-- Apply:  wrangler d1 execute lattaque --local  --file=schema.sql
--         wrangler d1 execute lattaque --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  username    TEXT    NOT NULL UNIQUE COLLATE NOCASE,  -- case-insensitive unique + lookups
  pw_hash     TEXT    NOT NULL,   -- base64(PBKDF2-SHA256 derived key)
  pw_salt     TEXT    NOT NULL,   -- base64(16 random bytes)
  pw_iters    INTEGER NOT NULL,   -- PBKDF2 iteration count (stored so cost can be raised later)
  created_at  INTEGER NOT NULL,   -- epoch ms
  wins        INTEGER NOT NULL DEFAULT 0,
  losses      INTEGER NOT NULL DEFAULT 0,
  draws       INTEGER NOT NULL DEFAULT 0,
  rating      INTEGER NOT NULL DEFAULT 1000
);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT    PRIMARY KEY,   -- base64url(32 random bytes)
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,      -- epoch ms
  expires_at  INTEGER NOT NULL       -- epoch ms
);

CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- One row per match (WWF-style games list). The row id doubles as the GameRoom
-- Durable Object name; the DO keeps this row in sync as the game progresses.
CREATE TABLE IF NOT EXISTS matches (
  id          TEXT    PRIMARY KEY,
  red_id      INTEGER NOT NULL REFERENCES users(id),
  blue_id     INTEGER NOT NULL REFERENCES users(id),
  status      TEXT    NOT NULL DEFAULT 'setup',  -- setup | playing | gameover
  turn        INTEGER,                            -- 0 red / 1 blue, while playing
  winner      INTEGER,                            -- 0 / 1 once gameover
  red_ready   INTEGER NOT NULL DEFAULT 0,         -- army submitted flags (setup badges)
  blue_ready  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_matches_red  ON matches(red_id);
CREATE INDEX IF NOT EXISTS idx_matches_blue ON matches(blue_id);
