import type { GitDiffFile } from '../../shared/protocol.js'
import type { PluginVcsContext } from '../../plugin/index.js'
import { spawnGitProcess } from './spawn.js'
import { GIT_QUERY_TIMEOUT_MS } from '../utils/bounded-exec.js'
import { logger } from '../utils/logger.js'
import { terminateProcessTree } from '../utils/process-tree.js'
import { resolveVcsBranch, resolveVcsDiffFiles, resolveVcsModifiedFiles } from '../plugins/vcs-providers.js'

type NativeGitRunner = (cwd: string, args: string[]) => Promise<{ code: number | null; stdout: string }>

let externalGitRunner: NativeGitRunner | null = null

export function setExternalGitRunner(runner: NativeGitRunner | null): void {
  externalGitRunner = runner
}

function toVcsContext(cwd: string, context?: { sessionId?: string; projectId?: string }): PluginVcsContext {
  return {
    workdir: cwd,
    ...(context?.sessionId !== undefined ? { sessionId: context.sessionId } : {}),
    ...(context?.projectId !== undefined ? { projectId: context.projectId } : {}),
  }
}

async function nativeGetGitDiffFiles(cwd: string): Promise<GitDiffFile[]> {
  const diff = await runGitText(cwd, ['diff', '--ignore-submodules=none', '--name-status', 'HEAD'])
  const status = await runGitText(cwd, ['status', '--porcelain', '--ignore-submodules=none'])
  const files: GitDiffFile[] = []

  if (diff.code === 0) {
    for (const line of diff.stdout.split('\n')) {
      if (!line.trim()) continue
      const [statusChar, ...pathParts] = line.split('\t')
      const path = pathParts.join('\t') || statusChar || ''
      if (!path) continue
      const fileStatus = statusChar === 'A' ? 'added' : statusChar === 'D' ? 'deleted' : 'modified'
      files.push({ path, status: fileStatus, additions: 0, deletions: 0 })
    }
  }

  if (status.code === 0) {
    for (const line of status.stdout.split('\n')) {
      if (!line.startsWith('?? ')) continue
      const path = line.slice(3).trim()
      if (!path) continue
      files.push({ path, status: 'added', additions: 0, deletions: 0 })
    }
  }

  return files
}

export async function getGitDiffFiles(
  cwd: string,
  context?: { sessionId?: string; projectId?: string },
): Promise<GitDiffFile[]> {
  const pluginDiffFiles = await resolveVcsDiffFiles(toVcsContext(cwd, context))

  if (pluginDiffFiles !== null) {
    return pluginDiffFiles.map((file) => ({
      path: file.path,
      status: file.status,
      additions: file.additions ?? 0,
      deletions: file.deletions ?? 0,
    }))
  }

  return nativeGetGitDiffFiles(cwd)
}

export async function formatGitDiffFiles(
  cwd: string,
  context?: { sessionId?: string; projectId?: string },
): Promise<string> {
  const pluginFormatted = await resolveVcsModifiedFiles(toVcsContext(cwd, context))

  if (pluginFormatted !== null) {
    return pluginFormatted
  }

  const files = await getGitDiffFiles(cwd, context)
  if (files.length === 0) return '(none)'
  return files.map((f) => `- ${f.path} (${f.status})`).join('\n')
}

function runGitText(cwd: string, args: string[]): Promise<{ code: number | null; stdout: string }> {
  if (externalGitRunner) return externalGitRunner(cwd, args)
  return new Promise((resolve) => {
    const proc = spawnGitProcess(cwd, args)
    let stdout = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      logger.warn('git command timed out, killing its process tree', {
        cwd,
        args,
        timeoutMs: GIT_QUERY_TIMEOUT_MS,
      })
      void terminateProcessTree(proc)
        .catch(() => undefined)
        .then(() => resolve({ code: null, stdout: '' }))
    }, GIT_QUERY_TIMEOUT_MS)
    const finish = (code: number | null, output: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout: output })
    }
    proc.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString()
    })
    proc.on('close', (code) => finish(code, stdout))
    proc.on('error', () => finish(null, ''))
  })
}

