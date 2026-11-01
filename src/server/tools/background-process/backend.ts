import { executeBackgroundAction, type BackgroundActionResult, type BackgroundProcessToolArgs } from './actions.js'

export type BackgroundProcessBackend = (
  sessionId: string,
  defaultCwd: string,
  args: BackgroundProcessToolArgs,
) => Promise<BackgroundActionResult>

let backend: BackgroundProcessBackend = executeBackgroundAction

export function setBackgroundProcessBackend(next: BackgroundProcessBackend): void {
  backend = next
}

export function runBackgroundAction(
  sessionId: string,
  defaultCwd: string,
  args: BackgroundProcessToolArgs,
): Promise<BackgroundActionResult> {
  return backend(sessionId, defaultCwd, args)
}
