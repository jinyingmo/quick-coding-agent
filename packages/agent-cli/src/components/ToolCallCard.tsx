import { Box, Text } from 'ink'
import type { ToolCallVM } from '../types.js'
import { theme } from '../theme.js'

export function ToolCallCard({ call }: { call: ToolCallVM }) {
  const preview = call.args.length > 80 ? call.args.slice(0, 80) + '…' : call.args
  return (
    <Box
      borderStyle="round"
      borderColor={theme.border}
      flexDirection="column"
      paddingX={1}
      marginTop={1}
    >
      <Text bold color={theme.accent}>{call.name}</Text>
      {preview ? <Text color={theme.dimText} wrap="truncate">{preview}</Text> : null}
      <Text color={theme.info}>● Running...</Text>
    </Box>
  )
}
