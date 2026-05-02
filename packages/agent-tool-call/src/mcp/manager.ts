/** 中文说明：MCP 集成模块。 */

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

  /** 创建 MCP 服务端会话，启动子进程并通过 stdio 管道通信 */
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

  /** 初始化 MCP 会话：发送 initialize 请求并通知已初始化 */
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

  /** 列出远程 MCP 服务器提供的所有工具（支持分页游标） */
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

  /** 调用远程 MCP 工具的指定方法并传入参数 */
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

  /** 关闭 MCP 会话：发送 SIGTERM 并拒绝所有待处理请求 */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.proc.kill('SIGTERM')
    this.rejectAllPending(new Error(`[mcp:${this.server.name}] closed`))
  }

  // 处理子进程 stdout 数据：根据 Content-Length 帧协议拆包并分发消息
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

  // 处理收到的 JSON-RPC 消息：根据 id 关联到待处理请求，或记录服务器通知
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

  // 从帧头部解析 Content-Length 头字段的值
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

  // 发送 JSON-RPC 请求并返回 Promise，支持超时处理
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

  // 发送 JSON-RPC 通知（无 id 字段，无需响应）
  private notify(method: string, params: JSONObject): void {
    if (this.closed) return
    this.writeFrame({ jsonrpc: '2.0', method, params } as Record<string, unknown>)
  }

  // 按照 JSON-RPC 帧协议写数据到子进程 stdin
  private writeFrame(payload: Record<string, unknown>): void {
    const json = JSON.stringify(payload)
    const len = Buffer.byteLength(json, 'utf-8')
    const frame = `Content-Length: ${len}\r\n\r\n${json}`
    this.proc.stdin.write(frame)
  }

  // 拒绝所有待处理的请求（通常在会话关闭或出错时调用）
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

  /** 创建 MCP 管理器 */
  constructor(opts: MCPManagerOptions) {
    this.opts = opts
  }

  /** 列出所有已配置 MCP 服务器的工具目录 */
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

  /** 调用指定 MCP 服务器上的工具方法 */
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

  /** 释放所有 MCP 会话连接 */
  async dispose(): Promise<void> {
    for (const session of this.sessions.values()) {
      session.close()
    }
    this.sessions.clear()
  }

  // 获取或创建指定 MCP 服务器的会话实例
  private getOrCreateSession(server: MCPServerConfig): MCPServerSession {
    const existing = this.sessions.get(server.name)
    if (existing) return existing

    const session = new MCPServerSession(server, this.opts.cwd, this.opts.log)
    this.sessions.set(server.name, session)
    return session
  }
}
