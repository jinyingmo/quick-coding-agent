import { randomUUID } from "node:crypto";
import { cosine } from "../utils/math.js";
import { nowTs } from "../utils/clock.js";
import type { EmbeddingCache } from "../storage/embedding-cache.js";
import type { MemoryEntry, MemoryHit, MemoryLayer, MemoryQuery, MemoryStore } from "./memory-store.js";

type Row = {
  id: string;
  layer: MemoryLayer;
  text: string;
  tags: string;
  file_refs: string;
  importance: number;
  embedding: string | null;
  created_at: number;
  last_access_at: number;
};

function keywordScore(q: string, text: string): number {
  const lowerQ = q.toLowerCase();
  const lowerT = text.toLowerCase();
  if (!lowerQ) return 0;
  if (lowerT.includes(lowerQ)) return 1;
  const qTokens = lowerQ.split(/\s+/).filter(Boolean);
  if (qTokens.length === 0) return 0;
  let hit = 0;
  for (const token of qTokens) {
    if (lowerT.includes(token)) hit += 1;
  }
  return hit / qTokens.length;
}

export class SqliteMemoryStore implements MemoryStore {
  constructor(
    private db: any,
    private embedder?: (texts: string[]) => Promise<number[][]>,
    private embeddingCache?: EmbeddingCache
  ) {}

  async put(entry: MemoryEntry): Promise<string> {
    const id = entry.id ?? randomUUID();
    const ts = nowTs();
    let embedding = entry.embedding ?? null;
    if (!embedding && this.embedder && entry.text.length > 0) {
      embedding = (await this.embedder([entry.text]))[0];
    }

    this.db
      .prepare(
        `
      INSERT OR REPLACE INTO memory_entries (
        id, layer, kind, text, tags, file_refs, importance, embedding,
        created_at, last_access_at, ttl_sec, commit_hash
      ) VALUES (
        @id, @layer, @kind, @text, @tags, @file_refs, @importance, @embedding,
        @created_at, @last_access_at, @ttl_sec, @commit_hash
      )
    `
      )
      .run({
        id,
        layer: entry.layer,
        kind: entry.kind,
        text: entry.text,
        tags: JSON.stringify(entry.tags),
        file_refs: JSON.stringify(entry.fileRefs),
        importance: entry.importance,
        embedding: embedding ? JSON.stringify(embedding) : null,
        created_at: entry.createdAt ?? ts,
        last_access_at: entry.lastAccessAt ?? ts,
        ttl_sec: entry.ttlSec ?? null,
        commit_hash: entry.commitHash ?? null,
      });

    return id;
  }

  async search(query: MemoryQuery): Promise<MemoryHit[]> {
    const topK = query.topK ?? 8;
    const layers = query.layers ?? ["working", "episodic", "semantic", "repo"];
    const placeholders = layers.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT id, layer, text, tags, file_refs, importance, embedding, created_at, last_access_at
         FROM memory_entries
         WHERE layer IN (${placeholders})`
      )
      .all(...layers) as Row[];

    let qEmb: number[] | null = null;
    if (query.q.trim()) {
      // Use embedding cache if available (P1 optimization: reuse query embedding)
      if (this.embeddingCache && this.embedder) {
        qEmb = (
          await this.embeddingCache.getOrCompute([query.q], (texts) =>
            this.embedder!(texts)
          )
        )[0];
      } else if (this.embedder) {
        qEmb = (await this.embedder([query.q]))[0];
      }
    }

    const scored = rows
      .map((row) => {
        const tags = JSON.parse(row.tags) as string[];
        if (query.tags && query.tags.length > 0) {
          const hasAnyTag = query.tags.some((t) => tags.includes(t));
          if (!hasAnyTag) return null;
        }
        const recency = Math.max(0, 1 - (nowTs() - row.last_access_at) / (7 * 24 * 3600 * 1000));
        const bm25Like = keywordScore(query.q, row.text);
        const emb = row.embedding ? (JSON.parse(row.embedding) as number[]) : null;
        const vector = qEmb && emb ? cosine(qEmb, emb) : 0;
        const finalScore = 0.4 * vector + 0.35 * bm25Like + 0.15 * recency + 0.1 * row.importance;
        return {
          id: row.id,
          layer: row.layer,
          text: row.text,
          score: finalScore,
          tags,
          fileRefs: JSON.parse(row.file_refs) as string[],
        } satisfies MemoryHit;
      })
      .filter((x): x is MemoryHit => Boolean(x))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    for (const item of scored) {
      await this.touch(item.id);
    }
    return scored;
  }

  async touch(id: string): Promise<void> {
    this.db
      .prepare("UPDATE memory_entries SET last_access_at = ? WHERE id = ?")
      .run(nowTs(), id);
  }

  async compact(layer: MemoryLayer): Promise<void> {
    const threshold = layer === "working" ? 200 : layer === "episodic" ? 2000 : 5000;
    const countRow = this.db
      .prepare("SELECT COUNT(*) as c FROM memory_entries WHERE layer = ?")
      .get(layer) as { c: number };
    if (countRow.c <= threshold) return;

    const pruneCount = countRow.c - threshold;
    this.db
      .prepare(
        `
      DELETE FROM memory_entries
      WHERE id IN (
        SELECT id FROM memory_entries
        WHERE layer = ?
        ORDER BY importance ASC, last_access_at ASC
        LIMIT ?
      )
      `
      )
      .run(layer, pruneCount);
  }

  async cleanupExpired(now = nowTs()): Promise<number> {
    const result = this.db
      .prepare(
        `
      DELETE FROM memory_entries
      WHERE ttl_sec IS NOT NULL
      AND (created_at + (ttl_sec * 1000)) < ?
      `
      )
      .run(now);
    return result.changes;
  }
}
