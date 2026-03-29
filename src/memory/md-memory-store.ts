import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { nowTs } from "../utils/clock.js";
import type {
  MemoryEntry,
  MemoryHit,
  MemoryLayer,
  MemoryQuery,
  MemoryStore,
} from "./memory-store.js";

/* ────────── 内部类型 ────────── */

interface StoredEntry {
  id: string;
  kind: string;
  text: string;
  tags: string[];
  fileRefs: string[];
  importance: number;
  createdAt: number;
  lastAccessAt: number;
  ttlSec: number | null;
  commitHash: string | null;
}

/* ────────── 格式解析 ────────── */

const ENTRY_ID_RE = /^### ([a-f0-9]{8})$/;
const META_LINE_RE = /^- (\w+): (.*)$/;

function parseLayerFile(content: string): StoredEntry[] {
  const lines = content.split("\n");
  const entries: StoredEntry[] = [];

  let currentId: string | null = null;
  let meta: Record<string, string> = {};
  let inMeta = false;
  let bodyLines: string[] = [];

  function flush() {
    if (!currentId) return;
    entries.push({
      id: currentId,
      kind: meta.kind ?? "note",
      text: bodyLines.join("\n").trim(),
      tags: meta.tags ? meta.tags.split(", ").filter(Boolean) : [],
      fileRefs: meta.files ? meta.files.split(", ").filter(Boolean) : [],
      importance: parseFloat(meta.importance ?? "0.6"),
      createdAt: parseInt(meta.created ?? "0"),
      lastAccessAt: parseInt(meta.accessed ?? "0"),
      ttlSec: meta.ttl != null ? parseInt(meta.ttl) : null,
      commitHash: meta.commit ?? null,
    });
  }

  for (const line of lines) {
    const headerMatch = line.match(ENTRY_ID_RE);
    if (headerMatch) {
      flush();
      currentId = headerMatch[1];
      meta = {};
      bodyLines = [];
      inMeta = true;
      continue;
    }
    if (!currentId) continue;
    if (inMeta) {
      const metaMatch = line.match(META_LINE_RE);
      if (metaMatch) { meta[metaMatch[1]] = metaMatch[2]; continue; }
      inMeta = false;
      if (line !== "") bodyLines.push(line);
    } else {
      bodyLines.push(line);
    }
  }

  flush();
  return entries;
}

/* ────────── 格式序列化 ────────── */

function serializeEntry(e: StoredEntry): string {
  const lines = [`### ${e.id}`];
  lines.push(`- kind: ${e.kind}`);
  lines.push(`- importance: ${e.importance}`);
  if (e.tags.length > 0)     lines.push(`- tags: ${e.tags.join(", ")}`);
  if (e.fileRefs.length > 0) lines.push(`- files: ${e.fileRefs.join(", ")}`);
  lines.push(`- created: ${e.createdAt}`);
  lines.push(`- accessed: ${e.lastAccessAt}`);
  if (e.ttlSec != null) lines.push(`- ttl: ${e.ttlSec}`);
  if (e.commitHash)     lines.push(`- commit: ${e.commitHash}`);
  lines.push("");
  lines.push(e.text);
  return lines.join("\n");
}

function serializeLayerFile(layer: string, entries: StoredEntry[]): string {
  const header = `<!-- layer: ${layer} | version: 1 -->`;
  if (entries.length === 0) return header + "\n";
  return header + "\n\n" + entries.map(serializeEntry).join("\n\n") + "\n";
}

/* ────────── 搜索工具函数 ────────── */

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s\u4e00-\u9fff]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

function keywordScore(query: string, text: string): number {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return 0;
  if (text.toLowerCase().includes(query.toLowerCase())) return 1.0;
  const textTokens = new Set(tokenize(text));
  let score = 0;
  for (const qt of queryTokens) {
    if (textTokens.has(qt)) {
      score += 1;
    } else {
      for (const tt of textTokens) {
        if (tt.startsWith(qt) || qt.startsWith(tt)) { score += 0.5; break; }
      }
    }
  }
  return score / queryTokens.length;
}

function recencyScore(lastAccessAt: number, now: number): number {
  return Math.max(0, 1 - (now - lastAccessAt) / (7 * 24 * 3600 * 1000));
}

function tagBonus(queryTokens: string[], entryTags: string[]): number {
  if (entryTags.length === 0) return 0;
  const lowerTags = entryTags.map((t) => t.toLowerCase());
  let hits = 0;
  for (const qt of queryTokens) {
    if (lowerTags.some((t) => t.includes(qt))) hits++;
  }
  return hits > 0 ? Math.min(1, hits / queryTokens.length) : 0;
}

const W_KEYWORD = 0.55;
const W_RECENCY = 0.20;
const W_IMPORTANCE = 0.10;
const W_TAG = 0.15;

