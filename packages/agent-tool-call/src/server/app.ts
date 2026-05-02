/** 中文说明：P0 HTTP(S) 服务模块。 */

import { createServer, type IncomingMessage, type RequestListener, type ServerResponse } from 'http'
import { createServer as createHttpsServer } from 'https'
import type { Server } from 'http'
import type { Server as HttpsServer } from 'https'
import { randomUUID } from 'crypto'
import { findIdentityByBearerToken, type ApiKeyIdentity } from '../auth/apiKey.js'
import type { AgentRuntime } from '../runtime/agentRuntime.js'
import type { Logger } from '../observability/logger.js'
import { SessionNotFoundError } from '../runtime/errors.js'

export type TLSConfig = {
  /** PEM 格式证书文件路径或证书内容 */
  cert: string
  /** PEM 格式私钥文件路径或私钥内容 */
  key: string
  /** 可选：CA 证书链 */
  ca?: string
  /** 可选：是否要求客户端证书 */
  requestCert?: boolean
}

export type P0ServerConfig = {
  runtime: AgentRuntime
  identities: ApiKeyIdentity[]
  logger: Logger
  /** TLS 配置。不提供时使用纯 HTTP。 */
  tls?: TLSConfig
  /** 请求超时时间（毫秒），默认 120000（2 分钟） */
  requestTimeout?: number
  /** HTTP headers 超时时间（毫秒），默认 60000（1 分钟） */
  headersTimeout?: number
  /** CORS 允许的来源，如 'https://example.com'。设置后添加 CORS 头。 */
  corsOrigin?: string
}

// 从 Markdown 响应体中提取纯文本内容
function extractReplyText(data: unknown): string {
  if (!data || typeof data !== 'object') return ''
  const d = data as Record<string, unknown>
  return typeof d.reply === 'string' ? d.reply : ''
}

// 发送流式 (SSE) 响应
function startSSEStream(res: ServerResponse, requestId: string): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    'connection': 'keep-alive',
    'x-request-id': requestId,
  })
}

// 发送 JSON 事件到 SSE 流
function sendSSEEvent(res: ServerResponse, event: string, data: Record<string, unknown>): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

// 发送 JSON 响应
function sendJson(
  res: ServerResponse,
  statusCode: number,
  requestId: string,
  data: unknown,
  error: unknown = null,
  headers: Record<string, string> = {},
): void {
  const body = JSON.stringify({ request_id: requestId, data, error })
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'x-request-id': requestId,
    ...headers,
  })
  res.end(body)
}

// 从 HTTP 请求中读取并解析 JSON 请求体
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  if (chunks.length === 0) return {}
  const raw = Buffer.concat(chunks).toString('utf-8')
  return JSON.parse(raw) as Record<string, unknown>
}

// 发送 401 未授权响应
function unauthorized(res: ServerResponse, requestId: string): void {
  sendJson(res, 401, requestId, null, { code: 'UNAUTHORIZED', message: 'Missing or invalid bearer token.' })
}

// 检查身份标识的工作空间与目标会话的工作空间是否一致
function ensureSessionAccess<T extends { workspaceId: string }>(
  identity: ApiKeyIdentity,
  session: T,
): boolean {
  return identity.workspaceId === session.workspaceId
}

