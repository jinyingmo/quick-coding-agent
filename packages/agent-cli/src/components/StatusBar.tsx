import { Box, Text } from 'ink'
import type { UsageInfo } from '../types.js'
import { theme } from '../theme.js'

type Props = {
  isRunning: boolean
  toolsCount: number
  skillsCount: number
  usage: UsageInfo | null
  statusMessage: string | null
}

export function StatusBar({ isRunning, toolsCount, skillsCount, usage, statusMessage }: Props) {
  const tokens = usage
    ? `[tokens: ${usage.totalTokens.toLocaleString()}]`
    : null

  return (
    <Box
      borderStyle="single"
      borderColor={theme.border}
      width="100%"
      paddingLeft={1}
      alignItems="center"
    >
      {statusMessage ? (
        <Text color={theme.warning}>{statusMessage}</Text>
      ) : (
        <Text color={theme.dimText}>
          {`[tools: ${toolsCount}] [skills: ${skillsCount}]`}
          {tokens ? ` ${tokens}` : ''}
          {isRunning ? <Text color={theme.info}> [running...]</Text> : null}
        </Text>
      )}
    </Box>
  )
}
