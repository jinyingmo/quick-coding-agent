import type { Tool } from '../types.js'
import type { CapabilityProvider, CapabilityProviderContext } from './types.js'

export type CapabilityResolveResult = {
  tools: Tool[]
  errors: string[]
}

/**
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
