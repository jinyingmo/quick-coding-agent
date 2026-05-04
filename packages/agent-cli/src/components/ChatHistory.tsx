import { Box, Static, Text } from 'ink'
import type { MessageVM, ToolCallVM } from '../types.js'
import { MessageBubble } from './MessageBubble.js'
import { StreamingText } from './StreamingText.js'
import { ToolCallCard } from './ToolCallCard.js'
import { ToolResultCard } from './ToolResultCard.js'

type Props = {
  messages: MessageVM[]
  streamingText: string
  toolCalls: ToolCallVM[]
  isRunning: boolean
}

export function ChatHistory({ messages, streamingText, toolCalls, isRunning }: Props) {
  return (
    <Box flexDirection="column">
      {/*
        Static renders each item once and never re-renders it.
        Items must only be appended, never removed or reordered.
      */}
      <Static items={messages}>
        {(msg) => (
          <Box key={msg.uuid} marginBottom={1} flexDirection="column">
            <MessageBubble type={msg.type}>
              {msg.text ? <Text wrap="wrap">{msg.text}</Text> : null}
              {msg.toolCalls.map(tc =>
                tc.isDone
                  ? <ToolResultCard key={tc.id} call={tc} />
                  : <ToolCallCard key={tc.id} call={tc} />
              )}
            </MessageBubble>
          </Box>
        )}
      </Static>

      {isRunning && (
        <Box marginBottom={1} flexDirection="column">
          <MessageBubble type="assistant">
            {streamingText ? <StreamingText text={streamingText} /> : null}
            {toolCalls.map(tc =>
              tc.isDone
                ? <ToolResultCard key={tc.id} call={tc} />
                : <ToolCallCard key={tc.id} call={tc} />
            )}
          </MessageBubble>
        </Box>
      )}
    </Box>
  )
}
