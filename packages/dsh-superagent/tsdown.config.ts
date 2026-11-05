import { defineConfig } from 'tsdown'

// Two single-file outputs. The host half is an ESM Cordis plugin loaded by the
// dsh Loader; the browser half is CommonJS that scripts/wrap-client.mjs wraps in
// the dsh client Module Loader call, resolving React and the primitives from
// the page.
export default defineConfig([
  {
    entry: { index: 'src/host/index.ts' },
    format: 'esm',
    platform: 'node',
    target: 'node24',
    outDir: 'dist',
    clean: false,
    dts: false,
    outExtensions: () => ({ js: '.js' }),
  },
  {
    entry: { 'client.cjs': 'src/client/index.ts' },
    format: 'cjs',
    platform: 'neutral',
    target: 'es2022',
    outDir: 'dist',
    clean: false,
    dts: false,
    deps: { neverBundle: ['react', '@deepseek-ai/dsh-client-ui-primitives'] },
    outExtensions: () => ({ js: '.js' }),
  },
])
