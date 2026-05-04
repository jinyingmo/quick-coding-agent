import { Box, Text, useInput } from 'ink'
import type { ConfirmRequest } from '../types.js'
import { theme } from '../theme.js'

type Props = {
  request: ConfirmRequest
  onDismiss: () => void
}

// Note: confirm_required terminates the stream — this dialog is informational.
// The user must re-send their request after reviewing what was blocked.
export function ConfirmDialog({ request, onDismiss }: Props) {
  useInput((_input, key) => {
    if (key.return || key.escape || _input === 'q') onDismiss()
  })

  return (
    <Box
      borderStyle="double"
      borderColor={theme.warning}
      flexDirection="column"
      paddingX={2}
      paddingY={1}
      marginX={4}
      marginTop={1}
    >
      <Text bold color={theme.warning}>⚠ Tool Approval Required</Text>
      <Box marginTop={1}>
        <Text color={theme.dimText}>Tool: </Text>
        <Text color={theme.accent} bold>{request.toolName}</Text>
      </Box>
      <Text color={theme.primaryText} wrap="wrap">{request.reason}</Text>
      <Box marginTop={1}>
        <Text color={theme.dimText}>
          The turn was stopped. Re-send your message or configure{'\n'}
          a permissive canUseTool policy to allow this tool.
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text color={theme.dimText}>[Enter / Esc / q] Dismiss</Text>
      </Box>
    </Box>
  )
}
