import { Box, Text, useInput } from 'ink'
import { theme } from '../theme.js'

const COMMANDS: [string, string][] = [
  ['/help',    'Show this help panel'],
  ['/quit',    'Exit the REPL (drains background tasks)'],
  ['/history', 'Show message count in current session'],
  ['/reload',  'Clear capability cache (rebuilds on next turn)'],
  ['/memory',  'Show memory directory path'],
  ['/tools',   'List loaded tools'],
  ['/skills',  'List active skills'],
]

export function CommandPanel({ onClose }: { onClose: () => void }) {
  useInput((_input, key) => {
    if (key.escape || _input === 'q') onClose()
  })

  return (
    <Box
      borderStyle="round"
      borderColor={theme.accent}
      flexDirection="column"
      paddingX={2}
      paddingY={1}
      marginX={4}
      marginTop={1}
    >
      <Text bold color={theme.accent}>Available Commands</Text>
      <Box marginTop={1} flexDirection="column">
        {COMMANDS.map(([cmd, desc]) => (
          <Box key={cmd}>
            <Text color={theme.info} bold>{cmd.padEnd(12)}</Text>
            <Text color={theme.dimText}>{desc}</Text>
          </Box>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text color={theme.dimText}>[Esc / q] Close</Text>
      </Box>
    </Box>
  )
}
