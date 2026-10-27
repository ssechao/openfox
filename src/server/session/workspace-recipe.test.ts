import { describe, expect, it } from 'vitest'

import { WORKSPACE_COMMIT_RECIPE } from './manager.js'

describe('workspace commit recipe', () => {
  it('workspace commit recipe never merges into the original checked-out branch', () => {
    expect(WORKSPACE_COMMIT_RECIPE).not.toMatch(/\bgit merge\b/)
  })

  it('workspace commit recipe pushes the feature branch to the remote', () => {
    expect(WORKSPACE_COMMIT_RECIPE).toContain('git push origin <feature-slug>')
  })
})
