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
