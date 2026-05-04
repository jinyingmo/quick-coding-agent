import { useState } from 'react'
import { Agent } from '@quick-coding-agent/agent-tool-call'
import type { AgentOptions } from '@quick-coding-agent/agent-tool-call'

export function useAgentSession(opts: AgentOptions) {
  const [agent] = useState(() => new Agent(opts))
  const [session] = useState(() => agent.createSession())
  return { agent, session }
}
