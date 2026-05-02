/** 中文说明：工具层模块。 */

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
 *
 * 中文说明：内置工具注册表，包含所有可用工具的数组及按名称查找工具的函数。
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

/** 按工具名称在 ALL_TOOLS 数组中查找并返回对应工具，未找到返回 undefined。 */
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
