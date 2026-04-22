/**
 * Built-in tool registry.
 *
 * The order matters only for display in the system prompt — runtime lookup
 * is by `tool.name`. The agent uses this set as its default capability
 * surface; extractor agents pass the same array but a stricter CanUseToolFn.
 *
 * Coding-agent tools (new additions):
 *   bash      — execute shell commands (build, test, install, git…)
 *   edit_file — precise find-and-replace editing (preferred over write_file for mutations)
 *   glob      — find files by pattern
 *   grep      — search file contents with regex
 *
 * Original tools (retained):
 *   read_file     — read a text file
 *   write_file    — create or fully overwrite a file
 *   list_dir      — list directory contents
 *   search_memory — semantic search over the memory directory
 */

import type { Tool } from '../types.js'
import { bashTool } from './bash.js'
import { editFileTool } from './editFile.js'
import { globTool } from './glob.js'
import { grepTool } from './grep.js'
import { listDirTool } from './listDir.js'
import { readFileTool } from './readFile.js'
import { searchMemoryTool } from './searchMemory.js'
import { writeFileTool } from './writeFile.js'

export const ALL_TOOLS: Tool[] = [
  // ── Read / navigate ────────────────────────────────────────────────────────
  readFileTool,
  listDirTool,
  globTool,
  grepTool,
  // ── Write / edit ───────────────────────────────────────────────────────────
  editFileTool,
  writeFileTool,
  // ── Execution ──────────────────────────────────────────────────────────────
  bashTool,
  // ── Memory ─────────────────────────────────────────────────────────────────
  searchMemoryTool,
]

export function findToolByName(name: string): Tool | undefined {
  return ALL_TOOLS.find(t => t.name === name)
}

export {
  bashTool,
  editFileTool,
  globTool,
  grepTool,
  listDirTool,
  readFileTool,
  searchMemoryTool,
  writeFileTool,
}
