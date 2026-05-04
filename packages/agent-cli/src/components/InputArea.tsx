import { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { theme } from '../theme.js'

const COMMANDS = [
  '/quit', '/exit', '/history', '/reload',
  '/memory', '/tools', '/skills', '/help',
]

type Props = {
  onSubmit: (text: string) => void
  disabled?: boolean
}

export function InputArea({ onSubmit, disabled = false }: Props) {
  const [buffer, setBuffer] = useState('')
  const [history, setHistory] = useState<string[]>([])
  const [historyIdx, setHistoryIdx] = useState(-1)

  useInput((input, key) => {
    if (disabled) return

    if (key.return) {
      const text = buffer.trim()
      if (!text) return
      setHistory(prev => [text, ...prev].slice(0, 50))
      setBuffer('')
      setHistoryIdx(-1)
      onSubmit(text)
      return
    }

    if (key.backspace || key.delete) {
      setBuffer(prev => prev.slice(0, -1))
      return
    }

    if (key.upArrow) {
      const next = Math.min(historyIdx + 1, history.length - 1)
      setHistoryIdx(next)
      if (next >= 0) setBuffer(history[next] ?? '')
      return
    }

    if (key.downArrow) {
      const next = historyIdx - 1
      setHistoryIdx(next)
      setBuffer(next < 0 ? '' : (history[next] ?? ''))
      return
    }

    if (key.tab) {
      const match = COMMANDS.find(c => c.startsWith(buffer))
      if (match) setBuffer(match + ' ')
      return
    }

    if (input && input.length === 1 && !key.ctrl && !key.meta) {
      setBuffer(prev => prev + input)
    }
  })

  const placeholder = disabled ? 'Waiting for response...' : 'Type a message or /help...'

  return (
    <Box
      borderStyle="round"
      borderColor={disabled ? theme.dimText : theme.accent}
      width="100%"
      paddingLeft={1}
      alignItems="center"
    >
      <Text bold color={theme.accent}>{'› '}</Text>
      <Text color={disabled ? theme.dimText : theme.primaryText}>
        {buffer || placeholder}
      </Text>
    </Box>
  )
}
