import { OpenAiClient } from "../ai/openai-client.js";
import { loadEnv } from "../config/env.js";
import type { MemoryStore } from "../memory/memory-store.js";
import { SqliteMemoryStore } from "../memory/sqlite-memory-store.js";
import { PatchEngine } from "../patch/patch-engine.js";
import { DependencyGraphBuilder } from "../repo/dependency-graph.js";
import { FsIndexer } from "../repo/fs-indexer.js";
import { DefaultHybridRetriever } from "../retrieve/default-hybrid-retriever.js";
import { GraphRetriever } from "../retrieve/graph-retriever.js";
import { KeywordRetriever } from "../retrieve/keyword-retriever.js";
import { Reranker } from "../retrieve/reranker.js";
import { VectorRetriever } from "../retrieve/vector-retriever.js";
import { EmbeddingCache } from "../storage/embedding-cache.js";
import { createSqlite } from "../storage/sqlite.js";
import { CommandRunner } from "../tools/command-runner.js";
import { GitTools } from "../tools/git-tools.js";
import { SearchTools } from "../tools/search-tools.js";
import { logger } from "../utils/logger.js";
import { Verifier } from "../verify/verifier.js";
import { Orchestrator } from "./orchestrator.js";

export async function buildContainer(cwd = process.cwd()): Promise<Orchestrator> {
  logger.info({ cwd }, "building agent container");
  const env = loadEnv();
  const db = createSqlite(env.DB_PATH);
  const llm = new OpenAiClient(
    env.OPENAI_API_KEY,
    env.OPENAI_MODEL,
    env.OPENAI_EMBEDDING_MODEL,
    env.OPENAI_BASE_URL,
    env.OPENAI_EMBEDDING_API_KEY,
    env.OPENAI_EMBEDDING_BASE_URL
  );

  const embeddingCache = new EmbeddingCache(db);
  const memory: MemoryStore = new SqliteMemoryStore(
    db,
    // (texts) => llm.embed(texts),
    // embeddingCache
  );

  const commandRunner = new CommandRunner(cwd);
  const searchTools = new SearchTools(cwd, commandRunner);
  const fsIndexer = new FsIndexer(cwd);
  const graphRetriever = new GraphRetriever(new DependencyGraphBuilder(), fsIndexer);
  logger.info("warming up dependency graph");
  await graphRetriever.warmup();
  logger.info("dependency graph ready");

  const vectorRetriever = new VectorRetriever(
    fsIndexer,
    (texts) => Promise.resolve([]), // (texts) => llm.embed(texts),
    embeddingCache
  );
  const retriever = new DefaultHybridRetriever(
    new KeywordRetriever(searchTools),
    vectorRetriever,
    graphRetriever,
    new Reranker()
  );

  const patchEngine = new PatchEngine(cwd, commandRunner);
  const verifier = new Verifier(commandRunner, cwd);
  const gitTools = new GitTools(commandRunner);

  return new Orchestrator(llm, retriever, memory, patchEngine, verifier, gitTools, vectorRetriever, {
    retrieveTopK: env.RETRIEVE_TOP_K,
    contextCharBudget: env.CONTEXT_CHAR_BUDGET,
  });
}
