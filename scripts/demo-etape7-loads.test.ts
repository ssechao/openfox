import { describe, expect, it } from 'vitest'
import {
  MIN_EFFECTIVE_LOAD_MS,
  loadThresholdSatisfied,
  summarizeLoadObservations,
  type DemoToolObservation,
} from './demo-etape7-loads.js'

function observation(
  callId: string,
  tool: string,
  args: Record<string, unknown>,
  startAt: number,
  endAt: number,
  success = true,
  durationMs = endAt - startAt,
): DemoToolObservation {
  return {
    callId,
    tool,
    args,
    startAt,
    endAt,
    result: { success, durationMs },
  }
}

describe('stage 7 effective load accounting', () => {
  it('requires at least two seconds of measured in-stream work for every repeated real load', () => {
    const streamStart = 1_000
    const streamEnd = 20_000
    const details = summarizeLoadObservations(
      [
        observation('git-1', 'run_command', { command: 'node git-load.mjs' }, 1_100, 2_150),
        observation('git-2', 'run_command', { command: 'node git-load.mjs' }, 2_150, 3_200),
        observation('pdf-1', 'read_file', { path: 'demo.pdf' }, 3_200, 3_900),
        observation('pdf-2', 'read_file', { path: 'demo.pdf' }, 3_900, 4_600),
        observation('pdf-3', 'read_file', { path: 'demo.pdf' }, 4_600, 5_300),
        observation('stdout-1', 'run_command', { command: 'node stdout-load.mjs' }, 5_300, 7_300),
        observation('hold', 'run_command', { command: 'exec sleep 120' }, 7_300, 19_000),
      ],
      streamStart,
      streamEnd,
    )

    expect(details).toEqual([
      expect.objectContaining({ name: 'git', runs: 2, workMs: 2_100, overlapMs: 2_100, success: true }),
      expect.objectContaining({ name: 'pdf', runs: 3, workMs: 2_100, overlapMs: 2_100, success: true }),
      expect.objectContaining({ name: 'stdout', runs: 1, workMs: 2_000, overlapMs: 2_000, success: true }),
    ])
    expect(MIN_EFFECTIVE_LOAD_MS).toBe(2_000)
    expect(loadThresholdSatisfied(details)).toBe(true)
  })

  it('rejects observed time that does not contain two seconds of effective tool work', () => {
    const details = summarizeLoadObservations(
      [
        observation('git-1', 'run_command', { command: 'node git-load.mjs' }, 100, 2_200, true, 1_999),
        observation('pdf-1', 'read_file', { path: 'demo.pdf' }, 2_200, 4_200),
        observation('stdout-1', 'run_command', { command: 'node stdout-load.mjs' }, 4_200, 6_200),
      ],
      100,
      7_000,
    )

    expect(details.find((load) => load.name === 'git')).toMatchObject({
      workMs: 1_999,
      observedMs: 2_100,
      overlapMs: 2_100,
    })
    expect(loadThresholdSatisfied(details)).toBe(false)
  })

  it('rejects a load that is not fully inside the stream or has a failed repetition', () => {
    const details = summarizeLoadObservations(
      [
        observation('git-1', 'run_command', { command: 'node git-load.mjs' }, 0, 2_100),
        observation('pdf-1', 'read_file', { path: 'demo.pdf' }, 101, 2_101),
        observation('stdout-1', 'run_command', { command: 'node stdout-load.mjs' }, 200, 1_200),
        observation('stdout-2', 'run_command', { command: 'node stdout-load.mjs' }, 1_200, 2_200, false),
      ],
      100,
      5_000,
    )

    expect(details.find((load) => load.name === 'git')).toMatchObject({ observedMs: 2_100, overlapMs: 2_000 })
    expect(loadThresholdSatisfied(details)).toBe(false)
  })
})
