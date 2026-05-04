import { Box, Text } from 'ink'
import type { ToolCallVM } from '../types.js'
import { theme } from '../theme.js'

export function ToolResultCard({ call }: { call: ToolCallVM }) {
  return (
    <Box
      borderStyle={call.isError ? 'double' : 'round'}
      borderColor={call.isError ? theme.error : theme.border}
      flexDirection="column"
      paddingX={1}
      marginTop={1}
    >
      <Text bold color={call.isError ? theme.error : theme.dimText}>{call.name}</Text>
      {call.resultSummary ? (
        <Text
          color={call.isError ? theme.error : theme.primaryText}
          wrap="wrap"
        >
          {call.isError ? '✗ ' : '✓ '}{call.resultSummary}
        </Text>
      ) : null}
    </Box>
  )
}
