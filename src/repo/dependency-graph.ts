import fs from "node:fs/promises";

export type DependencyGraph = Map<string, Set<string>>;

const importRegex = /from\s+["']([^"']+)["']/g;

export class DependencyGraphBuilder {
  async build(files: string[]): Promise<DependencyGraph> {
    const graph: DependencyGraph = new Map();
    for (const file of files) {
      const text = await fs.readFile(file, "utf-8");
      const deps = new Set<string>();
      for (const match of text.matchAll(importRegex)) {
        deps.add(match[1]);
      }
      graph.set(file, deps);
    }
    return graph;
  }

  neighbors(graph: DependencyGraph, target: string): string[] {
    const direct = graph.get(target);
    if (!direct) return [];
    return Array.from(direct);
  }
}
