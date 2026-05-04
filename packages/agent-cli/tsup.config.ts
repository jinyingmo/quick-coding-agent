import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/cli.ts'],
  outDir: 'dist',
  format: ['esm'],
  target: 'es2022',
  dts: false,
  clean: true,
  sourcemap: false,
  // Bundle ink and react into the output to avoid runtime dependency issues
  noExternal: ['ink', 'react', 'react-reconciler'],
  external: ['@quick-coding-agent/agent-tool-call', 'react-devtools-core'],
  esbuildOptions(options) {
    options.jsx = 'automatic'
  },
})
