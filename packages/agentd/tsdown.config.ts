import { defineConfig, type UserConfig } from 'tsdown'

// Three builds, so each output is one self-contained file the mod can copy and run.
const single = (name: string, entry: string): UserConfig => ({
  entry: { [name]: entry },
  format: 'esm',
  platform: 'node',
  target: 'node24',
  outDir: 'dist',
  clean: false,
  dts: false,
  outExtensions: () => ({ js: '.mjs' }),
  banner: { js: '#!/usr/bin/env node' },
})

export default defineConfig([
  single('agentd', 'src/cli.ts'),
  single('agentd-mcp', 'src/mcp/server.ts'),
  single('agentd-hook', 'src/hook.ts'),
])
