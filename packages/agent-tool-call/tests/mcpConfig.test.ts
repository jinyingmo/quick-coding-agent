import { describe, expect, it } from 'vitest'
import { loadMCPSettingsFromEnv } from '../src/mcp/config.js'

describe('loadMCPSettingsFromEnv', () => {
  it('loads servers from MCP_SERVERS json', async () => {
    const prevServers = process.env.MCP_SERVERS
    const prevEnabled = process.env.MCP_ENABLED

    process.env.MCP_SERVERS = JSON.stringify([
      { name: 'fs', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'] },
    ])
    process.env.MCP_ENABLED = 'true'

    const cfg = await loadMCPSettingsFromEnv()
    expect(cfg.enabled).toBe(true)
    expect(cfg.servers).toHaveLength(1)
    expect(cfg.servers[0]?.name).toBe('fs')

    process.env.MCP_SERVERS = prevServers
    process.env.MCP_ENABLED = prevEnabled
  })

  it('defaults disabled when no servers configured', async () => {
    const prevServers = process.env.MCP_SERVERS
    const prevFile = process.env.MCP_SERVERS_FILE
    const prevEnabled = process.env.MCP_ENABLED

    delete process.env.MCP_SERVERS
    delete process.env.MCP_SERVERS_FILE
    delete process.env.MCP_ENABLED

    const cfg = await loadMCPSettingsFromEnv()
    expect(cfg.enabled).toBe(false)
    expect(cfg.servers).toEqual([])

    process.env.MCP_SERVERS = prevServers
    process.env.MCP_SERVERS_FILE = prevFile
    process.env.MCP_ENABLED = prevEnabled
  })
})
