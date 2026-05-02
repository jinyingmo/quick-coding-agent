/** 中文说明：P0 HTTP 服务模块。 */

import { createServer, type IncomingMessage, type RequestListener, type ServerResponse } from 'http'
import { randomUUID } from 'crypto'
import { findIdentityByBearerToken, type ApiKeyIdentity } from '../auth/apiKey.js'
import type { AgentRuntime } from '../runtime/agentRuntime.js'
import type { StructuredLogger } from '../observability/logger.js'
import { SessionNotFoundError } from '../runtime/errors.js'

// 发送 JSON 响应并设置正确的状态码和头部
function sendJson(
  res: ServerResponse,
  statusCode: number,
  requestId: string,
  data: unknown,
  error: unknown = null,
): void {
  const body = JSON.stringify({ request_id: requestId, data, error })
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' })
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

/** 创建 P0 HTTP 请求处理器：路由分发到 session、messages、approvals、extract-memory 等端点。 */
export function createP0RequestHandler(params: {
  runtime: AgentRuntime
  identities: ApiKeyIdentity[]
  logger: StructuredLogger
}): RequestListener {
  // HTTP 请求监听器：路由分发到各端点
  return async (req, res) => {
    const requestId = randomUUID()
    const url = new URL(req.url ?? '/', 'http://localhost')
    const method = req.method ?? 'GET'
    const logger = params.logger.child({ request_id: requestId, path: url.pathname, method })

    if (url.pathname === '/healthz') {
      return sendJson(res, 200, requestId, { ok: true })
    }

    const identity = findIdentityByBearerToken(req.headers.authorization, params.identities)
    if (!identity) {
      logger.log('warn', 'auth_failed')
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
        logger.log('info', 'session_created', { session_id: session.sessionId, user_id: identity.userId })
        return sendJson(res, 201, requestId, session)
      }

      const sessionMatch = url.pathname.match(/^\/sessions\/([^/]+)$/)
      if (sessionMatch && method === 'GET') {
        const session = params.runtime.getSession(sessionMatch[1]!)
        if (!ensureSessionAccess(identity, session)) {
          return sendJson(res, 403, requestId, null, { code: 'FORBIDDEN', message: 'Session belongs to another workspace.' })
        }
        return sendJson(res, 200, requestId, session)
      }
      if (sessionMatch && method === 'DELETE') {
        const session = params.runtime.getSession(sessionMatch[1]!)
        if (!ensureSessionAccess(identity, session)) {
          return sendJson(res, 403, requestId, null, { code: 'FORBIDDEN', message: 'Session belongs to another workspace.' })
        }
        await params.runtime.deleteSession(sessionMatch[1]!)
        return sendJson(res, 200, requestId, { deleted: true })
      }

      const messagesMatch = url.pathname.match(/^\/sessions\/([^/]+)\/messages$/)
      if (messagesMatch && method === 'GET') {
        const session = params.runtime.getSession(messagesMatch[1]!)
        if (!ensureSessionAccess(identity, session)) {
          return sendJson(res, 403, requestId, null, { code: 'FORBIDDEN', message: 'Session belongs to another workspace.' })
        }
        return sendJson(res, 200, requestId, { messages: params.runtime.getMessages(messagesMatch[1]!) })
      }
      if (messagesMatch && method === 'POST') {
        const session = params.runtime.getSession(messagesMatch[1]!)
        if (!ensureSessionAccess(identity, session)) {
          return sendJson(res, 403, requestId, null, { code: 'FORBIDDEN', message: 'Session belongs to another workspace.' })
        }
        const body = await readJsonBody(req)
        if (typeof body.text !== 'string' || body.text.trim().length === 0) {
          return sendJson(res, 400, requestId, null, { code: 'INVALID_BODY', message: 'Body must include non-empty text.' })
        }
        const result = await params.runtime.sendMessage({ sessionId: messagesMatch[1]!, text: body.text })
        return sendJson(res, 200, requestId, result)
      }

      const extractMatch = url.pathname.match(/^\/sessions\/([^/]+)\/extract-memory$/)
      if (extractMatch && method === 'POST') {
        const session = params.runtime.getSession(extractMatch[1]!)
        if (!ensureSessionAccess(identity, session)) {
          return sendJson(res, 403, requestId, null, { code: 'FORBIDDEN', message: 'Session belongs to another workspace.' })
        }
        const result = await params.runtime.extractMemories(extractMatch[1]!)
        return sendJson(res, 200, requestId, result)
      }

      const approvalMatch = url.pathname.match(/^\/approvals\/([^/]+)$/)
      if (approvalMatch && method === 'GET') {
        const approval = params.runtime.getApproval(approvalMatch[1]!)
        if (!approval) {
          return sendJson(res, 404, requestId, null, { code: 'NOT_FOUND', message: 'Approval not found.' })
        }
        if (approval.workspaceId !== identity.workspaceId) {
          return sendJson(res, 403, requestId, null, { code: 'FORBIDDEN', message: 'Approval belongs to another workspace.' })
        }
        return sendJson(res, 200, requestId, approval)
      }

      const approveMatch = url.pathname.match(/^\/approvals\/([^/]+)\/(approve|reject)$/)
      if (approveMatch && method === 'POST') {
        const approval = params.runtime.getApproval(approveMatch[1]!)
        if (!approval) {
          return sendJson(res, 404, requestId, null, { code: 'NOT_FOUND', message: 'Approval not found.' })
        }
        if (approval.workspaceId !== identity.workspaceId) {
          return sendJson(res, 403, requestId, null, { code: 'FORBIDDEN', message: 'Approval belongs to another workspace.' })
        }
        const result = approveMatch[2] === 'approve'
          ? params.runtime.approve({ approvalId: approveMatch[1]!, reviewerId: identity.userId })
          : params.runtime.reject({ approvalId: approveMatch[1]!, reviewerId: identity.userId })
        return sendJson(res, 200, requestId, result)
      }

      return sendJson(res, 404, requestId, null, { code: 'NOT_FOUND', message: 'Route not found.' })
    } catch (err) {
      if (err instanceof SessionNotFoundError) {
        return sendJson(res, 404, requestId, null, { code: 'SESSION_NOT_FOUND', message: err.message })
      }
      logger.log('error', 'request_failed', { error: (err as Error).message })
      return sendJson(res, 500, requestId, null, { code: 'INTERNAL_ERROR', message: (err as Error).message })
    }
  }
}

/** 创建 P0 HTTP 服务器实例。 */
export function createP0Server(params: {
  runtime: AgentRuntime
  identities: ApiKeyIdentity[]
  logger: StructuredLogger
}) {
  return createServer(createP0RequestHandler(params))
}
