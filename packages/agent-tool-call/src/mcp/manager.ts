import { randomUUID } from 'crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import type { ToolUseContext } from '../types.js'
import type { MCPServerConfig } from './config.js'

type JSONValue = string | number | boolean | null | JSONObject | JSONArray
type JSONObject = { [k: string]: JSONValue }
type JSONArray = JSONValue[]

type JSONRPCRequest = {
  jsonrpc: '2.0'
  id: string
  method: string
  params?: JSONObject
}

type JSONRPCResponse = {
  jsonrpc?: '2.0'
  id?: string
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
  method?: string
}

export type MCPRemoteTool = {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
  title?: string
}

export type MCPManagerOptions = {
  servers: MCPServerConfig[]
  cwd: string
  log: ToolUseContext['log']
}

type PendingCall = {
  resolve: (result: unknown) => void
  reject: (err: Error) => void
  timeout: NodeJS.Timeout
}

class MCPServerSession {
  readonly server: MCPServerConfig
  private readonly proc: ChildProcessWithoutNullStreams
  private readonly log: ToolUseContext['log']
  private readonly pending = new Map<string, PendingCall>()
  private readonly startupTimeoutMs: number
  private buffer = Buffer.alloc(0)
  private initialized = false
  private closed = false

  constructor(server: MCPServerConfig, cwd: string, log: ToolUseContext['log']) {
    this.server = server
    this.log = log
    this.startupTimeoutMs = server.startupTimeoutMs ?? 15_000

    this.proc = spawn(server.command, server.args ?? [], {
      cwd: server.cwd ?? cwd,
      env: { ...process.env, ...(server.env ?? {}) },
      stdio: 'pipe',
    })

    this.proc.stdout.on('data', chunk => this.onStdout(chunk as Buffer))
    this.proc.stderr.on('data', chunk => {
      this.log(`[mcp:${server.name}] stderr: ${(chunk as Buffer).toString('utf-8').trim()}`, 'debug')
    })

    this.proc.on('exit', (code, signal) => {
      this.closed = true
      const reason = `MCP server exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`
      this.log(`[mcp:${server.name}] ${reason}`, code === 0 ? 'debug' : 'warn')
      this.rejectAllPending(new Error(`[mcp:${server.name}] ${reason}`))
    })

    this.proc.on('error', err => {
      this.closed = true
      this.rejectAllPending(err)
    })
  }

  async initialize(): Promise<void> {
    if (this.initialized) return

    const initResult = await this.request(
      'initialize',
      {
        protocolVersion: '2025-03-26',
        capabilities: {
          roots: {
            listChanged: false,
          },
          sampling: {},
        },
        clientInfo: {
          name: 'quick-coding-agent',
          version: '1.0.0',
        },
      },
      this.startupTimeoutMs,
    )

    this.log(
      `[mcp:${this.server.name}] initialized (${typeof initResult === 'object' ? 'ok' : 'unknown'})`,
      'info',
    )

    this.notify('notifications/initialized', {})
    this.initialized = true
  }

  async listTools(): Promise<MCPRemoteTool[]> {
    await this.initialize()

    const tools: MCPRemoteTool[] = []
    let cursor: string | undefined

    while (true) {
      const params = cursor ? ({ cursor } as JSONObject) : undefined
      const result = (await this.request(
        'tools/list',
        params,
        this.server.toolTimeoutMs ?? 20_000,
      )) as {
        tools?: MCPRemoteTool[]
        nextCursor?: string
      }

      if (Array.isArray(result.tools)) {
        tools.push(...result.tools)
      }

      if (!result.nextCursor) break
      cursor = result.nextCursor
    }

    return tools
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    await this.initialize()
    return this.request(
      'tools/call',
      {
        name,
        arguments: args as JSONObject,
      },
      this.server.toolTimeoutMs ?? 30_000,
    )
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.proc.kill('SIGTERM')
    this.rejectAllPending(new Error(`[mcp:${this.server.name}] closed`))
  }

