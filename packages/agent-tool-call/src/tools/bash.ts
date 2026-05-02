/** 中文说明：工具层模块。 */

/**
 * `bash` — execute a shell command and capture stdout / stderr.
 *
 * Mirrors `BashTool` from the parent project at the essential level:
 * run a command in the agent's working directory, capture stdout/stderr,
 * and report back success or failure.
 *
 * Safety notes:
 *  - Commands run under the invoking user's privileges.
 *  - A default timeout of 30 s prevents hung processes.
 *  - `isReadOnly()` always returns false so the permission layer can
 *    gate it independently from read-only tools.
 *
 * 中文说明：bash 工具，在 agent 工作目录中执行 Shell 命令并返回 stdout/stderr 和退出码。
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import { z } from 'zod'
import type { Tool } from '../types.js'

const execFileAsync = promisify(execFile)

// 匹配常见敏感环境变量名的正则，防止 API 密钥等凭证泄漏给子进程
const SENSITIVE_ENV_RE = /(?:API_KEY|API_SECRET|ACCESS_TOKEN|SECRET_KEY|PRIVATE_KEY|PASSWORD|_KEYS)$/i

function buildSafeEnv(): NodeJS.ProcessEnv {
  const safe: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (!SENSITIVE_ENV_RE.test(k)) safe[k] = v
  }
  return safe
}

const inputSchema = z.object({
  command: z
    .string()
    .describe('The shell command to execute. Runs in the agent cwd via /bin/bash.'),
  timeout_ms: z
    .number()
    .optional()
    .describe('Timeout in milliseconds. Defaults to 30 000 (30 s).'),
})

type Output = { stdout: string; stderr: string; exitCode: number }

export const bashTool: Tool<typeof inputSchema, Output> = {
  name: 'bash',
  description:
    'Execute a bash shell command (runs in the agent working directory). ' +
    'Use for running tests, building the project, installing packages, ' +
    'checking git status, or any other system operation. ' +
    'Returns stdout, stderr, and the exit code. ' +
    'Prefer targeted read/edit tools for file content — use bash for process execution.',
  inputSchema,
  /** 始终返回 false，标记此工具会修改系统状态（写入/执行），需经过权限检查。 */
  isReadOnly: () => false,
  /** 执行 Shell 命令，捕获 stdout/stderr，超时或非零退出码时返回错误信息。 */
  async call(input, ctx) {
    const timeoutMs = input.timeout_ms ?? 30_000
    ctx.log(`[bash] ${input.command}`, 'info')

    try {
      // execFile 将命令作为 argv[0] 传给 bash，避免二次 shell 解析；
      // buildSafeEnv() 过滤敏感凭证，防止 API key 泄漏给子进程
      const { stdout, stderr } = await execFileAsync('/bin/bash', ['-c', input.command], {
        cwd: ctx.cwd,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024, // 10 MB
        env: buildSafeEnv(),
      })

      const display = [
        stdout.trim() && `STDOUT:\n${stdout.trim()}`,
        stderr.trim() && `STDERR:\n${stderr.trim()}`,
      ]
        .filter(Boolean)
        .join('\n') || '(no output)'

      ctx.log(`[bash] exit=0`, 'debug')
      return { data: { stdout, stderr, exitCode: 0 }, display }
    } catch (err: unknown) {
      // execAsync rejects on non-zero exit or timeout
      const e = err as { stdout?: string; stderr?: string; code?: number; message?: string }
      const stdout = e.stdout ?? ''
      const stderr = e.stderr ?? ''
      const exitCode = typeof e.code === 'number' ? e.code : 1
      const errMsg = e.message ?? String(err)

      const display = [
        stdout.trim() && `STDOUT:\n${stdout.trim()}`,
        stderr.trim() && `STDERR:\n${stderr.trim()}`,
        `Exit code: ${exitCode}`,
        errMsg && `Error: ${errMsg}`,
      ]
        .filter(Boolean)
        .join('\n')

      ctx.log(`[bash] exit=${exitCode}`, 'warn')
      return { data: { stdout, stderr, exitCode }, display, isError: exitCode !== 0 }
    }
  },
}
