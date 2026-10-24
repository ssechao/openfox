export function linkAbortSignal(source: AbortSignal, abort: () => void): () => void {
  if (source.aborted) {
    abort()
    return () => {}
  }

  const onAbort = () => abort()
  source.addEventListener('abort', onAbort, { once: true })
  return () => source.removeEventListener('abort', onAbort)
}
