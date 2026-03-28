import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const migration001 = `
CREATE TABLE IF NOT EXISTS memory_entries (
  id TEXT PRIMARY KEY,
  layer TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  tags TEXT NOT NULL,
  file_refs TEXT NOT NULL,
  importance REAL NOT NULL DEFAULT 0.5,
  embedding TEXT,
  created_at INTEGER NOT NULL,
  last_access_at INTEGER NOT NULL,
  ttl_sec INTEGER,
  commit_hash TEXT
);

CREATE INDEX IF NOT EXISTS idx_memory_layer_created ON memory_entries(layer, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_layer_access ON memory_entries(layer, last_access_at DESC);
`;

const migration002 = `
CREATE TABLE IF NOT EXISTS embedding_cache (
  content_hash TEXT PRIMARY KEY,
  content_preview TEXT NOT NULL,
  embedding TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_embedding_cache_created ON embedding_cache(created_at DESC);
`;

export function createSqlite(dbPath: string): any {
  const absolute = path.resolve(dbPath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });

  const db = new Database(absolute);
  db.pragma("journal_mode = WAL");
  db.exec(migration001);
  db.exec(migration002);
  return db;
}
