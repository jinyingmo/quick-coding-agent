import { Box, Text } from 'ink'
import { theme } from '../theme.js'

export function Header() {
  return (
    <Box
      borderStyle="round"
      borderColor={theme.border}
      width="100%"
      paddingLeft={2}
      alignItems="center"
    >
      <Text bold color={theme.accent}> Codey REPL </Text>
      <Text color={theme.dimText}>— LLM-powered agent with persistent memory</Text>
    </Box>
  )
}