const REVIEW_DIFF_TOTAL_BYTES = 200 * 1024
const REVIEW_DIFF_UNTRACKED_FILE_BYTES = 64 * 1024
const REVIEW_DIFF_MARKER_RESERVE_BYTES = 256

type ReviewDiffEntry = {
  text: string
  omittedBytes: number
}

function truncateUtf8(text: string, maxBytes: number): ReviewDiffEntry {
  const bytes = Buffer.from(text)
  if (bytes.length <= maxBytes) return { text, omittedBytes: 0 }
  let end = maxBytes
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--
  return {
    text: bytes.subarray(0, end).toString('utf8'),
    omittedBytes: bytes.length - end,
  }
}

function splitTrackedDiff(diff: string): ReviewDiffEntry[] {
  return diff
    .trimEnd()
    .split(/(?=^diff --git )/m)
    .filter(Boolean)
    .map((text) => ({ text, omittedBytes: 0 }))
}

function renderReviewDiff(entries: ReviewDiffEntry[]): string {
  const contentBudget = REVIEW_DIFF_TOTAL_BYTES - REVIEW_DIFF_MARKER_RESERVE_BYTES
  const rendered: string[] = []
  let usedBytes = 0
  let omittedBytes = 0
  let omittedFiles = 0

  for (const entry of entries) {
    const separatorBytes = rendered.length > 0 ? 1 : 0
    const availableBytes = Math.max(0, contentBudget - usedBytes - separatorBytes)
    const truncated = truncateUtf8(entry.text, availableBytes)
    if (truncated.text) {
      rendered.push(truncated.text)
      usedBytes += separatorBytes + Buffer.byteLength(truncated.text)
    }
    const entryOmittedBytes = entry.omittedBytes + truncated.omittedBytes
    if (entryOmittedBytes > 0) {
      omittedFiles++
      omittedBytes += entryOmittedBytes
    }
  }

  if (omittedBytes === 0) return rendered.length > 0 ? rendered.join('\n') : '(none)'
  const fileLabel = omittedFiles === 1 ? 'file' : 'files'
  const marker = `[Diff truncated: ${omittedFiles} ${fileLabel}, ${omittedBytes} bytes omitted]`
  return rendered.length > 0 ? `${rendered.join('\n')}\n${marker}` : marker
}

export async function formatGitReviewDiff(cwd: string): Promise<string> {
  let base: string | undefined
  for (const ref of ['main', 'origin/main', 'develop', 'origin/develop']) {
    const verified = await runGitText(cwd, ['rev-parse', '--verify', ref])
    if (verified.code !== 0) continue
    const merged = await runGitText(cwd, ['merge-base', 'HEAD', ref])
    if (merged.code === 0 && merged.stdout.trim()) {
      base = merged.stdout.trim()
      break
    }
  }

  const tracked = await runGitText(cwd, [
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--ignore-submodules=none',
    base ?? 'HEAD',
  ])
  const entries = splitTrackedDiff(tracked.stdout)
  const untracked = await runGitText(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])
  if (untracked.code === 0) {
    for (const path of untracked.stdout.split('\0').filter(Boolean)) {
      const fileDiff = await runGitText(cwd, [
        'diff',
        '--no-index',
        '--no-ext-diff',
        '--no-textconv',
        '--',
        '/dev/null',
        path,
      ])
      if (fileDiff.stdout.trim()) {
        entries.push(truncateUtf8(fileDiff.stdout.trimEnd(), REVIEW_DIFF_UNTRACKED_FILE_BYTES))
      }
    }
  }
  return renderReviewDiff(entries)
}

export async function nativeGetGitBranch(cwd: string): Promise<string | null> {
  const { code, stdout } = await runGitText(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  return code === 0 && stdout.trim() ? stdout.trim() : null
}

export async function getGitBranch(
  cwd: string,
  context?: { sessionId?: string; projectId?: string },
): Promise<string | null> {
  const pluginBranch = await resolveVcsBranch(toVcsContext(cwd, context))

  if (pluginBranch !== undefined) {
    return pluginBranch
  }

  return nativeGetGitBranch(cwd)
}
