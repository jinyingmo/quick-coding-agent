import { describe, expect, it } from 'vitest'
import { createUserMessage } from '../../src/types.js'
import { createSessionRegistry } from '../../src/runtime/sessionRegistry.js'

describe('sessionRegistry', () => {
  it('creates sessions and appends messages', () => {
    const registry = createSessionRegistry({
      ttlMs: 1_000,
      maxSessions: 10,
      maxMessagesPerSession: 10,
      maxTotalCharsPerSession: 10_000,
    })

    const session = registry.create({
      userId: 'u1',
      workspaceId: 'w1',
      cwd: '/tmp/project',
      memoryDir: '/tmp/project/memory',
    })

    registry.appendMessage(session.sessionId, createUserMessage('hello'))
    const loaded = registry.require(session.sessionId)
    expect(loaded.messages).toHaveLength(1)
    expect(loaded.messages[0]?.content[0]).toEqual({ type: 'text', text: 'hello' })
  })

  it('expires inactive sessions during sweep', () => {
    const registry = createSessionRegistry({
      ttlMs: 10,
      maxSessions: 10,
      maxMessagesPerSession: 10,
      maxTotalCharsPerSession: 10_000,
    })
    const session = registry.create({
      userId: 'u1',
      workspaceId: 'w1',
      cwd: '/tmp/project',
      memoryDir: '/tmp/project/memory',
    })

    const result = registry.sweep(session.createdAt + 20)
    expect(result.expiredSessions).toEqual([session.sessionId])
    expect(registry.get(session.sessionId)).toBeUndefined()
  })
})
