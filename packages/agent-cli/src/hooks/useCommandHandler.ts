import { useState, useCallback } from 'react'
import { useApp } from 'ink'
import type { Agent, ConversationSession } from '@quick-coding-agent/agent-tool-call'

export function useCommandHandler(agent: Agent, session: ConversationSession) {
  const { exit } = useApp()
  const [showHelp, setShowHelp] = useState(false)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)

  const flash = useCallback((msg: string, ms = 3000) => {
    setStatusMessage(msg)
    setTimeout(() => setStatusMessage(null), ms)
  }, [])

  // handleInput is passed in so non-command text routes to the streaming hook.
  const handleCommand = useCallback(async (
    input: string,
    handleInput: (text: string) => Promise<void>,
  ): Promise<void> => {
    if (!input.startsWith('/')) {
      await handleInput(input)
      return
    }

    const [cmd] = input.trim().split(' ')
    switch (cmd) {
      case '/quit':
      case '/exit':
        setStatusMessage('Draining background tasks...')
        await agent.drain(10_000)
        exit()
        break

      case '/history':
        flash(`${session.historyLength()} messages in conversation history`)
        break

      case '/reload':
        // Invalidate this session's capability cache. The next turn will
        // rebuild the system prompt and tool list from the latest state.
        session.invalidateCapabilitiesCache()
        flash('Capability cache cleared — will rebuild on next turn')
        break

      case '/memory':
        flash(`Memory directory: ${agent.opts.memoryDir}`)
        break

      case '/tools': {
        const names = agent.toolNames()
        flash(
          names.length
            ? `Tools (${names.length}): ${names.join(', ')}`
            : 'No tools loaded yet (send a message first)',
          5000,
        )
        break
      }

      case '/skills': {
        const ids = agent.activeSkillIds()
        flash(
          ids.length
            ? `Skills (${ids.length}): ${ids.join(', ')}`
            : 'No active skills',
          5000,
        )
        break
      }

      case '/help':
        setShowHelp(true)
        break

      default:
        // Unknown slash command — treat as regular chat input.
        await handleInput(input)
    }
  }, [agent, session, exit, flash])

  return { handleCommand, showHelp, setShowHelp, statusMessage }
}
