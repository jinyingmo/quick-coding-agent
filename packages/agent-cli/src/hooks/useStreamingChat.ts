import { useState, useCallback, useRef } from 'react'
import type { ConversationSession } from '@quick-coding-agent/agent-tool-call'
import type { MessageVM, ToolCallVM, ConfirmRequest, UsageInfo } from '../types.js'

export function useStreamingChat(session: ConversationSession) {
  const [messages, setMessages] = useState<MessageVM[]>([])
  const [isRunning, setIsRunning] = useState(false)
  const [streamingText, setStreamingText] = useState('')
  const [toolCalls, setToolCalls] = useState<ToolCallVM[]>([])
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null)
  const [usage, setUsage] = useState<UsageInfo | null>(null)

  // Refs hold the live accumulated values so the finalization
  // step can read them without stale-closure issues.
  const streamingTextRef = useRef('')
  const toolCallsRef = useRef<ToolCallVM[]>([])

  const handleInput = useCallback(async (input: string) => {
    setIsRunning(true)
    setConfirmRequest(null)
    streamingTextRef.current = ''
    toolCallsRef.current = []
    setStreamingText('')
    setToolCalls([])

    setMessages(prev => [...prev, {
      uuid: crypto.randomUUID(),
      type: 'user',
      text: input,
      toolCalls: [],
    }])

    let stopReason: string | null = null

    try {
      for await (const chunk of session.streamChat(input)) {
        switch (chunk.type) {
          case 'text_delta': {
            streamingTextRef.current += chunk.text
            setStreamingText(streamingTextRef.current)
            break
          }

          case 'tool_call_delta': {
            setToolCalls(prev => {
              let next: ToolCallVM[]
              const existing = prev.find(t => t.id === chunk.id)
              if (existing) {
                next = prev.map(t =>
                  t.id === chunk.id ? { ...t, args: t.args + chunk.arguments } : t
                )
              } else {
                next = [...prev, {
                  id: chunk.id,
                  // name only arrives on the first delta for this id
                  name: chunk.name ?? '(tool)',
                  args: chunk.arguments,
                  isRunning: true,
                  isError: false,
                  isDone: false,
                }]
              }
              toolCallsRef.current = next
              return next
            })
            break
          }

          case 'tool_result': {
            setToolCalls(prev => {
              const next = prev.map(t =>
                t.id === chunk.toolUseId
                  ? {
                      ...t,
                      isRunning: false,
                      isError: chunk.isError,
                      isDone: true,
                      resultSummary: chunk.content.slice(0, 200),
                    }
                  : t
              )
              toolCallsRef.current = next
              return next
            })
            break
          }

          case 'confirm_required': {
            // The generator returns immediately after yielding this chunk —
            // there is no way to resume it. Record the request so the UI can
            // inform the user why the turn stopped.
            stopReason = `Tool "${chunk.toolName}" requires approval: ${chunk.reason}`
            setConfirmRequest({
              approvalId: chunk.approvalId,
              toolName: chunk.toolName,
              reason: chunk.reason,
            })
            break
          }

          case 'done': {
            if (chunk.usage) {
              setUsage({
                promptTokens: chunk.usage.promptTokens,
                completionTokens: chunk.usage.completionTokens,
                totalTokens: chunk.usage.totalTokens,
              })
            }
            break
          }
        }
      }

      // Build the assistant message using ref values (not stale state).
      const finalText = stopReason
        ? [streamingTextRef.current, `\n⚠ ${stopReason}`].filter(Boolean).join('')
        : streamingTextRef.current

      setMessages(prev => [...prev, {
        uuid: crypto.randomUUID(),
        type: 'assistant',
        text: finalText,
        toolCalls: [...toolCallsRef.current],
      }])
    } catch (err) {
      setMessages(prev => [...prev, {
        uuid: crypto.randomUUID(),
        type: 'assistant',
        text: `Error: ${(err as Error).message}`,
        toolCalls: [],
      }])
    } finally {
      setStreamingText('')
      setToolCalls([])
      setIsRunning(false)
    }
  }, [session])

  return {
    messages,
    isRunning,
    streamingText,
    toolCalls,
    confirmRequest,
    setConfirmRequest,
    usage,
    handleInput,
  }
}
