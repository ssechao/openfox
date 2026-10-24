/**
 * Shell command execution for workflow shell steps.
 */

import { checkAborted, spawnShellProcess } from '../utils/shell.js'
import { terminateProcessTree } from '../utils/process-tree.js'
import { decodeUtf8 } from '../utils/utf8.js'

export interface ShellResult {
  exitCode: number
  stdout: string
  stderr: string
  success: boolean
}

/**
 * Execute a shell command with timeout and abort support.
 * Returns the exit code, stdout, and stderr.
 */
export function executeShellCommand(
  command: string,
  cwd: string,
  timeout: number,
  signal?: AbortSignal,
): Promise<ShellResult> {
  return new Promise((resolve, reject) => {
    if (checkAborted(signal)) {
      reject(new Error('Aborted'))
      return
    }

    const proc = spawnShellProcess(command, cwd, signal)
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let killed = false

    const timer = setTimeout(() => {
      killed = true
      void terminateProcessTree(proc)
      resolve({
        exitCode: 1,
        stdout: decodeUtf8(stdoutChunks),
        stderr: decodeUtf8(stderrChunks) + '\nCommand timed out',
        success: false,
      })
    }, timeout)

    const onAbort = () => {
      if (!killed) {
        killed = true
        clearTimeout(timer)
        void terminateProcessTree(proc, { immediate: true })
          .catch(() => undefined)
          .then(() => reject(new Error('Aborted')))
      }
    }
    signal?.addEventListener('abort', onAbort)

    proc.stdout?.on('data', (data: Buffer) => {
      stdoutChunks.push(data)
    })
    proc.stderr?.on('data', (data: Buffer) => {
      stderrChunks.push(data)
    })

    proc.on('close', (code) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (killed) return
      const exitCode = code ?? 1
      resolve({
        exitCode,
        stdout: decodeUtf8(stdoutChunks),
        stderr: decodeUtf8(stderrChunks),
        success: exitCode === 0,
      })
    })

    proc.on('error', (err) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (killed) return
      resolve({ exitCode: 1, stdout: decodeUtf8(stdoutChunks), stderr: err.message, success: false })
    })
  })
}
