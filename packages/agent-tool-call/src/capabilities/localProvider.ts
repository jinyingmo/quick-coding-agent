/** 中文说明：能力提供器模块。 */

import type { Tool } from '../types.js'
import { ALL_TOOLS } from '../tools/index.js'
import type { CapabilityProvider } from './types.js'

// 为工具标注本地来源
function withLocalSource(tool: Tool): Tool {
  return {
    ...tool,
    source: 'local',
  }
}

/** 创建本地工具能力提供器，封装内置工具列表 */
export function createLocalToolsProvider(tools: Tool[] = ALL_TOOLS): CapabilityProvider {
  const enriched = tools.map(withLocalSource)
  return {
    id: 'local-tools',
    source: 'local',
    // 返回标记了本地来源的工具列表
    async getTools() {
      return enriched
    },
  }
}
