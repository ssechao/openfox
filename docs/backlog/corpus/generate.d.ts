export function generateCorpus(
  dbPath: string,
  options?: { workdir?: string },
): {
  dbPath: string
  sessionId: string
  snapshotBytes: number
  roundTripHash: string
  roundTripMime: string
  roundTripBytes: number
  manifest: Record<string, unknown>
}

export function generateSearchCorpus(
  dbPath: string,
  options?: { workdir?: string; sessionCount?: number; postPairs?: number },
): {
  dbPath: string
  sessionCount: number
  eventCount: number
  fixtures: Record<string, string>
  manifest: Record<string, unknown>
}
