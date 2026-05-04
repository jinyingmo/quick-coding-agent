#!/usr/bin/env node
// Load .env from the workspace root (two levels up from packages/agent-cli/dist/)
import { config as loadEnv } from "dotenv";
loadEnv({ path: new URL("./.env", import.meta.url).pathname });
import { render } from "ink";
import React from "react";
import { resolve } from "path";
import { loadMCPSettingsFromEnv } from "@quick-coding-agent/agent-tool-call";
import { App } from "./components/App.js";

async function main() {
  if (!process.stdout.isTTY) {
    console.error(
      "[agent-cli] Not a TTY — interactive REPL requires a terminal.",
    );
    process.exit(1);
  }

  if (!process.env.LLM_API_KEY) {
    console.error("[!] LLM_API_KEY is not set.");
    console.error("    cp .env.example .env  and fill in your key.");
    process.exit(1);
  }

  const memoryDir = resolve(
    process.env.MEMORY_DIR ?? new URL("../memory", import.meta.url).pathname,
  );

  const agentOpts = {
    cwd: process.cwd(),
    memoryDir,
    mcpSettings: await loadMCPSettingsFromEnv(),
  };

  const { waitUntilExit } = render(React.createElement(App, { agentOpts }));
  await waitUntilExit();
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
