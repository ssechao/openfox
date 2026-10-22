/**
 * Attributes the server loop stalls recorded by the étape 3 demo to the code
 * that ran during them. Run the demo with ETAPE3_CPU_PROF_DIR=<dir> (one
 * directory per run), then: npx tsx e2e/utils/loop-stall-profile.ts <dir>...
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

interface ProfileNode {
  id: number
  callFrame: { functionName: string; url: string }
  children?: number[]
}

interface CpuProfile {
  nodes: ProfileNode[]
  startTime: number
  samples: number[]
  timeDeltas: number[]
}

interface StallDump {
  clock: { wallMs: number; hrtimeUs: number }
  phases: { createStarted: number; createEnded: number; deleteEnded: number; referenceEnded: number }
  openfox: Array<[number, number]>
  witness: Array<[number, number]>
}

const TOOLING = /node_modules\/(@babel|vite|@vitejs|react-refresh|postcss|tailwindcss)\//

function analyse(dir: string): void {
  const files = readdirSync(dir)
  const profFile = files.find((file) => file.endsWith('.cpuprofile'))
  const stallFile = files.find((file) => file.startsWith('stalls-'))
  if (!profFile || !stallFile) {
    console.log(`${dir}: missing profile or stall dump`)
    return
  }
  const profile = JSON.parse(readFileSync(join(dir, profFile), 'utf8')) as CpuProfile
  const dump = JSON.parse(readFileSync(join(dir, stallFile), 'utf8')) as StallDump
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]))
  const parents = new Map<number, number>()
  for (const node of profile.nodes) for (const child of node.children ?? []) parents.set(child, node.id)
  const times: number[] = []
  let clock = profile.startTime
  for (const delta of profile.timeDeltas) times.push((clock += delta))

  const frames = (id: number) => {
    const stack: Array<{ fn: string; url: string }> = []
    for (let current: number | undefined = id; current !== undefined; current = parents.get(current)) {
      const frame = nodes.get(current)!.callFrame
      if (frame.functionName === '(root)') break
      stack.push({
        fn: frame.functionName || '(anonymous)',
        url: frame.url.replace(/^file:\/\/.*?\/(src|node_modules)\//, '$1/'),
      })
    }
    return stack
  }
  const label = (stack: Array<{ fn: string; url: string }>) => {
    const leaf = stack[0]
    if (!leaf) return '(empty)'
    if (leaf.fn.startsWith('(')) return leaf.fn
    if (stack.some((frame) => TOOLING.test(frame.url))) return 'vite dev transform'
    const own = stack.filter((frame) => frame.url.startsWith('src/')).map((frame) => `${frame.url}#${frame.fn}`)
    return [...own.slice(0, 2).reverse(), `${leaf.url}#${leaf.fn}`].join(' > ')
  }

  const toProfileUs = (wallMs: number) => dump.clock.hrtimeUs - (dump.clock.wallMs - wallMs) * 1000
  const { createStarted, createEnded, deleteEnded, referenceEnded } = dump.phases
  const phaseOf = (wallMs: number) =>
    wallMs < createStarted
      ? null
      : wallMs < createEnded
        ? 'create'
        : wallMs < deleteEnded
          ? 'delete'
          : wallMs < referenceEnded
            ? 'reference'
            : null

  console.log(`\n${dir}: witness stalls > 100 ms: ${dump.witness.filter(([firedAt]) => phaseOf(firedAt)).length}`)
  for (const [firedAt, delay] of dump.openfox) {
    const phase = phaseOf(firedAt)
    if (!phase) continue
    const from = toProfileUs(firedAt - delay)
    const to = toProfileUs(firedAt)
    const counts = new Map<string, number>()
    let total = 0
    times.forEach((time, index) => {
      if (time < from || time > to) return
      total++
      const key = label(frames(profile.samples[index]!))
      counts.set(key, (counts.get(key) ?? 0) + 1)
    })
    const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 2)
    console.log(
      `  ${phase} ${delay.toFixed(0)} ms (${total} samples): ${top.map(([key, n]) => `[${n}] ${key}`).join(' | ')}`,
    )
  }
}

for (const dir of process.argv.slice(2)) analyse(dir)
