export type ToolCallVM = {
  id: string
  name: string
  args: string
  isRunning: boolean
  isError: boolean
  isDone: boolean
  resultSummary?: string
}

export type MessageVM = {
  uuid: string
  type: 'user' | 'assistant'
  text: string
  toolCalls: ToolCallVM[]
}

export type ConfirmRequest = {
  approvalId: string
  toolName: string
  reason: string
}

export type UsageInfo = {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}
