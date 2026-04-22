/**
 * Permission strategies (CanUseToolFn).
 *
 * Mirrors `createAutoMemCanUseTool` in
 * `src/services/extractMemories/extractMemories.ts`:
 *
 *   - The main agent uses `allowAllPermission`: any tool, any input.
 *   - The background extractor uses `restrictToMemoryDirPermission(memoryDir)`:
 *     reads/lists are unrestricted, but writes are only allowed when the
 *     `file_path` falls inside the auto-memory directory.
 *
 * The CanUseToolFn is the single chokepoint where every tool_use input is
 * validated before `tool.call()` is invoked, so adding new policies is just
 * a matter of writing another factory here.
 */

import { resolve } from 'path'
import type { CanUseToolFn, PermissionResult, Tool, ToolUseContext } from './types.js'

/** Permissive policy used by the main agent. */
export const allowAllPermission: CanUseToolFn = async (_tool, input) => ({
  behavior: 'allow',
  updatedInput: input,
})

/**
 * Build a CanUseToolFn that constrains writes to a single directory.
 *
 *   - Read-only tools (`tool.isReadOnly(input) === true`) are always allowed.
 *   - Write/edit tools are allowed only when their input contains a
 *     `file_path` field that resolves under `memoryDir`.
 *   - Anything else is denied with an explanatory message that gets sent
 *     back to the model as the tool_result content (so the model can
 *     self-correct without aborting the turn).
 *
 * Mirrors `createAutoMemCanUseTool` in the parent project, including the
 * "send the rejection reason back to the model" pattern.
 */
export function restrictToMemoryDirPermission(memoryDir: string): CanUseToolFn {
  const memRoot = resolve(memoryDir) + '/'

  return async function canUseTool(
    tool: Tool,
    input: Record<string, unknown>,
    ctx: ToolUseContext,
  ): Promise<PermissionResult> {
    const parsed = tool.inputSchema.safeParse(input)
    if (!parsed.success) {
      return {
        behavior: 'deny',
        message: `Invalid input for ${tool.name}: ${parsed.error.message}`,
      }
    }

    if (tool.isReadOnly(parsed.data)) {
      return { behavior: 'allow', updatedInput: input }
    }

    const filePath = (input as { file_path?: unknown }).file_path
    if (typeof filePath === 'string') {
      const abs = resolve(filePath)
      if (abs === memRoot.replace(/\/$/, '') || abs.startsWith(memRoot)) {
        return { behavior: 'allow', updatedInput: input }
      }
      ctx.log(
        `[permission] denied ${tool.name} write to ${abs} (outside ${memRoot})`,
        'warn',
      )
      return {
        behavior: 'deny',
        message: `Write denied: ${abs} is outside the auto-memory directory ${memRoot}. Background memory extraction can only write inside the memory directory.`,
      }
    }

    return {
      behavior: 'deny',
      message: `Tool ${tool.name} is not permitted in this context (only read-only tools and writes inside ${memRoot}).`,
    }
  }
}
