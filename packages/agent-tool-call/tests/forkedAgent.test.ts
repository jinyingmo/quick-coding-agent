import { describe, it, expect } from 'vitest'
import { extractWrittenPaths, hasMemoryWritesSince } from '../src/forkedAgent.js'
import type { Message } from '../src/types.js'

function makeAssistantMessage(toolUses: { name: string; input: Record<string, unknown> }[]): Message {
  return {
    type: 'assistant',
    uuid: crypto.randomUUID(),
    content: toolUses.map((tu, i) => ({
      type: 'tool_use' as const,
      id: `tool_${i}`,
      name: tu.name,
      input: tu.input,
    })),
  }
}

function makeUserMessage(): Message {
  return {
    type: 'user',
    uuid: crypto.randomUUID(),
    content: [{ type: 'text', text: 'hello' }],
  }
}

describe('forkedAgent', () => {
  describe('extractWrittenPaths', () => {
    it('should extract paths from write_file tool uses', () => {
      const messages: Message[] = [
        makeUserMessage(),
        makeAssistantMessage([
          { name: 'write_file', input: { file_path: '/tmp/a.md', content: 'a' } },
          { name: 'read_file', input: { file_path: '/tmp/b.md' } },
        ]),
        makeAssistantMessage([
          { name: 'write_file', input: { file_path: '/tmp/a.md', content: 'updated' } },
          { name: 'write_file', input: { file_path: '/tmp/c.md', content: 'c' } },
        ]),
      ]
      const paths = extractWrittenPaths(messages)
      expect(paths).toEqual(['/tmp/a.md', '/tmp/c.md'])
    })

    it('should ignore non-assistant messages', () => {
      const messages: Message[] = [
        makeUserMessage(),
        makeAssistantMessage([
          { name: 'write_file', input: { file_path: '/tmp/a.md', content: 'a' } },
        ]),
      ]
      const paths = extractWrittenPaths(messages)
      expect(paths).toEqual(['/tmp/a.md'])
    })

    it('should handle empty messages', () => {
      const paths = extractWrittenPaths([])
      expect(paths).toEqual([])
    })
  })

  describe('hasMemoryWritesSince', () => {
    const memoryDir = '/memory'

    it('should return false when no messages after sinceUuid', () => {
      const msg1: Message = { ...makeAssistantMessage([]), uuid: 'uuid-1' }
      const result = hasMemoryWritesSince([msg1], 'uuid-1', memoryDir)
      expect(result).toBe(false)
    })

    it('should return true when memory write found after sinceUuid', () => {
      const msg1: Message = { ...makeUserMessage(), uuid: 'uuid-1' }
      const msg2: Message = {
        ...makeAssistantMessage([
          { name: 'write_file', input: { file_path: `${memoryDir}/test.md`, content: 'x' } },
        ]),
        uuid: 'uuid-2',
      }
      const result = hasMemoryWritesSince([msg1, msg2], 'uuid-1', memoryDir)
      expect(result).toBe(true)
    })

    it('should return false when writes are outside memoryDir', () => {
      const msg1: Message = { ...makeUserMessage(), uuid: 'uuid-1' }
      const msg2: Message = {
        ...makeAssistantMessage([
          { name: 'write_file', input: { file_path: '/other/path/test.md', content: 'x' } },
        ]),
        uuid: 'uuid-2',
      }
      const result = hasMemoryWritesSince([msg1, msg2], 'uuid-1', memoryDir)
      expect(result).toBe(false)
    })

    it('should return true when sinceUuid is undefined', () => {
      const msg: Message = {
        ...makeAssistantMessage([
          { name: 'write_file', input: { file_path: `${memoryDir}/test.md`, content: 'x' } },
        ]),
      }
      const result = hasMemoryWritesSince([msg], undefined, memoryDir)
      expect(result).toBe(true)
    })
  })
})
