// The engine lays this build's API types in .claude-plugin/types/ when it loads
// the mod; without them there is nothing to check against yet.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

if (!existsSync(new URL('../.claude-plugin/types/claude-code/index.d.ts', import.meta.url))) {
  console.log(
    'router-mod: no .claude-plugin/types yet (open a Router session once); skipping typecheck',
  )
  process.exit(0)
}
execFileSync('tsc', ['--noEmit', '-p', '.'], { stdio: 'inherit' })
