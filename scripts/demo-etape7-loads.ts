export const MIN_EFFECTIVE_LOAD_MS = 2_000

export type DemoLoadName = 'git' | 'pdf' | 'stdout'

export interface DemoToolObservation {
  callId: string
  tool: string
  args: Record<string, unknown>
  startAt: number
  endAt: number
  result: { success: boolean; durationMs?: number } | null
}

export interface DemoLoadDetail {
  name: DemoLoadName
  tool: string
  runs: number
  success: boolean
  workMs: number
  observedMs: number
  overlapMs: number
}

const LOADS: Array<{ name: DemoLoadName; tool: string }> = [
  { name: 'git', tool: 'run_command' },
  { name: 'pdf', tool: 'read_file' },
  { name: 'stdout', tool: 'run_command' },
]

export function classifyLoad(observation: Pick<DemoToolObservation, 'tool' | 'args'>): DemoLoadName | null {
  if (observation.tool === 'read_file' && observation.args['path'] === 'demo.pdf') return 'pdf'
  if (observation.tool !== 'run_command') return null
  if (observation.args['command'] === 'node git-load.mjs') return 'git'
  if (observation.args['command'] === 'node stdout-load.mjs') return 'stdout'
  return null
}

export function summarizeLoadObservations(
  observations: DemoToolObservation[],
  streamStart: number,
  streamEnd: number,
): DemoLoadDetail[] {
  const details = new Map<DemoLoadName, DemoLoadDetail>(
    LOADS.map(({ name, tool }) => [
      name,
      { name, tool, runs: 0, success: true, workMs: 0, observedMs: 0, overlapMs: 0 },
    ]),
  )

  for (const observation of observations) {
    const name = classifyLoad(observation)
    if (!name || observation.endAt <= observation.startAt) continue
    const detail = details.get(name)!
    detail.runs += 1
    detail.success &&= observation.result?.success === true
    detail.workMs += observation.result?.durationMs ?? 0
    detail.observedMs += observation.endAt - observation.startAt
    const overlapStart = Math.max(observation.startAt, streamStart)
    const overlapEnd = Math.min(observation.endAt, streamEnd)
    detail.overlapMs += Math.max(0, overlapEnd - overlapStart)
  }

  return LOADS.map(({ name }) => details.get(name)!)
}

export function loadThresholdSatisfied(details: DemoLoadDetail[]): boolean {
  return (
    details.length === LOADS.length &&
    details.every(
      (load) =>
        load.success &&
        load.runs > 0 &&
        load.workMs >= MIN_EFFECTIVE_LOAD_MS &&
        load.overlapMs >= MIN_EFFECTIVE_LOAD_MS &&
        load.overlapMs === load.observedMs,
    )
  )
}
