import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { resolveToolsFromProviders } from '../src/capabilities/resolveTools.js'
import type { CapabilityProvider } from '../src/capabilities/types.js'
import type { Tool } from '../src/types.js'

function makeTool(name: string): Tool {
  return {
    name,
    description: name,
    inputSchema: z.object({}).passthrough(),
    isReadOnly: () => true,
    call: async () => ({ data: {}, display: 'ok' }),
  }
}

describe('resolveToolsFromProviders', () => {
  it('aggregates tools from multiple providers and dedupes by name', async () => {
    const providers: CapabilityProvider[] = [
      {
        id: 'p1',
        source: 'local',
        async getTools() {
          return [makeTool('a'), makeTool('b')]
        },
      },
      {
        id: 'p2',
        source: 'mcp',
        async getTools() {
          return [makeTool('b'), makeTool('c')]
        },
      },
    ]

    const result = await resolveToolsFromProviders(providers, {
      cwd: process.cwd(),
      memoryDir: process.cwd(),
      log: () => undefined,
    })

    expect(result.errors).toEqual([])
    expect(result.tools.map(t => t.name)).toEqual(['a', 'b', 'c'])
  })

  it('isolates provider failures and continues', async () => {
    const providers: CapabilityProvider[] = [
      {
        id: 'ok',
        source: 'local',
        async getTools() {
          return [makeTool('safe')]
        },
      },
      {
        id: 'bad',
        source: 'mcp',
        async getTools() {
          throw new Error('boom')
        },
      },
    ]

    const result = await resolveToolsFromProviders(providers, {
      cwd: process.cwd(),
      memoryDir: process.cwd(),
      log: () => undefined,
    })

    expect(result.tools.map(t => t.name)).toEqual(['safe'])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('provider=bad failed')
  })
})