/* ────────── 主实现 ────────── */

export class MdMemoryStore implements MemoryStore {
  private memoryDir: string;
  private cache = new Map<MemoryLayer, StoredEntry[]>();
  private dirty = new Set<MemoryLayer>();
  private initialized = false;

  constructor(memoryDir = ".agent/memory") {
    this.memoryDir = path.resolve(memoryDir);
  }

  async put(entry: MemoryEntry): Promise<string> {
    await this.ensureInit();
    const layer = entry.layer;
    const entries = await this.loadLayer(layer);
    const id = entry.id ?? randomUUID().replace(/-/g, "").slice(0, 8);
    const ts = nowTs();

    const stored: StoredEntry = {
      id,
      kind: entry.kind,
      text: entry.text,
      tags: entry.tags,
      fileRefs: entry.fileRefs,
      importance: entry.importance,
      createdAt: entry.createdAt ?? ts,
      lastAccessAt: entry.lastAccessAt ?? ts,
      ttlSec: entry.ttlSec ?? null,
      commitHash: entry.commitHash ?? null,
    };

    const idx = entries.findIndex((e) => e.id === id);
    if (idx >= 0) entries[idx] = stored;
    else entries.push(stored);

    this.dirty.add(layer);
    await this.flush();
    return id;
  }

  async search(query: MemoryQuery): Promise<MemoryHit[]> {
    await this.ensureInit();
    const layers = query.layers ?? ["working", "episodic"];
    const topK = query.topK ?? 8;
    const now = nowTs();
    const queryTokens = tokenize(query.q);
    const allHits: MemoryHit[] = [];

    for (const layer of layers) {
      for (const entry of await this.loadLayer(layer)) {
        if (query.tags?.length && !query.tags.some((t) => entry.tags.includes(t))) continue;

        const score =
          W_KEYWORD    * keywordScore(query.q, entry.text) +
          W_RECENCY    * recencyScore(entry.lastAccessAt, now) +
          W_IMPORTANCE * entry.importance +
          W_TAG        * tagBonus(queryTokens, entry.tags);

        if (score > 0.05) {
          allHits.push({ id: entry.id, layer, text: entry.text, score, tags: entry.tags, fileRefs: entry.fileRefs });
        }
      }
    }

    const results = allHits.sort((a, b) => b.score - a.score).slice(0, topK);
    for (const hit of results) await this.touch(hit.id);
    return results;
  }

  async touch(id: string): Promise<void> {
    const now = nowTs();
    for (const [layer, entries] of this.cache) {
      const entry = entries.find((e) => e.id === id);
      if (entry) { entry.lastAccessAt = now; this.dirty.add(layer); break; }
    }
  }

  async compact(layer: MemoryLayer): Promise<void> {
    const threshold = layer === "working" ? 200 : 2000;
    const entries = await this.loadLayer(layer);
    if (entries.length <= threshold) return;
    entries.sort((a, b) => a.importance - b.importance || a.lastAccessAt - b.lastAccessAt);
    this.cache.set(layer, entries.slice(entries.length - threshold));
    this.dirty.add(layer);
    await this.flush();
  }

  async cleanupExpired(now = nowTs()): Promise<number> {
    await this.ensureInit();
    let removed = 0;
    for (const layer of ["working", "episodic"] as MemoryLayer[]) {
      const entries = await this.loadLayer(layer);
      const valid = entries.filter((e) => e.ttlSec == null || e.createdAt + e.ttlSec * 1000 > now);
      removed += entries.length - valid.length;
      if (valid.length !== entries.length) { this.cache.set(layer, valid); this.dirty.add(layer); }
    }
    if (this.dirty.size > 0) await this.flush();
    return removed;
  }

  private async ensureInit(): Promise<void> {
    if (this.initialized) return;
    await fs.mkdir(this.memoryDir, { recursive: true });
    this.initialized = true;
  }

  private layerPath(layer: MemoryLayer): string {
    return path.join(this.memoryDir, `${layer}.md`);
  }

  private async loadLayer(layer: MemoryLayer): Promise<StoredEntry[]> {
    if (this.cache.has(layer)) return this.cache.get(layer)!;
    try {
      const raw = await fs.readFile(this.layerPath(layer), "utf-8");
      const entries = parseLayerFile(raw);
      this.cache.set(layer, entries);
      return entries;
    } catch {
      const empty: StoredEntry[] = [];
      this.cache.set(layer, empty);
      return empty;
    }
  }

  async flush(): Promise<void> {
    for (const layer of this.dirty) {
      const entries = this.cache.get(layer) ?? [];
      const content = serializeLayerFile(layer, entries);
      const target = this.layerPath(layer);
      const tmp = target + ".tmp";
      await fs.writeFile(tmp, content, "utf-8");
      await fs.rename(tmp, target);
    }
    this.dirty.clear();
  }
}
