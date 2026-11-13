/**
 * Agent Registry Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  loadAllAgents,
  loadDefaultAgents,
  loadProjectAgents,
  findAgentById,
  getSubAgents,
  getTopLevelAgents,
  saveAgent,
  deleteAgent,
  isDefaultAgent,
  getDefaultAgentIds,
  saveAgentToProject,
  deleteProjectAgent,
} from './registry.js'
import type { AgentDefinition } from './types.js'

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'agent-registry-test-'))
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

function getPromptClause(prompt: string, marker: string): string {
  const clause = prompt.split('\n').find((line) => line.includes(marker))
  expect(clause).toBeDefined()
  return clause ?? ''
}

function expectNativeReviewerClause(prompt: string): void {
  const clause = getPromptClause(prompt, 'after an identifiable dev deliverable')
  expect(clause).toContain('openfox_create_session')
  expect(clause).toContain('distinct reviewer session')
  expect(clause).toContain('same target projectid')
  expect(clause).toContain('same kanban card')
  expect(clause).toContain('explicit title')
  expect(clause).toContain('appropriate reviewer agent')
}

function expectVerifiedLaunchClause(prompt: string): void {
  const clause = getPromptClause(prompt, 'do not announce a session as launched until')
  expect(clause).toContain('sessionid')
  expect(clause).toContain('projectid')
  expect(clause).toContain('workspace and branch')
  expect(clause).toContain('approved criteria')
}

describe('loadDefaultAgents', () => {
  it('should load all built-in agent definitions', async () => {
    const agents = await loadDefaultAgents()

    expect(agents.length).toBeGreaterThanOrEqual(5)

    const ids = agents.map((a) => a.metadata.id)
    expect(ids).toContain('planner')
    expect(ids).toContain('builder')
    expect(ids).toContain('verifier')
    expect(ids).toContain('code_reviewer')
    expect(ids).toContain('explorer')
  })

  it('should parse agent metadata correctly', async () => {
    const agents = await loadDefaultAgents()
    const verifier = agents.find((a) => a.metadata.id === 'verifier')!

    expect(verifier.metadata.name).toBe('Verifier')
    expect(verifier.metadata.description).toBe('Verifies completed criteria against actual code changes')
    expect(verifier.metadata.subagent).toBe(true)
    expect(verifier.metadata.allowedTools).toEqual([
      'read_file',
      'run_command',
      'session_metadata',
      'web_fetch',
      'load_skill',
    ])
    expect(verifier.prompt).toContain('independent verification')
  })

  it('should distinguish subagent vs top-level agents', async () => {
    const agents = await loadDefaultAgents()
    const planner = agents.find((a) => a.metadata.id === 'planner')!
    const builder = agents.find((a) => a.metadata.id === 'builder')!
    const verifier = agents.find((a) => a.metadata.id === 'verifier')!

    expect(planner.metadata.subagent).toBe(false)
    expect(builder.metadata.subagent).toBe(false)
    expect(verifier.metadata.subagent).toBe(true)
  })

  it('should load Manager as a top-level coordination agent', async () => {
    const agents = await loadDefaultAgents()
    const manager = agents.find((agent) => agent.metadata.id === 'manager')

    expect(manager).toBeDefined()
    expect(getTopLevelAgents(agents)).toContain(manager)
    expect(manager?.metadata).toEqual({
      id: 'manager',
      name: 'Manager',
      description: 'Manages project tasks and coordinates specialized sessions',
      subagent: false,
      color: '#0d9488',
      allowedTools: [
        'read_file',
        'describe_image',
        'web_fetch',
        'web_search',
        'ask_user',
        'session_metadata',
        'load_skill',
        'project_tasks',
      ],
    })

    const prompt = manager?.prompt.toLowerCase() ?? ''
    expect(prompt).toContain('kanban')
    expect(prompt).toContain('criteria')
    expect(prompt).toContain('workflows')
    expect(prompt).toContain('sessions')
    expect(prompt).toContain('do not write or modify code')
    expect(prompt).toContain('aether is the exclusive channel')
    expect(prompt).toContain('never stop a session during its turn')
    expect(prompt).toContain('explicit go')
    expect(prompt).toContain('production deployment')
    expect(prompt).toContain('restart')
    expect(prompt).toContain('destructive action')
    expect(prompt).toContain('while')
    expect(prompt).toContain('sleep')
    expect(prompt).toContain('automatic wake')
    expect(prompt).toContain('finish after reporting the requested status')
    expect(prompt).toContain('only the actions explicitly requested')
  })

  it('instructs Manager to select foreign projects explicitly without starting them before M3', async () => {
    const agents = await loadDefaultAgents()
    const manager = agents.find((agent) => agent.metadata.id === 'manager')
    const prompt = manager?.prompt.toLowerCase() ?? ''

    expect(prompt).toContain('explicit projectid')
    expect(prompt).toContain('foreign')
    expect(prompt).toContain('in_progress')
    expect(prompt).toContain('m3')
  })

  it('Manager requires a dedicated session for a new task and forbids unrelated session reuse', async () => {
    const agents = await loadDefaultAgents()
    const manager = agents.find((agent) => agent.metadata.id === 'manager')
    const prompt = manager?.prompt.toLowerCase() ?? ''

    expect.soft(prompt).toContain('create a dedicated session for every new task')
    expect.soft(prompt).toContain('never reuse a session for an unrelated task')
  })

  it('Manager uses an executable Kanban handoff for dedicated session launch', async () => {
    const agents = await loadDefaultAgents()
    const manager = agents.find((agent) => agent.metadata.id === 'manager')
    const prompt = manager?.prompt.toLowerCase() ?? ''

    expect.soft(prompt).toContain('prepare the kanban card for launch')
    expect.soft(prompt).toContain('never use `move in_progress` from the manager session')
    expect.soft(prompt).toContain('ask the user to launch the prepared task')
    expect.soft(prompt).toContain('never reuse an existing session as a fallback')
    expect
      .soft(prompt)
      .toContain('verify the identity of the newly launched session before sending its brief through aether')
  })

  it('Manager gates session reuse on proven task continuity and defines contamination recovery', async () => {
    const agents = await loadDefaultAgents()
    const manager = agents.find((agent) => agent.metadata.id === 'manager')
    const prompt = manager?.prompt.toLowerCase() ?? ''

    expect.soft(prompt).toContain('reuse a session only when all five continuity checks are proven')
    expect.soft(prompt).toContain('same projectid')
    expect.soft(prompt).toContain('same kanban card or task')
    expect.soft(prompt).toContain('recent conversation is compatible with the task')
    expect.soft(prompt).toContain('session is idle and stable')
    expect.soft(prompt).toContain('user explicitly requested continuation')
    expect.soft(prompt).toContain('if any check is missing or uncertain, create a dedicated session')
    expect.soft(prompt).toContain('if a session is contaminated')
    expect.soft(prompt).toContain('stop sending messages to it')
    expect.soft(prompt).toContain('report the contamination')
    expect.soft(prompt).toContain('preserve the session for investigation')
    expect.soft(prompt).toContain('continue in a new dedicated session')
  })

  it('Manager creates a dedicated Dev session natively in the target project and delegates card binding', async () => {
    const agents = await loadDefaultAgents()
    const manager = agents.find((agent) => agent.metadata.id === 'manager')
    const prompt = manager?.prompt.toLowerCase() ?? ''

    expect.soft(prompt).toContain('openfox_create_session')
    expect.soft(prompt).toContain('target projectid')
    expect.soft(prompt).toContain('explicit title')
    expect.soft(prompt).toContain('appropriate dev agent')
    expect.soft(prompt).toContain('new dedicated dev session')
    expect.soft(prompt).toContain('the dedicated dev binds its own card')
  })

  it('Manager creates a distinct Reviewer session natively in the target project after an identifiable Dev deliverable', async () => {
    const agents = await loadDefaultAgents()
    const manager = agents.find((agent) => agent.metadata.id === 'manager')
    const prompt = manager?.prompt.toLowerCase() ?? ''

    expectNativeReviewerClause(prompt)

    const reviewerClause = getPromptClause(prompt, 'after an identifiable dev deliverable')
    const peerCreatedReviewer = prompt.replace(
      reviewerClause,
      reviewerClause.replace('use `openfox_create_session` to create', 'ask a peer to create'),
    )
    expect(peerCreatedReviewer).not.toBe(prompt)
    expect(() => expectNativeReviewerClause(peerCreatedReviewer)).toThrow()
  })

  it('Manager never uses operational or existing sessions as a launch fallback and only announces verified launches', async () => {
    const agents = await loadDefaultAgents()
    const manager = agents.find((agent) => agent.metadata.id === 'manager')
    const prompt = manager?.prompt.toLowerCase() ?? ''

    expect.soft(prompt).toContain('never use restarter')
    expect.soft(prompt).toContain('aether remote agent')
    expect.soft(prompt).toContain('never use an existing session as a launcher or fallback')
    expectVerifiedLaunchClause(prompt)
    expect.soft(prompt).toContain('reuse a session only when all five continuity checks are proven')
    expect.soft(prompt).toContain('brief through aether')

    const launchClause = getPromptClause(prompt, 'do not announce a session as launched until')
    const incompleteAnnouncement = prompt.replace(
      launchClause,
      launchClause.replace(
        'sessionid, projectid, workspace and branch, and approved criteria',
        'sessionid, workspace and branch',
      ),
    )
    expect(incompleteAnnouncement).not.toBe(prompt)
    expect(() => expectVerifiedLaunchClause(incompleteAnnouncement)).toThrow()
  })
})

describe('loadAllAgents', () => {
  it('should merge built-in and user agents, with user overriding by id', async () => {
    const agentsDir = join(tempDir, 'agents')
    await mkdir(agentsDir, { recursive: true })
    await writeFile(
      join(agentsDir, 'verifier.agent.md'),
      `---
id: verifier
name: Custom Verifier
description: My custom verifier
subagent: true
tools:
  - read_file
  - pass_criterion
---

Custom verifier instructions.
`,
    )

    const agents = await loadAllAgents(tempDir)
    const verifier = agents.find((a) => a.metadata.id === 'verifier')!

    expect(verifier.metadata.name).toBe('Custom Verifier')
    expect(verifier.prompt).toBe('Custom verifier instructions.')
  })

  it('should include user-defined agents alongside built-in', async () => {
    const agentsDir = join(tempDir, 'agents')
    await mkdir(agentsDir, { recursive: true })
    await writeFile(
      join(agentsDir, 'security-auditor.agent.md'),
      `---
id: security_auditor
name: Security Auditor
description: Audit code for security issues
subagent: true
tools:
  - read_file
  - grep
---

Audit the code for OWASP top 10 vulnerabilities.
`,
    )

    const agents = await loadAllAgents(tempDir)
    const auditor = agents.find((a) => a.metadata.id === 'security_auditor')

    expect(auditor).toBeDefined()
    expect(auditor!.metadata.name).toBe('Security Auditor')
    expect(auditor!.metadata.subagent).toBe(true)
  })
})

describe('filter helpers', () => {
  it('should separate subagents from top-level agents', async () => {
    const agents = await loadDefaultAgents()
    const subs = getSubAgents(agents)
    const topLevel = getTopLevelAgents(agents)

    expect(subs.every((a) => a.metadata.subagent)).toBe(true)
    expect(topLevel.every((a) => !a.metadata.subagent)).toBe(true)
    expect(subs.length + topLevel.length).toBe(agents.length)
  })

  it('findAgentById returns correct agent', async () => {
    const agents = await loadDefaultAgents()
    const explorer = findAgentById('explorer', agents)
    expect(explorer).toBeDefined()
    expect(explorer!.metadata.name).toBe('Explorer')

    expect(findAgentById('nonexistent', agents)).toBeUndefined()
  })
})

describe('CRUD', () => {
  it('should save and load a user agent', async () => {
    const agent: AgentDefinition = {
      metadata: {
        id: 'my_agent',
        name: 'My Agent',
        description: 'Test agent',
        subagent: true,
        allowedTools: ['read_file'],
      },
      prompt: 'Do the thing.',
    }

    await saveAgent(tempDir, agent)
    const agents = await loadAllAgents(tempDir)
    const loaded = agents.find((a) => a.metadata.id === 'my_agent')

    expect(loaded).toBeDefined()
    expect(loaded!.metadata.name).toBe('My Agent')
    expect(loaded!.prompt).toBe('Do the thing.')
  })

  it('should delete a user agent', async () => {
    const agent: AgentDefinition = {
      metadata: {
        id: 'deleteme',
        name: 'Delete Me',
        description: 'To be deleted',
        subagent: false,
        allowedTools: [],
      },
      prompt: 'Temporary.',
    }

    await saveAgent(tempDir, agent)
    const result = await deleteAgent(tempDir, 'deleteme')
    expect(result.success).toBe(true)

    const agents = await loadAllAgents(tempDir)
    expect(agents.find((a) => a.metadata.id === 'deleteme')).toBeUndefined()
  })

  it('should not delete built-in default agents', async () => {
    const result = await deleteAgent(tempDir, 'verifier')
    expect(result.success).toBe(false)
    expect(result.reason).toBe('Cannot delete built-in defaults')
  })

  it('should return false when deleting non-existent agent', async () => {
    const result = await deleteAgent(tempDir, 'nonexistent')
    expect(result.success).toBe(false)
  })
})

async function createProjectAgentFile(projectDir: string, id: string, name: string): Promise<void> {
  const agentsDir = join(projectDir, '.openfox', 'agents')
  await mkdir(agentsDir, { recursive: true })
  await writeFile(
    join(agentsDir, `${id}.agent.md`),
    `---
id: ${id}
name: ${name}
description: Project agent ${id}
subagent: true
tools:
  - read_file
---

Project agent instructions for ${name}.
`,
  )
}

describe('loadProjectAgents', () => {
  it('should return empty array when project dir does not exist', async () => {
    const agents = await loadProjectAgents(tempDir)
    expect(agents).toEqual([])
  })

  it('should load valid .agent.md files from .openfox/agents/', async () => {
    await createProjectAgentFile(tempDir, 'proj-agent', 'Project Agent')

    const agents = await loadProjectAgents(tempDir)
    expect(agents).toHaveLength(1)
    expect(agents[0]!.metadata.id).toBe('proj-agent')
    expect(agents[0]!.metadata.name).toBe('Project Agent')
    expect(agents[0]!.prompt).toContain('Project agent instructions')
  })
})

describe('loadAllAgents with project', () => {
  it('should merge project agents on top of user and defaults', async () => {
    await createProjectAgentFile(tempDir, 'proj-agent', 'Project Agent')

    const defaults = await loadDefaultAgents()
    const agents = await loadAllAgents(tempDir, tempDir)
    expect(agents.some((a) => a.metadata.id === 'proj-agent')).toBe(true)
    expect(agents.length).toBeGreaterThanOrEqual(defaults.length + 1)
  })

  it('should give precedence to project agents over user and defaults', async () => {
    const agentsDir = join(tempDir, 'agents')
    await mkdir(agentsDir, { recursive: true })
    await writeFile(
      join(agentsDir, 'shared.agent.md'),
      `---
id: shared
name: User Agent
description: User
subagent: true
tools: []
---

User version.
`,
    )
    await createProjectAgentFile(tempDir, 'shared', 'Project Agent')

    const agents = await loadAllAgents(tempDir, tempDir)
    const shared = agents.find((a) => a.metadata.id === 'shared')
    expect(shared).toBeDefined()
    expect(shared!.metadata.name).toBe('Project Agent')
  })

  it('should give precedence to project agents over defaults with same id', async () => {
    await createProjectAgentFile(tempDir, 'verifier', 'Project Verifier')

    const agents = await loadAllAgents(tempDir, tempDir)
    const overridden = agents.find((a) => a.metadata.id === 'verifier')
    expect(overridden).toBeDefined()
    expect(overridden!.metadata.name).toBe('Project Verifier')
  })

  it('should work without project dir', async () => {
    const defaults = await loadDefaultAgents()
    const agents = await loadAllAgents(tempDir)
    expect(agents.length).toBeGreaterThanOrEqual(defaults.length)
  })
})

describe('CRUD project agents', () => {
  it('should save and load a project agent', async () => {
    const agent: AgentDefinition = {
      metadata: {
        id: 'proj_agent',
        name: 'Project Agent',
        description: 'P',
        subagent: true,
        allowedTools: ['read_file'],
      },
      prompt: 'Project agent instructions.',
    }

    await saveAgentToProject(tempDir, agent)

    const loaded = await loadProjectAgents(tempDir)
    expect(loaded).toHaveLength(1)
    expect(loaded[0]!.metadata.id).toBe('proj_agent')
    expect(loaded[0]!.prompt).toBe('Project agent instructions.')
  })

  it('should delete a project agent', async () => {
    const agent: AgentDefinition = {
      metadata: { id: 'proj_del', name: 'Delete Project', description: 'Temp', subagent: true, allowedTools: [] },
      prompt: 'Temporary.',
    }

    await saveAgentToProject(tempDir, agent)
    expect(await loadProjectAgents(tempDir)).toHaveLength(1)

    const result = await deleteProjectAgent(tempDir, 'proj_del')
    expect(result.success).toBe(true)
    expect(await loadProjectAgents(tempDir)).toHaveLength(0)
  })
})

describe('isDefaultAgent', () => {
  it('should correctly identify built-in default agents', async () => {
    const isPlannerDefault = await isDefaultAgent('planner')
    const isBuilderDefault = await isDefaultAgent('builder')
    const isVerifierDefault = await isDefaultAgent('verifier')
    const isNonExistentDefault = await isDefaultAgent('nonexistent')

    expect(isPlannerDefault).toBe(true)
    expect(isBuilderDefault).toBe(true)
    expect(isVerifierDefault).toBe(true)
    expect(isNonExistentDefault).toBe(false)
  })
})

describe('getDefaultAgentIds', () => {
  it('should return all default agent IDs', async () => {
    const ids = await getDefaultAgentIds()

    expect(ids).toContain('planner')
    expect(ids).toContain('builder')
    expect(ids).toContain('verifier')
    expect(ids).toContain('explorer')
    expect(ids).toContain('code-reviewer')
  })
})
