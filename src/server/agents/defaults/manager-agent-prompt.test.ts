import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const managerPromptUrl = new URL('./manager.agent.md', import.meta.url)

describe('manager agent prompt', () => {
  it('mandate', async () => {
    const prompt = await readFile(managerPromptUrl, 'utf8')

    expect(prompt).not.toContain('Finish after reporting')
    expect(prompt).not.toContain('return control')
    expect(prompt).not.toContain('ask the user to launch')
    expect(prompt).toContain('## Mandate')
    expect(prompt).toContain("The project's piloting skill refines this prompt and takes precedence on conflict.")
  })
})
