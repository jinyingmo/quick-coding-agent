import { createHash } from "node:crypto";
import { nowTs } from "../utils/clock.js";

export class EmbeddingCache {
  constructor(private db: any) {}

  /**
   * Get or compute embeddings for texts
   * Returns embeddings in same order as input texts
   */
  async getOrCompute(
    texts: string[],
    computeFn: (missingTexts: string[]) => Promise<number[][]>
  ): Promise<number[][]> {
    if (texts.length === 0) return [];

    const hashes = texts.map((t) => this.hash(t));
    const cached = this.getBatch(hashes);

    const missing: { index: number; text: string; hash: string }[] = [];
    for (let i = 0; i < texts.length; i++) {
      if (cached[i] === null) {
        missing.push({ index: i, text: texts[i], hash: hashes[i] });
      }
    }

    if (missing.length > 0) {
      const computed = await computeFn(missing.map((m) => m.text));
      for (let i = 0; i < missing.length; i++) {
        this.put(missing[i].hash, missing[i].text, computed[i]);
        cached[missing[i].index] = computed[i];
      }
    }

    return cached as number[][];
  }

  private hash(text: string): string {
    return createHash("sha256").update(text).digest("hex");
  }

  private getBatch(hashes: string[]): (number[] | null)[] {
    const placeholders = hashes.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT content_hash, embedding FROM embedding_cache WHERE content_hash IN (${placeholders})`
      )
      .all(...hashes) as Array<{ content_hash: string; embedding: string }>;

    const map = new Map(rows.map((r) => [r.content_hash, JSON.parse(r.embedding)]));
    return hashes.map((h) => map.get(h) ?? null);
  }

  private put(hash: string, contentPreview: string, embedding: number[]): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO embedding_cache (content_hash, content_preview, embedding, created_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(hash, contentPreview.slice(0, 100), JSON.stringify(embedding), nowTs());
  }

  /**
   * Clean old cached embeddings (default: >7 days)
   */
  async cleanup(olderThanDays = 7): Promise<number> {
    const cutoff = nowTs() - olderThanDays * 24 * 3600 * 1000;
    const result = this.db
      .prepare("DELETE FROM embedding_cache WHERE created_at < ?")
      .run(cutoff);
    return result.changes;
  }
}
