import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { resolveTemplate, type TemplateContext } from './template.js'

const workflow = JSON.parse(readFileSync(new URL('./defaults/default.workflow.json', import.meta.url), 'utf8')) as {
  steps: Array<{ id: string; nudgePrompt?: string }>
}
const nudgePrompt = workflow.steps.find((step) => step.id === 'build')!.nudgePrompt!

const ctx: TemplateContext = {
  workdir: '/test',
  reason: '2 criteria remaining',
  verifierFindings: '',
  previousStepOutput: '',
  criteriaCount: 2,
  pendingCount: 2,
  criteriaList: '',
  modifiedFiles: '',
  stepOutput: {},
  params: {},
}

describe('default workflow build nudge', () => {
  it.fails('does not ask to fix issues when the verifier reported none', () => {
    const nudge = resolveTemplate(nudgePrompt, ctx)
    expect(nudge).not.toContain('Fix the issues above')
    expect(nudge).toContain('Continue working on the acceptance criteria. 2 criteria remaining.')
  })

  it.fails('keeps the verifier findings in the build nudge', () => {
    const nudge = resolveTemplate(nudgePrompt, {
      ...ctx,
      stepOutput: { content: 'c2 failed: test missing' },
    })
    expect(nudge).toContain('c2 failed: test missing')
    expect(nudge).toContain('if the verifier reported failures above, fix them first')
  })
})
