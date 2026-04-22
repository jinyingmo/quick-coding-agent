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
 */

import { exec } from 'child_process'
import { promisify } from 'util'
import { z } from 'zod'
import type { Tool } from '../types.js'

const execAsync = promisify(exec)

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
  isReadOnly: () => false,
  async call(input, ctx) {
    const timeoutMs = input.timeout_ms ?? 30_000
    ctx.log(`[bash] ${input.command}`, 'info')

    try {
      const { stdout, stderr } = await execAsync(input.command, {
        cwd: ctx.cwd,
        shell: '/bin/bash',
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024, // 10 MB
        env: { ...process.env },
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
