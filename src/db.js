import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'editor')),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS numbers (
  id INTEGER PRIMARY KEY,
  label TEXT NOT NULL,
  phone TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY,
  number_id INTEGER NOT NULL REFERENCES numbers(id) ON DELETE CASCADE,
  jid TEXT NOT NULL,
  name TEXT NOT NULL,
  invite TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (number_id, jid)
);
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('text', 'image', 'poll')),
  text TEXT NOT NULL DEFAULT '',
  image_path TEXT,
  poll_options TEXT,
  poll_multi INTEGER NOT NULL DEFAULT 0,
  scheduled_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('scheduled', 'sending', 'sent', 'failed', 'cancelled')),
  error TEXT,
  sent_at INTEGER,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS posts_due ON posts (status, scheduled_at);
`;

export function openDb(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  const userCols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!userCols.includes('totp_secret')) db.exec('ALTER TABLE users ADD COLUMN totp_secret TEXT');
  // Si el proceso se cortó en medio de un envío no sabemos si salió: se marca
  // como fallida para que alguien revise el canal antes de reintentar.
  db.prepare(
    "UPDATE posts SET status = 'failed', error = 'El sistema se reinició durante el envío. Revisá el canal antes de reintentar.' WHERE status = 'sending'"
  ).run();
  return db;
}
