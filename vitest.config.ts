import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    includes: ['packages/*/tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['packages/*/src/**/*.ts'],
      exclude: ['packages/*/src/**/*.test.ts', 'packages/*/src/cli.ts'],
    },
  },
})
