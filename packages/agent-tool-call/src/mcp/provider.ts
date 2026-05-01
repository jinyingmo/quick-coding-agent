import { z } from 'zod'
import type { Tool, ToolResult } from '../types.js'
import type { CapabilityProvider, CapabilityProviderContext } from '../capabilities/types.js'
import type { MCPServerConfig } from './config.js'
import { MCPManager, type MCPRemoteTool } from './manager.js'

const passthroughObject = z.object({}).passthrough()

export type MCPProviderOptions = {
  servers: MCPServerConfig[]
}

type MCPToolCallResult = {
  content?: Array<{ type?: string; text?: string }>
  structuredContent?: unknown
  isError?: boolean
}

function sanitizeName(input: string): string {
  return input.replace(/[^a-zA-Z0-9_\-]/g, '_')
}

function toDisplay(result: MCPToolCallResult): string {
  const chunks: string[] = []

  if (Array.isArray(result.content)) {
    for (const item of result.content) {
      if (item && typeof item.text === 'string' && item.text.length > 0) {
        chunks.push(item.text)
      }
    }
  }

  if (chunks.length === 0 && result.structuredContent !== undefined) {
    chunks.push(JSON.stringify(result.structuredContent, null, 2))
  }

  if (chunks.length === 0) {
    return '(mcp tool returned no content)'
  }
  return chunks.join('\n\n')
}

function adaptTool(
  serverName: string,
  remote: MCPRemoteTool,
  manager: MCPManager,
): Tool<typeof passthroughObject, unknown> {
  const safeServer = sanitizeName(serverName)
  const safeTool = sanitizeName(remote.name)
  const exportedName = `mcp__${safeServer}__${safeTool}`
  const jsonSchema =
    remote.inputSchema && typeof remote.inputSchema === 'object'
      ? remote.inputSchema
      : { type: 'object', additionalProperties: true }

  return {
    name: exportedName,
    source: 'mcp',
    metadata: {
      server: serverName,
      originalName: remote.name,
      title: remote.title,
    },
    description:
      `[MCP:${serverName}] ${remote.description ?? remote.title ?? remote.name}`,
    inputSchema: passthroughObject,
    jsonSchema,
    isReadOnly: () => false,
    async call(input, ctx): Promise<ToolResult<unknown>> {
      const result = (await manager.callTool(serverName, remote.name, input)) as MCPToolCallResult
      const display = toDisplay(result)
      ctx.log(
        `[mcp:${serverName}] tool=${remote.name} exported=${exportedName} error=${result?.isError === true}`,
        result?.isError ? 'warn' : 'info',
      )
      return {
        data: result,
        display,
        isError: result?.isError === true,
      }
    },
  }
}

export function createMCPProvider(opts: MCPProviderOptions): CapabilityProvider {
  let manager: MCPManager | undefined

  return {
    id: 'mcp',
    source: 'mcp',
    async getTools(ctx: CapabilityProviderContext): Promise<Tool[]> {
      if (opts.servers.length === 0) return []

      if (!manager) {
        manager = new MCPManager({
          servers: opts.servers,
          cwd: ctx.cwd,
          log: ctx.log,
        })
      }

      const catalogs = await manager.listAllTools()
      const tools: Tool[] = []
      for (const catalog of catalogs) {
        for (const remote of catalog.tools) {
          if (!remote.name || typeof remote.name !== 'string') continue
          tools.push(adaptTool(catalog.server, remote, manager))
        }
      }
      return tools
    },
    async dispose() {
      if (manager) {
        await manager.dispose()
        manager = undefined
      }
    },
  }
}
