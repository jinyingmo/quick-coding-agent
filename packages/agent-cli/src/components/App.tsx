import { Box, useInput } from 'ink'
import type { AgentOptions } from '@quick-coding-agent/agent-tool-call'
import { useAgentSession } from '../hooks/useAgentSession.js'
import { useStreamingChat } from '../hooks/useStreamingChat.js'
import { useCommandHandler } from '../hooks/useCommandHandler.js'
import { Header } from './Header.js'
import { ChatHistory } from './ChatHistory.js'
import { InputArea } from './InputArea.js'
import { StatusBar } from './StatusBar.js'
import { CommandPanel } from './CommandPanel.js'
import { ConfirmDialog } from './ConfirmDialog.js'
type AppProps = { agentOpts: AgentOptions }

export function App({ agentOpts }: AppProps) {
  const { agent, session } = useAgentSession(agentOpts)

  const {
    messages,
    isRunning,
    streamingText,
    toolCalls,
    confirmRequest,
    setConfirmRequest,
    usage,
    handleInput,
  } = useStreamingChat(session)

  const { handleCommand, showHelp, setShowHelp, statusMessage } =
    useCommandHandler(agent, session)

  useInput((_input, key) => {
    if (key.ctrl && _input === 'c') {
      session.abort()
    }
  })

  return (
    <Box flexDirection="column" height="100%">
      <Box flexShrink={0}>
        <Header />
      </Box>

      <Box flexGrow={1} flexDirection="column" paddingX={1} overflowY="hidden">
        <ChatHistory
          messages={messages}
          streamingText={streamingText}
          toolCalls={toolCalls}
          isRunning={isRunning}
        />
      </Box>

      <Box flexShrink={0}>
        <StatusBar
          isRunning={isRunning}
          toolsCount={agent.toolNames().length}
          skillsCount={agent.activeSkillIds().length}
          usage={usage}
          statusMessage={statusMessage}
        />
      </Box>

      <Box flexShrink={0}>
        <InputArea
          onSubmit={(text) => { void handleCommand(text, handleInput) }}
          disabled={isRunning || !!confirmRequest || showHelp}
        />
      </Box>

      {confirmRequest && (
        <ConfirmDialog
          request={confirmRequest}
          onDismiss={() => setConfirmRequest(null)}
        />
      )}

      {showHelp && <CommandPanel onClose={() => setShowHelp(false)} />}
    </Box>
  )
}
