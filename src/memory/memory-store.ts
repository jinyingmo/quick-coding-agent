export type MemoryLayer = "working" | "episodic" | "semantic" | "repo";
export type MemoryKind = "note" | "case" | "rule" | "symbol";

export interface MemoryEntry {
  id?: string;
  layer: MemoryLayer;
  kind: MemoryKind;
  text: string;
  tags: string[];
  fileRefs: string[];
  importance: number;
  embedding?: number[];
  createdAt?: number;
  lastAccessAt?: number;
  ttlSec?: number;
  commitHash?: string;
}

export interface MemoryQuery {
  q: string;
  layers?: MemoryLayer[];
  tags?: string[];
  topK?: number;
}

export interface MemoryHit {
  id: string;
  layer: MemoryLayer;
  text: string;
  score: number;
  tags: string[];
  fileRefs: string[];
}

export interface MemoryStore {
  put(entry: MemoryEntry): Promise<string>;
  search(query: MemoryQuery): Promise<MemoryHit[]>;
  touch(id: string): Promise<void>;
  compact(layer: MemoryLayer): Promise<void>;
  cleanupExpired(now?: number): Promise<number>;
}
