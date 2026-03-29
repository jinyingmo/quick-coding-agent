import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import { MdMemoryStore } from "../md-memory-store.js";

describe("MdMemoryStore", () => {
  const testDir = ".test-memory";
  let store: MdMemoryStore;

  beforeEach(async () => {
    store = new MdMemoryStore(testDir);
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("should put and search entries", async () => {
    await store.put({
      layer: "episodic",
      kind: "case",
      text: "fixed email validation bug",
      tags: ["success", "validation"],
      fileRefs: ["src/validator.ts"],
      importance: 0.9,
    });

    const hits = await store.search({ q: "email validation", topK: 4 });
    expect(hits).toHaveLength(1);
    expect(hits[0].text).toContain("email validation");
  });

  it("should cleanup expired entries", async () => {
    await store.put({
      layer: "working",
      kind: "note",
      text: "old note",
      tags: [],
      fileRefs: [],
      importance: 0.6,
      ttlSec: 1,
      createdAt: Date.now() - 5000,
    });

    const removed = await store.cleanupExpired();
    expect(removed).toBe(1);
  });

  it("should persist across instances", async () => {
    await store.put({
      layer: "episodic",
      kind: "case",
      text: "persistent entry",
      tags: [],
      fileRefs: [],
      importance: 0.8,
    });

    const store2 = new MdMemoryStore(testDir);
    const hits = await store2.search({ q: "persistent", topK: 4 });
    expect(hits).toHaveLength(1);
  });

  it("should handle atomic write safety", async () => {
    await store.put({
      layer: "working",
      kind: "note",
      text: "test",
      tags: [],
      fileRefs: [],
      importance: 0.5,
    });

    const files = await fs.readdir(testDir);
    expect(files.every((f) => !f.endsWith(".tmp"))).toBe(true);
  });

  it("should compact when over threshold", async () => {
    for (let i = 0; i < 210; i++) {
      await store.put({
        layer: "working",
        kind: "note",
        text: `note ${i}`,
        tags: [],
        fileRefs: [],
        importance: Math.random(),
      });
    }

    await store.compact("working");
    const hits = await store.search({ q: "note", layers: ["working"], topK: 300 });
    expect(hits.length).toBeLessThanOrEqual(200);
  });

  it("should round-trip Markdown format correctly", async () => {
    await store.put({
      layer: "episodic",
      kind: "case",
      text: "task: Fix bug\nreasoning: Found null check\nsuccess: true",
      tags: ["success", "bugfix"],
      fileRefs: ["src/core/orchestrator.ts"],
      importance: 0.9,
    });

    const content = await fs.readFile(`${testDir}/episodic.md`, "utf-8");
    expect(content).toContain("<!-- layer: episodic");
    expect(content).toContain("- kind: case");
    expect(content).toContain("- tags: success, bugfix");
    expect(content).toContain("task: Fix bug");

    const store2 = new MdMemoryStore(testDir);
    const hits = await store2.search({ q: "Fix bug", topK: 4 });
    expect(hits[0].tags).toEqual(["success", "bugfix"]);
    expect(hits[0].fileRefs).toEqual(["src/core/orchestrator.ts"]);
  });

  it("should update existing entry by id", async () => {
    const id = await store.put({
      layer: "working",
      kind: "note",
      text: "original text",
      tags: ["original"],
      fileRefs: [],
      importance: 0.5,
    });

    await store.put({
      id,
      layer: "working",
      kind: "note",
      text: "updated text",
      tags: ["updated"],
      fileRefs: ["src/test.ts"],
      importance: 0.8,
    });

    const hits = await store.search({ q: "updated text", topK: 4 });
    expect(hits).toHaveLength(1);
    expect(hits[0].text).toBe("updated text");
    expect(hits[0].tags).toEqual(["updated"]);
    expect(hits[0].fileRefs).toEqual(["src/test.ts"]);
  });

  it("should filter by tags in search", async () => {
    await store.put({
      layer: "episodic",
      kind: "case",
      text: "bug fix one",
      tags: ["bugfix", "success"],
      fileRefs: [],
      importance: 0.8,
    });

    await store.put({
      layer: "episodic",
      kind: "case",
      text: "feature addition",
      tags: ["feature", "success"],
      fileRefs: [],
      importance: 0.7,
    });

    const hits = await store.search({ q: "success", tags: ["bugfix"], topK: 4 });
    expect(hits).toHaveLength(1);
    expect(hits[0].text).toBe("bug fix one");
  });

  it("should search across multiple layers", async () => {
    await store.put({
      layer: "working",
      kind: "note",
      text: "working note about authentication",
      tags: [],
      fileRefs: [],
      importance: 0.6,
    });

    await store.put({
      layer: "episodic",
      kind: "case",
      text: "episodic case about authentication",
      tags: [],
      fileRefs: [],
      importance: 0.8,
    });

    const hits = await store.search({ q: "authentication", layers: ["working", "episodic"], topK: 4 });
    expect(hits).toHaveLength(2);
  });

  it("should touch entry and update lastAccessAt", async () => {
    const id = await store.put({
      layer: "working",
      kind: "note",
      text: "test note",
      tags: [],
      fileRefs: [],
      importance: 0.5,
    });

    const before = Date.now();
    await new Promise((r) => setTimeout(r, 10));
    await store.touch(id);
    await new Promise((r) => setTimeout(r, 10));
    const after = Date.now();

    const store2 = new MdMemoryStore(testDir);
    const hits = await store2.search({ q: "test note", topK: 4 });
    expect(hits[0].id).toBe(id);
  });

  it("should handle empty files gracefully", async () => {
    await fs.mkdir(testDir, { recursive: true });
    await fs.writeFile(`${testDir}/working.md`, "<!-- layer: working | version: 1 -->\n", "utf-8");

    const store2 = new MdMemoryStore(testDir);
    const hits = await store2.search({ q: "anything", topK: 4 });
    expect(hits).toHaveLength(0);
  });

  it("should handle missing files gracefully", async () => {
    const hits = await store.search({ q: "anything", topK: 4 });
    expect(hits).toHaveLength(0);
  });

  it("should return correct layer in search results", async () => {
    await store.put({
      layer: "episodic",
      kind: "case",
      text: "test case",
      tags: [],
      fileRefs: [],
      importance: 0.8,
    });

    const hits = await store.search({ q: "test case", topK: 4 });
    expect(hits[0].layer).toBe("episodic");
  });

  it("should handle Chinese text in search", async () => {
    await store.put({
      layer: "episodic",
      kind: "case",
      text: "修复了用户登录验证的问题",
      tags: ["bugfix"],
      fileRefs: [],
      importance: 0.9,
    });

    const hits = await store.search({ q: "登录验证", topK: 4 });
    expect(hits).toHaveLength(1);
    expect(hits[0].text).toContain("登录验证");
  });

  it("should score exact phrase match higher than partial match", async () => {
    await store.put({
      layer: "episodic",
      kind: "case",
      text: "fix email validation bug in user registration",
      tags: [],
      fileRefs: [],
      importance: 0.7,
    });

    await store.put({
      layer: "episodic",
      kind: "case",
      text: "email is a common communication tool",
      tags: [],
      fileRefs: [],
      importance: 0.7,
    });

    const hits = await store.search({ q: "email validation", topK: 4 });
    expect(hits).toHaveLength(2);
    expect(hits[0].text).toContain("email validation bug");
  });

  it("should preserve commit hash", async () => {
    await store.put({
      layer: "working",
      kind: "note",
      text: "success commit",
      tags: ["success"],
      fileRefs: [],
      importance: 0.8,
      commitHash: "abc1234",
    });

    const content = await fs.readFile(`${testDir}/working.md`, "utf-8");
    expect(content).toContain("- commit: abc1234");

    const store2 = new MdMemoryStore(testDir);
    const hits = await store2.search({ q: "success commit", topK: 4 });
    expect(hits).toHaveLength(1);
  });
});
