/** 中文说明：核心 agent 模块。 */

import { resolve } from 'path'
import type { CanUseToolFn, PermissionResult, Tool, ToolUseContext } from './types.js'

/** 默认的权限函数，允许所有工具调用，不修改输入。 */
export const allowAllPermission: CanUseToolFn = async (_tool, input) => ({
  behavior: 'allow',
  updatedInput: input,
})

/** 创建权限限制函数：只读工具直接允许，写入工具仅允许在 memoryDir 目录内操作。 */
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
