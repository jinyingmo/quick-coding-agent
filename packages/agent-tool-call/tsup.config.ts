import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts', 'src/memoryCli.ts', 'src/serverCli.ts'],
  outDir: 'dist',
  format: ['esm', 'cjs'],
  target: 'es2022',
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  treeshake: true,
})
