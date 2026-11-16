CREATE TABLE IF NOT EXISTS seen_updates (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_seen_at ON seen_updates(at);

CREATE TABLE IF NOT EXISTS ask_threads (
  chat INTEGER NOT NULL,
  msg INTEGER NOT NULL,
  history TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (chat, msg)
);
CREATE INDEX IF NOT EXISTS idx_ask_at ON ask_threads(at);

CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY,
  chat INTEGER NOT NULL,
  at INTEGER NOT NULL,
  text TEXT NOT NULL,
  reply INTEGER,
  repeat TEXT,
  tries INTEGER NOT NULL DEFAULT 0,
  claimed INTEGER
);
CREATE INDEX IF NOT EXISTS idx_rem_at ON reminders(at);
CREATE INDEX IF NOT EXISTS idx_rem_chat ON reminders(chat);
