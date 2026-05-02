/** 中文说明：P0 权限策略模块。 */

export type MainPolicyConfig = {
  allowedReadRoots: string[]
  allowedWriteRoots: string[]
  protectedPathFragments: string[]
  allowedMcpTools: string[]
  bash: {
    allowCommands: string[]
    confirmCommands: string[]
    denyPatterns: string[]
  }
  approvalTtlMs: number
}

/** 创建默认策略配置：定义允许的读写根目录、受保护路径、bash 命令白名单/黑名单等 */
export function createDefaultMainPolicyConfig(params: {
  cwd: string
  memoryDir: string
}): MainPolicyConfig {
  return {
    allowedReadRoots: [params.cwd, params.memoryDir],
    allowedWriteRoots: [params.cwd, params.memoryDir],
    protectedPathFragments: [
      '/.env',
      '/package.json',
      '/pnpm-lock.yaml',
      '/package-lock.json',
      '/yarn.lock',
      '/Dockerfile',
      '/docker-compose',
      '/.github/',
      '/tsconfig',
    ],
    allowedMcpTools: [],
    bash: {
      allowCommands: [
        'git status',
        'git diff',
        'pnpm test',
        'pnpm build',
        'npm test',
        'npm run build',
        'vitest run',
      ],
      confirmCommands: [
        'npm install',
        'pnpm install',
        'pnpm add',
        'npm add',
        'git commit',
        'git push',
      ],
      denyPatterns: [
        'rm -rf',
        'git reset --hard',
        'curl | sh',
        'wget | sh',
        ':(){:|:&};:',
      ],
    },
    approvalTtlMs: 5 * 60_000,
  }
}