  private onStdout(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])

    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n')
      if (headerEnd < 0) return

      const headerRaw = this.buffer.subarray(0, headerEnd).toString('utf-8')
      const contentLength = this.parseContentLength(headerRaw)
      if (contentLength <= 0) {
        this.log(`[mcp:${this.server.name}] invalid Content-Length header`, 'warn')
        this.buffer = Buffer.alloc(0)
        return
      }

      const frameEnd = headerEnd + 4 + contentLength
      if (this.buffer.length < frameEnd) return

      const body = this.buffer.subarray(headerEnd + 4, frameEnd).toString('utf-8')
      this.buffer = this.buffer.subarray(frameEnd)

      let msg: JSONRPCResponse
      try {
        msg = JSON.parse(body) as JSONRPCResponse
      } catch (err) {
        this.log(
          `[mcp:${this.server.name}] failed to parse JSON-RPC frame: ${(err as Error).message}`,
          'warn',
        )
        continue
      }

      this.handleMessage(msg)
    }
  }

  private handleMessage(msg: JSONRPCResponse): void {
    if (typeof msg.id === 'string') {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      clearTimeout(p.timeout)

      if (msg.error) {
        p.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`))
        return
      }
      p.resolve(msg.result)
      return
    }

    // server notification/event
    if (msg.method) {
      this.log(`[mcp:${this.server.name}] notification: ${msg.method}`, 'debug')
    }
  }

  private parseContentLength(headerRaw: string): number {
    const lines = headerRaw.split('\r\n')
    for (const line of lines) {
      const idx = line.indexOf(':')
      if (idx < 0) continue
      const key = line.slice(0, idx).trim().toLowerCase()
      const value = line.slice(idx + 1).trim()
      if (key === 'content-length') {
        const n = Number.parseInt(value, 10)
        return Number.isFinite(n) ? n : -1
      }
    }
    return -1
  }

  private request(method: string, params: JSONObject | undefined, timeoutMs: number): Promise<unknown> {
    if (this.closed) {
      throw new Error(`[mcp:${this.server.name}] session is closed`)
    }

    const id = randomUUID()
    const req: JSONRPCRequest = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params ? { params } : {}),
    }

    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`[mcp:${this.server.name}] request timeout: ${method}`))
      }, timeoutMs)

      this.pending.set(id, { resolve, reject, timeout })
      this.writeFrame(req)
    })
  }

  private notify(method: string, params: JSONObject): void {
    if (this.closed) return
    this.writeFrame({ jsonrpc: '2.0', method, params } as Record<string, unknown>)
  }

  private writeFrame(payload: Record<string, unknown>): void {
    const json = JSON.stringify(payload)
    const len = Buffer.byteLength(json, 'utf-8')
    const frame = `Content-Length: ${len}\r\n\r\n${json}`
    this.proc.stdin.write(frame)
  }

  private rejectAllPending(err: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timeout)
      pending.reject(err)
      this.pending.delete(id)
    }
  }
}

export type MCPToolCatalog = {
  server: string
  tools: MCPRemoteTool[]
}

export class MCPManager {
  private readonly sessions = new Map<string, MCPServerSession>()
  private readonly opts: MCPManagerOptions

  constructor(opts: MCPManagerOptions) {
    this.opts = opts
  }

  async listAllTools(): Promise<MCPToolCatalog[]> {
    if (this.opts.servers.length === 0) return []

    const out: MCPToolCatalog[] = []
    for (const server of this.opts.servers) {
      const session = this.getOrCreateSession(server)
      const tools = await session.listTools()
      out.push({ server: server.name, tools })
    }
    return out
  }

  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const session = this.sessions.get(serverName)
    if (!session) {
      throw new Error(`MCP server not connected: ${serverName}`)
    }
    return session.callTool(toolName, args)
  }

  async dispose(): Promise<void> {
    for (const session of this.sessions.values()) {
      session.close()
    }
    this.sessions.clear()
  }

  private getOrCreateSession(server: MCPServerConfig): MCPServerSession {
    const existing = this.sessions.get(server.name)
    if (existing) return existing

    const session = new MCPServerSession(server, this.opts.cwd, this.opts.log)
    this.sessions.set(server.name, session)
    return session
  }
}
