/**
 * Die if the parent process goes away. Used by every forked lock/demo child so a
 * killed vitest runner cannot leave an orphan holding the instance lock.
 */
export function installParentExitGuard(): void {
  const parent = process.ppid
  const die = (): void => {
    process.exit(0)
  }
  try {
    process.stdin.resume()
  } catch {
    // stdin may be ignored
  }
  process.stdin.on('end', die)
  process.stdin.on('close', die)
  const timer = setInterval(() => {
    if (process.ppid !== parent) {
      die()
      return
    }
    try {
      process.kill(parent, 0)
    } catch {
      die()
    }
  }, 200)
  timer.unref()
}
