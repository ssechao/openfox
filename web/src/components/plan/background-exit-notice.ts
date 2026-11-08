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

function outputFrame(content: string): string | null {
  const start = content.indexOf('<process-output>')
  const end = content.indexOf('</process-output>')
  if (start < 0 || end < start) return null
  return decodeProcessEntities(
    content
      .slice(start + '<process-output>'.length, end)
      .replace(/^\n/, '')
      .replace(/\n$/, ''),
  )
}

function parseHeader(firstLine: string): Omit<BackgroundExitNotice, 'output'> | null {
  if (!firstLine.startsWith('Background process "')) return null
  const timeoutSuffix = ' was stopped by its timeout.'
  let body = firstLine
  let outcome: BackgroundExitNotice['outcome'] = 'exited'
  let exitCode: string | undefined
  if (body.endsWith(timeoutSuffix)) {
    outcome = 'timeout'
    body = body.slice(0, -timeoutSuffix.length)
  } else {
    const exited = / exited with code (\S+)\.$/.exec(body)
    if (!exited || exited.index === undefined || !exited[1]) return null
    exitCode = exited[1]
    body = body.slice(0, exited.index)
  }
  const idMatch = /" \(([^)]*)\)$/.exec(body)
  if (!idMatch || idMatch.index === undefined || idMatch[1] === undefined) return null
  return {
    name: decodeProcessEntities(body.slice('Background process "'.length, idMatch.index)),
    processId: decodeProcessEntities(idMatch[1]),
    outcome,
    ...(exitCode ? { exitCode } : {}),
  }
}

export function parseBackgroundExitNotice(content: string): BackgroundExitNotice | null {
  const output = outputFrame(content)
  if (output === null) return null
  const header = parseHeader(content.split('\n', 1)[0] ?? '')
  if (!header) return { name: '', processId: '', outcome: 'exited', output }
  return { ...header, output }
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
