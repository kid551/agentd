// Wraps the CommonJS browser build in dsh's client Module Loader registration,
// the format every installed dsh.client bundle uses:
//   window.__ModuleLoader__.load({ id, factory: require => module.exports })
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist')
const cjs = readFileSync(join(dist, 'client.cjs.js'), 'utf8')
const wrapped = `window.__ModuleLoader__.load({
\tid: "dsh-superagent",
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
${cjs}
\t\treturn module.exports;
\t}
});
`
writeFileSync(join(dist, 'client.js'), wrapped)
rmSync(join(dist, 'client.cjs.js'))
console.log('wrapped dist/client.js')
