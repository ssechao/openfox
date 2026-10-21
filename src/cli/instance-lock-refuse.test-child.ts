/**
 * Runs the real CLI serve path so lock refusal can be proven without opening
 * the sessions database.
 */
import { installParentExitGuard } from '../server/utils/parent-exit-guard.js'

installParentExitGuard()

const { runServe } = await import('./serve.js')

process.send?.({ ready: true, pid: process.pid })

await new Promise<void>((resolve) => {
  process.once('message', (message) => {
    if (message === 'go') resolve()
  })
})

try {
  await runServe({
    mode: 'development',
    openBrowser: false,
    port: Number(process.env['OPENFOX_PORT'] ?? 10620),
  })
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`${message}\n`)
  process.exit(1)
}
