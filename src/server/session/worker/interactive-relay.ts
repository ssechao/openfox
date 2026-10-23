import type { ChoiceOption } from '../../../shared/protocol.js'
import type { PathDenialReason } from '../../tools/path-security.js'

export interface WorkerQuestionPrompt {
  callId: string
  sessionId: string
  question: string
  type: 'text' | 'confirm' | 'choice'
  options?: ChoiceOption[]
}

export interface WorkerPathPrompt {
  callId: string
  paths: string[]
  sessionId: string
  tool: string
  workdir: string
  reason: PathDenialReason
}

export interface WorkerInteractiveRelay {
  question: (prompt: WorkerQuestionPrompt) => void
  path: (prompt: WorkerPathPrompt) => void
}

let relay: WorkerInteractiveRelay | null = null

export function setWorkerInteractiveRelay(next: WorkerInteractiveRelay | null): void {
  relay = next
}

export function relayWorkerQuestion(prompt: WorkerQuestionPrompt): void {
  relay?.question(prompt)
}

export function relayWorkerPath(prompt: WorkerPathPrompt): void {
  relay?.path(prompt)
}
