import type { ReactNode } from 'react'
import { Box, Text } from 'ink'
import { theme } from '../theme.js'

type Props = { type: 'user' | 'assistant'; children?: ReactNode }

export function MessageBubble({ type, children }: Props) {
  const isUser = type === 'user'
  return (
    <Box flexDirection="column" width="100%">
      <Box>
        <Text bold color={isUser ? theme.accent : theme.info}>
          {isUser ? '› ' : '● '}
        </Text>
        <Text color={theme.dimText} dimColor>
          {isUser ? 'You' : 'Assistant'}
        </Text>
      </Box>
      <Box paddingLeft={2} flexDirection="column">
        {children}
      </Box>
    </Box>
  )
}