/** 创建 P0 HTTP 请求处理器：路由分发到 session、messages、approvals、流式 等端点。 */
export function createP0RequestHandler(params: {
  runtime: AgentRuntime
  identities: ApiKeyIdentity[]
  logger: Logger
  corsOrigin?: string
}): RequestListener {
  // 构建 CORS 相关响应头
  function corsHeaders(): Record<string, string> {
    if (!params.corsOrigin) return {}
    return {
      'access-control-allow-origin': params.corsOrigin,
      'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
      'access-control-allow-headers': 'authorization, content-type, x-request-id',
      'access-control-max-age': '86400',
    }
  }

  return async (req, res) => {
    const requestId = randomUUID()
    const url = new URL(req.url ?? '/', 'http://localhost')
    const method = req.method ?? 'GET'
    const log = params.logger.child({ request_id: requestId, path: url.pathname, method })

    // CORS 预检请求
    if (method === 'OPTIONS') {
      res.writeHead(204, corsHeaders())
      return res.end()
    }

    if (url.pathname === '/healthz') {
      return sendJson(res, 200, requestId, { ok: true }, null, corsHeaders())
    }

    const identity = findIdentityByBearerToken(req.headers.authorization, params.identities)
    if (!identity) {
      log.warn('auth_failed')
      return unauthorized(res, requestId)
    }

    try {
      if (method === 'POST' && url.pathname === '/sessions') {
        const session = params.runtime.createSession({
          userId: identity.userId,
          workspaceId: identity.workspaceId,
          cwd: identity.cwd,
          memoryDir: identity.memoryDir,
        })
        log.info('session_created', { session_id: session.sessionId, user_id: identity.userId })
        return sendJson(res, 201, requestId, session, null, corsHeaders())
      }

      const sessionMatch = url.pathname.match(/^\/sessions\/([^/]+)$/)
      if (sessionMatch && method === 'GET') {
        const session = params.runtime.getSession(sessionMatch[1]!)
        if (!ensureSessionAccess(identity, session)) {
          return sendJson(res, 403, requestId, null, { code: 'FORBIDDEN', message: 'Session belongs to another workspace.' }, corsHeaders())
        }
        return sendJson(res, 200, requestId, session, null, corsHeaders())
      }
      if (sessionMatch && method === 'DELETE') {
        const session = params.runtime.getSession(sessionMatch[1]!)
        if (!ensureSessionAccess(identity, session)) {
          return sendJson(res, 403, requestId, null, { code: 'FORBIDDEN', message: 'Session belongs to another workspace.' }, corsHeaders())
        }
        await params.runtime.deleteSession(sessionMatch[1]!)
        return sendJson(res, 200, requestId, { deleted: true }, null, corsHeaders())
      }

      const messagesMatch = url.pathname.match(/^\/sessions\/([^/]+)\/messages$/)
      if (messagesMatch && method === 'GET') {
        const session = params.runtime.getSession(messagesMatch[1]!)
        if (!ensureSessionAccess(identity, session)) {
          return sendJson(res, 403, requestId, null, { code: 'FORBIDDEN', message: 'Session belongs to another workspace.' }, corsHeaders())
        }
        return sendJson(res, 200, requestId, { messages: params.runtime.getMessages(messagesMatch[1]!) }, null, corsHeaders())
      }
      if (messagesMatch && method === 'POST') {
        const session = params.runtime.getSession(messagesMatch[1]!)
        if (!ensureSessionAccess(identity, session)) {
          return sendJson(res, 403, requestId, null, { code: 'FORBIDDEN', message: 'Session belongs to another workspace.' }, corsHeaders())
        }
        const body = await readJsonBody(req)
        if (typeof body.text !== 'string' || body.text.trim().length === 0) {
          return sendJson(res, 400, requestId, null, { code: 'INVALID_BODY', message: 'Body must include non-empty text.' }, corsHeaders())
        }

        // 流式模式：通过 SSE 逐步推送消息内容
        if (body.stream === true) {
          startSSEStream(res, requestId)
          try {
            const stream = params.runtime.sendMessageStream({
              sessionId: messagesMatch[1]!,
              text: body.text,
            })
            for await (const chunk of stream) {
              sendSSEEvent(res, 'delta', { type: chunk.type, ...chunk.payload })
            }
          } catch (err) {
            sendSSEEvent(res, 'error', { message: (err as Error).message })
          } finally {
            res.end()
          }
          return
        }

        const result = await params.runtime.sendMessage({ sessionId: messagesMatch[1]!, text: body.text })
        return sendJson(res, 200, requestId, result, null, corsHeaders())
      }

      const extractMatch = url.pathname.match(/^\/sessions\/([^/]+)\/extract-memory$/)
      if (extractMatch && method === 'POST') {
        const session = params.runtime.getSession(extractMatch[1]!)
        if (!ensureSessionAccess(identity, session)) {
          return sendJson(res, 403, requestId, null, { code: 'FORBIDDEN', message: 'Session belongs to another workspace.' }, corsHeaders())
        }
        const result = await params.runtime.extractMemories(extractMatch[1]!)
        return sendJson(res, 200, requestId, result, null, corsHeaders())
      }

      const approvalMatch = url.pathname.match(/^\/approvals\/([^/]+)$/)
      if (approvalMatch && method === 'GET') {
        const approval = params.runtime.getApproval(approvalMatch[1]!)
        if (!approval) {
          return sendJson(res, 404, requestId, null, { code: 'NOT_FOUND', message: 'Approval not found.' }, corsHeaders())
        }
        if (approval.workspaceId !== identity.workspaceId) {
          return sendJson(res, 403, requestId, null, { code: 'FORBIDDEN', message: 'Approval belongs to another workspace.' }, corsHeaders())
        }
        return sendJson(res, 200, requestId, approval, null, corsHeaders())
      }

      const approveMatch = url.pathname.match(/^\/approvals\/([^/]+)\/(approve|reject)$/)
      if (approveMatch && method === 'POST') {
        const approval = params.runtime.getApproval(approveMatch[1]!)
        if (!approval) {
          return sendJson(res, 404, requestId, null, { code: 'NOT_FOUND', message: 'Approval not found.' }, corsHeaders())
        }
        if (approval.workspaceId !== identity.workspaceId) {
          return sendJson(res, 403, requestId, null, { code: 'FORBIDDEN', message: 'Approval belongs to another workspace.' }, corsHeaders())
        }
        const result = approveMatch[2] === 'approve'
          ? params.runtime.approve({ approvalId: approveMatch[1]!, reviewerId: identity.userId })
          : params.runtime.reject({ approvalId: approveMatch[1]!, reviewerId: identity.userId })
        return sendJson(res, 200, requestId, result, null, corsHeaders())
      }

      return sendJson(res, 404, requestId, null, { code: 'NOT_FOUND', message: 'Route not found.' }, corsHeaders())
    } catch (err) {
      if (err instanceof SessionNotFoundError) {
        return sendJson(res, 404, requestId, null, { code: 'SESSION_NOT_FOUND', message: err.message }, corsHeaders())
      }
      log.error('request_failed', { error: (err as Error).message })
      return sendJson(res, 500, requestId, null, { code: 'INTERNAL_ERROR', message: (err as Error).message }, corsHeaders())
    }
  }
}

