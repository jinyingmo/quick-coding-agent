/** 中文说明：MCP 集成模块。 */

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
  allowedTools: string[]
}

// 从 JSON 字符串中解析 MCP 服务器配置数组
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

// 类型守卫：检查值是否为 Record<string, string> 类型
function isStringMap(v: unknown): v is Record<string, string> {
  if (!v || typeof v !== 'object') return false
  return Object.values(v).every(x => typeof x === 'string')
}

/** 从环境变量 MCP_SERVERS 或 MCP_SERVERS_FILE 中加载 MCP 设置 */
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

  const allowedTools = (process.env.MCP_ALLOWED_TOOLS ?? '')
    .split(',')
    .map(x => x.trim())
    .filter(Boolean)

  const enabledFlag = (process.env.MCP_ENABLED ?? '').trim().toLowerCase()
  const enabled =
    enabledFlag === '1' || enabledFlag === 'true' || enabledFlag === 'yes'
      ? true
      : enabledFlag === '0' || enabledFlag === 'false' || enabledFlag === 'no'
        ? false
        : servers.length > 0 && allowedTools.length > 0

  return {
    enabled,
    servers,
    allowedTools,
  }
}
