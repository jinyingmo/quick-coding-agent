/** 中文说明：能力提供器模块。 */

import type { Tool } from '../types.js'
import type { CapabilityProvider, CapabilityProviderContext } from './types.js'

export type CapabilityResolveResult = {
  tools: Tool[]
  errors: string[]
}

/**
 * 从所有提供器收集工具列表，单个提供器故障不会阻塞主流程。
 * 返回去重后的工具列表及错误信息。
 *
 * Resolve tools from all providers. Provider failures are isolated and surfaced
 * via `errors` so one bad provider does not block the main agent.
 */
export async function resolveToolsFromProviders(
  providers: CapabilityProvider[],
  ctx: CapabilityProviderContext,
): Promise<CapabilityResolveResult> {
  const tools: Tool[] = []
  const errors: string[] = []

  for (const provider of providers) {
    try {
      const provided = await provider.getTools(ctx)
      tools.push(...provided)
      ctx.log(
        `[capabilities] provider=${provider.id} source=${provider.source} tools=${provided.length}`,
        'debug',
      )
    } catch (err) {
      const msg = `[capabilities] provider=${provider.id} failed: ${(err as Error).message}`
      errors.push(msg)
      ctx.log(msg, 'warn')
    }
  }

  const deduped = dedupeByName(tools)
  if (deduped.length !== tools.length) {
    ctx.log(
      `[capabilities] deduped tool names: ${tools.length} -> ${deduped.length}`,
      'warn',
    )
  }

  return { tools: deduped, errors }
}

// 按工具名去重，保留首次出现的版本
function dedupeByName(tools: Tool[]): Tool[] {
  const seen = new Set<string>()
  const out: Tool[] = []
  for (const tool of tools) {
    if (seen.has(tool.name)) continue
    seen.add(tool.name)
    out.push(tool)
  }
  return out
}