/** 解析 TLS 证书和密钥内容（支持文件路径或内联 PEM 文本） */
async function readTLSOption(value: string): Promise<string> {
  if (value.startsWith('-----BEGIN')) return value
  const { readFile } = await import('fs/promises')
  return readFile(value, 'utf-8')
}

/** TLS 配置已提供且有效时返回 true */
export function isTLSConfigured(tls?: TLSConfig): boolean {
  return !!(tls && tls.cert && tls.key)
}

/** 创建 P0 HTTP(S) 服务器实例，支持 TLS、CORS 和超时控制。 */
export async function createP0Server(config: P0ServerConfig): Promise<Server | HttpsServer> {
  const handler = createP0RequestHandler({
    runtime: config.runtime,
    identities: config.identities,
    logger: config.logger,
    corsOrigin: config.corsOrigin,
  })

  if (isTLSConfigured(config.tls)) {
    const [cert, key, ca] = await Promise.all([
      readTLSOption(config.tls!.cert),
      readTLSOption(config.tls!.key),
      config.tls!.ca ? readTLSOption(config.tls!.ca) : Promise.resolve(undefined),
    ])
    const server = createHttpsServer({
      cert,
      key,
      ...(ca ? { ca } : {}),
      ...(config.tls!.requestCert ? { requestCert: true } : {}),
    }, handler)
    server.timeout = config.requestTimeout ?? 120_000
    server.headersTimeout = config.headersTimeout ?? 60_000
    server.keepAliveTimeout = 65_000
    return server
  }

  const server = createServer(handler)
  server.timeout = config.requestTimeout ?? 120_000
  server.headersTimeout = config.headersTimeout ?? 60_000
  server.keepAliveTimeout = 65_000
  return server
}
