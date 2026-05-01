import type { Tool } from '../types.js'
import { ALL_TOOLS } from '../tools/index.js'
import type { CapabilityProvider } from './types.js'

function withLocalSource(tool: Tool): Tool {
  return {
    ...tool,
    source: 'local',
  }
}

export function createLocalToolsProvider(tools: Tool[] = ALL_TOOLS): CapabilityProvider {
  const enriched = tools.map(withLocalSource)
  return {
    id: 'local-tools',
    source: 'local',
    async getTools() {
      return enriched
    },
  }
}
