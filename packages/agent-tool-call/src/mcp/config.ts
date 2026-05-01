import { readFile } from 'fs/promises'
import { resolve } from 'path'

export type MCPServerConfig = {
  name: string
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  startupTimeoutMs?: number
  toolTimeoutMs?: number
}

export type MCPSettings = {
  enabled: boolean
  servers: MCPServerConfig[]
}

function parseServers(raw: string): MCPServerConfig[] {
  const parsed = JSON.parse(raw) as unknown
  if (!Array.isArray(parsed)) {
    throw new Error('MCP servers config must be a JSON array')
  }

  return parsed.map((item, idx) => {
    if (!item || typeof item !== 'object') {
      throw new Error(`MCP server at index ${idx} is not an object`)
    }
    const obj = item as Record<string, unknown>

    if (typeof obj.name !== 'string' || obj.name.length === 0) {
      throw new Error(`MCP server at index ${idx} missing non-empty name`)
    }
    if (typeof obj.command !== 'string' || obj.command.length === 0) {
      throw new Error(`MCP server ${obj.name} missing non-empty command`)
    }

    return {
      name: obj.name,
      command: obj.command,
      args: Array.isArray(obj.args)
        ? obj.args.filter((v): v is string => typeof v === 'string')
        : undefined,
      env: isStringMap(obj.env) ? obj.env : undefined,
      cwd: typeof obj.cwd === 'string' ? obj.cwd : undefined,
      startupTimeoutMs:
        typeof obj.startupTimeoutMs === 'number' ? obj.startupTimeoutMs : undefined,
      toolTimeoutMs: typeof obj.toolTimeoutMs === 'number' ? obj.toolTimeoutMs : undefined,
    } satisfies MCPServerConfig
  })
}

function isStringMap(v: unknown): v is Record<string, string> {
  if (!v || typeof v !== 'object') return false
  return Object.values(v).every(x => typeof x === 'string')
}

export async function loadMCPSettingsFromEnv(): Promise<MCPSettings> {
  const fromEnv = process.env.MCP_SERVERS
  const fromFile = process.env.MCP_SERVERS_FILE

  let servers: MCPServerConfig[] = []
  if (fromEnv && fromEnv.trim().length > 0) {
    servers = parseServers(fromEnv)
  } else if (fromFile && fromFile.trim().length > 0) {
    const path = resolve(fromFile)
    const content = await readFile(path, 'utf-8')
    servers = parseServers(content)
  }

  const enabledFlag = (process.env.MCP_ENABLED ?? '').trim().toLowerCase()
  const enabled =
    enabledFlag === '1' || enabledFlag === 'true' || enabledFlag === 'yes'
      ? true
      : enabledFlag === '0' || enabledFlag === 'false' || enabledFlag === 'no'
        ? false
        : servers.length > 0

  return {
    enabled,
    servers,
  }
}
