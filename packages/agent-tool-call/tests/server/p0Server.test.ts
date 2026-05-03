import { Readable } from 'stream'
import { describe, expect, it } from 'vitest'
import { createP0RequestHandler } from '../../src/server/app.js'
import { createStructuredLogger } from '../../src/observability/logger.js'
import type { AgentRuntime } from '../../src/runtime/agentRuntime.js'
import type { PendingApproval } from '../../src/runtime/approvalRegistry.js'
import type { Message } from '../../src/types.js'
import type { ApiKeyIdentity } from '../../src/auth/apiKey.js'

function makeRuntime(): AgentRuntime {
  const messages = new Map<string, Message[]>()
  const approvals = new Map<string, PendingApproval>()

  const approval: PendingApproval = {
    id: 'apr-1',
    sessionId: 'sess-1',
    userId: 'demo-user',
    workspaceId: 'demo-workspace',
    actionType: 'bash',
    toolName: 'bash',
    riskLevel: 'high',
    summary: 'Install deps',
    reason: 'Needs approval',
    input: { command: 'npm install' },
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    status: 'pending',
  }
  approvals.set(approval.id, approval)

  return {
    createSession() {
      messages.set('sess-1', [])
      return { sessionId: 'sess-1' }
    },
    getSession(sessionId) {
      if (sessionId !== 'sess-1') throw new Error(`Session not found: ${sessionId}`)
      return {
        sessionId,
        userId: 'demo-user',
        workspaceId: 'demo-workspace',
        cwd: '/repo',
        memoryDir: '/repo/memory',
        messageCount: messages.get(sessionId)?.length ?? 0,
        activeApprovalIds: ['apr-1'],
      }
    },
    async deleteSession() {
      return true
    },
    getMessages(sessionId) {
      return messages.get(sessionId) ?? []
    },
    async sendMessage(input) {
      if (input.text.includes('install')) {
        return { status: 'confirm_required' as const, approvalId: 'apr-1', reason: 'Needs approval' }
      }
      return { status: 'completed' as const, reply: 'ok' }
    },
    async *sendMessageStream(input) {
      if (input.text.includes('install')) {
        yield {
          type: 'confirm_required',
          payload: {
            type: 'confirm_required',
            approvalId: 'apr-1',
            reason: 'Needs approval',
            toolName: 'bash',
            toolUseId: 'tool-1',
          },
        }
        return
      }
      yield { type: 'text_delta', payload: { type: 'text_delta', text: 'ok' } }
      yield { type: 'done', payload: { type: 'done', finishReason: 'end_turn' } }
    },
    async extractMemories() {
      return { status: 'completed' as const, savedCount: 0 }
    },
    getApproval(approvalId) {
      return approvals.get(approvalId)
    },
    approve() {
      return { status: 'approved' as const }
    },
    reject() {
      return { status: 'rejected' as const }
    },
    async dispose() {},
  }
}

async function invokeHandler(params: {
  method: string
  url: string
  headers?: Record<string, string>
  body?: unknown
  identities?: ApiKeyIdentity[]
  runtime?: AgentRuntime
}): Promise<{ statusCode: number; headers: Record<string, string>; body: unknown }> {
  const handler = createP0RequestHandler({
    runtime: params.runtime ?? makeRuntime(),
    identities:
      params.identities ??
      [
        {
          token: 'local-dev-token',
          userId: 'demo-user',
          workspaceId: 'demo-workspace',
          cwd: '/repo',
          memoryDir: '/repo/memory',
        },
      ],
    logger: createStructuredLogger({ test: 'p0-server' }),
  })

  const bodyText = params.body === undefined ? '' : JSON.stringify(params.body)
  const req = Readable.from(bodyText ? [bodyText] : []) as Readable & {
    method?: string
    url?: string
    headers?: Record<string, string>
  }
  req.method = params.method
  req.url = params.url
  req.headers = params.headers ?? {}

  let statusCode = 200
  let endedBody = ''
  const headers: Record<string, string> = {}

  const res = {
    writeHead(code: number, incomingHeaders: Record<string, string>) {
      statusCode = code
      Object.assign(headers, incomingHeaders)
      return res
    },
    end(chunk?: string) {
      if (chunk) endedBody += chunk
      done()
      return res
    },
  }

  let done!: () => void
  const finished = new Promise<void>(resolve => {
    done = resolve
  })

  await Promise.resolve(handler(req as never, res as never))
  await finished

  return {
    statusCode,
    headers,
    body: endedBody ? JSON.parse(endedBody) : null,
  }
}

describe('createP0RequestHandler', () => {
  it('rejects requests without bearer auth', async () => {
    const response = await invokeHandler({ method: 'POST', url: '/sessions' })
    expect(response.statusCode).toBe(401)
    expect((response.body as any).error.code).toBe('UNAUTHORIZED')
  })

  it('creates a session and returns metadata', async () => {
    const response = await invokeHandler({
      method: 'POST',
      url: '/sessions',
      headers: { authorization: 'Bearer local-dev-token' },
    })
    expect(response.statusCode).toBe(201)
    expect((response.body as any).data.sessionId).toBe('sess-1')
  })

  it('validates message body and returns confirm_required for risky flow', async () => {
    const bad = await invokeHandler({
      method: 'POST',
      url: '/sessions/sess-1/messages',
      headers: {
        authorization: 'Bearer local-dev-token',
        'content-type': 'application/json',
      },
      body: { text: '' },
    })
    expect(bad.statusCode).toBe(400)

    const good = await invokeHandler({
      method: 'POST',
      url: '/sessions/sess-1/messages',
      headers: {
        authorization: 'Bearer local-dev-token',
        'content-type': 'application/json',
      },
      body: { text: 'please install deps' },
    })
    expect(good.statusCode).toBe(200)
    expect((good.body as any).data.status).toBe('confirm_required')
    expect((good.body as any).data.approvalId).toBe('apr-1')
  })

  it('serves approvals and approval decisions', async () => {
    const getResponse = await invokeHandler({
      method: 'GET',
      url: '/approvals/apr-1',
      headers: { authorization: 'Bearer local-dev-token' },
    })
    expect(getResponse.statusCode).toBe(200)
    expect((getResponse.body as any).data.id).toBe('apr-1')

    const approveResponse = await invokeHandler({
      method: 'POST',
      url: '/approvals/apr-1/approve',
      headers: { authorization: 'Bearer local-dev-token' },
    })
    expect(approveResponse.statusCode).toBe(200)
    expect((approveResponse.body as any).data.status).toBe('approved')
  })

  it('blocks cross-workspace approval access', async () => {
    const response = await invokeHandler({
      method: 'GET',
      url: '/approvals/apr-1',
      headers: { authorization: 'Bearer other-token' },
      identities: [
        {
          token: 'other-token',
          userId: 'other-user',
          workspaceId: 'other-workspace',
          cwd: '/repo',
          memoryDir: '/repo/memory',
        },
      ],
    })
    expect(response.statusCode).toBe(403)
    expect((response.body as any).error.code).toBe('FORBIDDEN')
  })
})
