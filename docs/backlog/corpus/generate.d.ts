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
