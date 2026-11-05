// node:sqlite prints an ExperimentalWarning on load in Node 24; it is the one
// warning this daemon expects, so it is dropped here, before anything imports it.
const emit = process.emitWarning.bind(process)
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === 'string' ? warning : warning.message
  if (/SQLite is an experimental feature/.test(text)) return
  return (emit as (...args: unknown[]) => void)(warning, ...rest)
}) as typeof process.emitWarning
