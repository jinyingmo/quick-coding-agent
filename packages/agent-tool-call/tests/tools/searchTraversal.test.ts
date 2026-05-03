import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { globTool } from '../../src/tools/glob.js'
import { grepTool } from '../../src/tools/grep.js'
import type { ToolUseContext } from '../../src/types.js'

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'agent-tool-call-'))
}

function makeContext(root: string): ToolUseContext {
  return {
    cwd: root,
    memoryDir: join(root, 'memory'),
    log: () => undefined,
    signal: new AbortController().signal,
  }
}

describe('search traversal tools', () => {
  const cleanupPaths: string[] = []

  afterEach(async () => {
    await Promise.all(
      cleanupPaths.splice(0).map(path => rm(path, { recursive: true, force: true })),
    )
  })

  it('glob respects .gitignore while traversing', async () => {
    const root = await makeTempDir()
    cleanupPaths.push(root)

    await mkdir(join(root, 'skip-dir'), { recursive: true })
    await mkdir(join(root, 'nested'), { recursive: true })
    await writeFile(join(root, '.gitignore'), 'ignored.ts\nskip-dir/\n', 'utf-8')
    await writeFile(join(root, 'keep.ts'), 'export const keep = true\n', 'utf-8')
    await writeFile(join(root, 'ignored.ts'), 'export const ignored = true\n', 'utf-8')
    await writeFile(join(root, 'skip-dir', 'hidden.ts'), 'export const hidden = true\n', 'utf-8')
    await writeFile(join(root, 'nested', 'keep.ts'), 'export const nested = true\n', 'utf-8')

    const result = await globTool.call(
      { pattern: '**/*.ts', path: root },
      makeContext(root),
    )

    expect(result.isError).toBeUndefined()
    expect(result.data.files).toEqual([
      join(root, 'keep.ts'),
      join(root, 'nested', 'keep.ts'),
    ])
  })

  it('grep respects .ignore while traversing', async () => {
    const root = await makeTempDir()
    cleanupPaths.push(root)

    await writeFile(join(root, '.ignore'), 'ignore-me.md\n', 'utf-8')
    await writeFile(join(root, 'README.md'), 'DOC: visible\n', 'utf-8')
    await writeFile(join(root, 'ignore-me.md'), 'DOC: hidden\n', 'utf-8')

    const result = await grepTool.call(
      { pattern: 'DOC', path: root, glob: '*.md' },
      makeContext(root),
    )

    expect(result.isError).toBeUndefined()
    expect(result.data.matches).toEqual([
      {
        file: join(root, 'README.md'),
        line: 1,
        text: 'DOC: visible',
      },
    ])
  })
})
