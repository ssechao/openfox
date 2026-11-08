const EXITED = /^Background process "([^"]+)" \(([^)]+)\) exited with code (\S+)\.$/
const TIMED_OUT = /^Background process "([^"]+)" \(([^)]+)\) was stopped by its timeout\.$/

export function decodeProcessEntities(text: string): string {
  return text.replaceAll('&gt;', '>').replaceAll('&lt;', '<').replaceAll('&amp;', '&')
}

export interface BackgroundExitNotice {
  name: string
  processId: string
  outcome: 'exited' | 'timeout'
  exitCode?: string
  output: string
}

export function parseBackgroundExitNotice(content: string): BackgroundExitNotice | null {
  const firstLine = content.split('\n', 1)[0] ?? ''
  const exited = EXITED.exec(firstLine)
  const timedOut = TIMED_OUT.exec(firstLine)
  const matched = exited ?? timedOut
  if (!matched || !matched[1] || !matched[2]) return null
  const start = content.indexOf('<process-output>')
  const end = content.indexOf('</process-output>')
  if (start < 0 || end < start) return null
  const output = content
    .slice(start + '<process-output>'.length, end)
    .replace(/^\n/, '')
    .replace(/\n$/, '')
  const name = decodeProcessEntities(matched[1])
  const processId = decodeProcessEntities(matched[2])
  const visibleOutput = decodeProcessEntities(output)
  if (timedOut) {
    return { name, processId, outcome: 'timeout', output: visibleOutput }
  }
  return {
    name,
    processId,
    outcome: 'exited',
    ...(matched[3] ? { exitCode: matched[3] } : {}),
    output: visibleOutput,
  }
}

export function isBackgroundExitNotice(message: {
  content: string
  messageKind?: string
  isSystemGenerated?: boolean
}): boolean {
  if (message.messageKind === 'background-exit') return true
  return (
    message.isSystemGenerated === true &&
    message.messageKind === 'auto-prompt' &&
    parseBackgroundExitNotice(message.content) !== null
  )
}
