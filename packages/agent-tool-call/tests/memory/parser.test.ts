import { describe, it, expect } from 'vitest'
import { parseFrontmatter, buildMemoryFile, FRONTMATTER_REGEX } from '../../src/memory/parser.js'
import type { FrontmatterData } from '../../src/memory/types.js'

describe('parser', () => {
  describe('FRONTMATTER_REGEX', () => {
    it('should match valid frontmatter', () => {
      const md = '---\nname: test\n---\nbody'
      const match = md.match(FRONTMATTER_REGEX)
      expect(match).toBeTruthy()
      expect(match?.[1]).toContain('name: test')
    })

    it('should not match missing frontmatter', () => {
      const md = 'no frontmatter here'
      const match = md.match(FRONTMATTER_REGEX)
      expect(match).toBeNull()
    })
  })

  describe('parseFrontmatter', () => {
    it('should parse valid frontmatter', () => {
      const md = `---
name: my-memory
description: A test memory
type: project
---
This is the body content.
`
      const result = parseFrontmatter(md)
      expect((result.frontmatter as FrontmatterData).name).toBe('my-memory')
      expect((result.frontmatter as FrontmatterData).description).toBe('A test memory')
      expect((result.frontmatter as FrontmatterData).type).toBe('project')
      expect(result.content).toBe('This is the body content.\n')
    })

    it('should handle missing frontmatter', () => {
      const md = 'Just some content without frontmatter.'
      const result = parseFrontmatter(md)
      expect(result.frontmatter).toEqual({})
      expect(result.content).toBe(md)
    })

    it('should handle quoted values', () => {
      const md = `---
name: "quoted name"
description: 'single quoted'
---
body
`
      const result = parseFrontmatter(md)
      expect((result.frontmatter as FrontmatterData).name).toBe('quoted name')
      expect((result.frontmatter as FrontmatterData).description).toBe('single quoted')
    })

    it('should skip comments and blank lines', () => {
      const md = `---
# This is a comment
name: test

description: something
---
body
`
      const result = parseFrontmatter(md)
      expect((result.frontmatter as FrontmatterData).name).toBe('test')
      expect((result.frontmatter as FrontmatterData).description).toBe('something')
    })
  })

  describe('buildMemoryFile', () => {
    it('should build a valid memory file', () => {
      const result = buildMemoryFile({
        name: 'test-memory',
        description: 'A test',
        type: 'project',
        content: 'Hello world',
      })
      expect(result).toContain('name: test-memory')
      expect(result).toContain('description: A test')
      expect(result).toContain('type: project')
      expect(result).toContain('Hello world')
    })

    it('should escape values with special characters', () => {
      const result = buildMemoryFile({
        name: 'test: with colon',
        description: 'normal',
        type: 'project',
        content: 'body',
      })
      expect(result).toContain('"test: with colon"')
    })
  })
})
