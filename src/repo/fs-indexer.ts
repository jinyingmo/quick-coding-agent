import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".json", ".md", ".yml", ".yaml"]);

export interface FileChunk {
  id: string;
  file: string;
  content: string;
}

export class FsIndexer {
  constructor(private root: string) {}

  async listFiles(dir = this.root): Promise<string[]> {
    const out: string[] = [];
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".git")) continue;
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(...(await this.listFiles(full)));
        continue;
      }
      if (!DEFAULT_EXT.has(path.extname(entry.name))) continue;
      out.push(full);
    }
    return out;
  }

  async chunkFiles(maxChunkChars = 1800): Promise<FileChunk[]> {
    const files = await this.listFiles();
    const chunks: FileChunk[] = [];
    for (const file of files) {
      const content = await fs.readFile(file, "utf-8");
      if (content.length <= maxChunkChars) {
        chunks.push({ id: `${file}:0`, file, content });
        continue;
      }
      let offset = 0;
      let idx = 0;
      while (offset < content.length) {
        const part = content.slice(offset, offset + maxChunkChars);
        chunks.push({ id: `${file}:${idx}`, file, content: part });
        offset += maxChunkChars;
        idx += 1;
      }
    }
    return chunks;
  }
}
