/**
 * Live edit context for streaming edit_file calls.
 *
 * While the LLM is still generating an edit_file call, its tool.preparing
 * events carry partial JSON arguments. This helper reads the target file once
 * and computes the same edit context (surrounding lines) that the final tool
 * result carries, so the UI can render the context live while streaming.
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { EditContextRegion } from '../../shared/types.js'
import { parsePartialFileArgs } from '../../shared/partial-tool-args.js'
import { extractEditContext } from '../../shared/edit-context.js'

/**
 * Compute the edit context for a partial edit_file arguments fragment.
 *
 * The file content is read at most once per resolved path (cache). Returns
 * undefined when the fragment is incomplete, the file is unreadable, or the
 * edit does not match the file yet — the caller then falls back to the plain
 * old/new diff.
 */
export async function computeLiveEditContext(
  argsFragment: string | undefined,
  workdir: string,
  cache: Map<string, string>,
): Promise<EditContextRegion[] | undefined> {
  if (!argsFragment) return undefined
  const parsed = parsePartialFileArgs(argsFragment)
  if (!parsed.path || (!parsed.old_string && !parsed.new_string)) return undefined

  const fullPath = resolve(workdir, parsed.path)
  let content = cache.get(fullPath)
  if (content === undefined) {
    try {
      content = await readFile(fullPath, 'utf8')
    } catch {
      cache.set(fullPath, '')
      return undefined
    }
    cache.set(fullPath, content)
  }
  if (!content) return undefined

  const { regions } = extractEditContext(
    content,
    parsed.old_string ?? '',
    parsed.new_string ?? '',
    parsed.replace_all ?? false,
  )
  return regions.length > 0 ? regions : undefined
}

interface LiveEditTrackState {
  oldString: string | undefined
  newString: string | undefined
  regions: EditContextRegion[] | undefined
  lastEmitted: EditContextRegion[] | undefined
}

function sameRegions(a: EditContextRegion[], b: EditContextRegion[] | undefined): boolean {
  return b !== undefined && JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Per-index tracker for live edit context enrichment of streaming edit_file
 * preparing events.
 *
 * Two dedupes keep a burst of parallel edits cheap:
 * - `extractEditContext` over the file runs only when the parsed old/new
 *   strings changed since the previous preparing event for the same index
 *   (otherwise the cached regions are reused);
 * - an editContext payload is emitted only when it differs from the last one
 *   sent for that index, so byte-identical chunks don't re-send redundant
 *   context over the WebSocket.
 */
export class LiveEditContextTracker {
  private byIndex = new Map<number, LiveEditTrackState>()

  /**
   * Decide the editContext payload for the next tool.preparing event of an
   * edit_file call. Returns the regions to attach (or undefined to omit them).
   *
   * `compute` defaults to computeLiveEditContext; tests inject a stub to count
   * recomputes.
   */
  async next(
    index: number,
    argsFragment: string | undefined,
    workdir: string,
    cache: Map<string, string>,
    compute: (fragment: string | undefined) => Promise<EditContextRegion[] | undefined> = (fragment) =>
      computeLiveEditContext(fragment, workdir, cache),
  ): Promise<EditContextRegion[] | undefined> {
    const state: LiveEditTrackState = this.byIndex.get(index) ?? {
      oldString: undefined,
      newString: undefined,
      regions: undefined,
      lastEmitted: undefined,
    }
    const args = parsePartialFileArgs(argsFragment)
    const specChanged = args.old_string !== state.oldString || args.new_string !== state.newString
    state.oldString = args.old_string
    state.newString = args.new_string

    if (specChanged) {
      const computed = await compute(argsFragment)
      if (computed && computed.length > 0) {
        state.regions = computed
      } else {
        // A stale match (old_string changed to a non-matching form) must drop,
        // along with the last-emitted dedupe state so a later identical rematch
        // is re-emitted.
        state.regions = undefined
        state.lastEmitted = undefined
      }
    }

    const regions = state.regions
    const toEmit = regions && regions.length > 0 && !sameRegions(regions, state.lastEmitted) ? regions : undefined
    if (toEmit) state.lastEmitted = toEmit
    this.byIndex.set(index, state)
    return toEmit
  }
}
