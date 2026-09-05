import { test, expect } from '@playwright/test'
import { execSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { gitSpawnEnv } from '../src/server/git/env.js'

let serverProcess: ChildProcess | null = null
const SERVER_PORT = 10869
const SERVER_URL = `http://localhost:${SERVER_PORT}`

async function waitForServer(url: string, maxAttempts = 40): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(`${url}/api/health`)
      if (res.ok) return
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('Server not ready')
}

async function getAuthToken(): Promise<string> {
  const res = await fetch(`${SERVER_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'password' }),
  })
  const data = (await res.json()) as { token: string }
  return data.token
}

async function api(path: string, options: RequestInit = {}): Promise<unknown> {
  const token = await getAuthToken()
  const res = await fetch(`${SERVER_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'x-session-token': token,
      ...(options.headers as Record<string, string>),
    },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`API ${options.method || 'GET'} ${path} failed: ${res.status} ${text}`)
  }
  return res.json()
}

test.describe('Git Status Watcher', () => {
  let workdir: string
  let projectId: string
  let sessionId: string

  test.beforeAll(async () => {
    serverProcess = spawn('npm', ['run', 'dev'], {
      cwd: join(import.meta.dirname, '..'),
      env: {
        ...process.env,
        OPENFOX_PORT: String(SERVER_PORT),
        OPENFOX_DB_PATH: ':memory:',
        OPENFOX_MOCK_LLM: 'true',
        OPENFOX_LOG_LEVEL: 'error',
        OPENFOX_GIT_POLL_INTERVAL: '1000',
      },
      stdio: 'ignore',
      detached: true,
    })
    serverProcess.unref()
    await waitForServer(SERVER_URL)

    workdir = join(tmpdir(), `openfox-git-test-${Date.now()}`)
    await mkdir(workdir, { recursive: true })
    await mkdir(join(workdir, 'src'), { recursive: true })
    await writeFile(join(workdir, 'src', 'index.ts'), '// Initial content\n')
    await writeFile(join(workdir, 'README.md'), '# Test\n')

    execSync('git init', { cwd: workdir, stdio: 'ignore', env: gitSpawnEnv() })
    execSync('git config user.email "test@test.com"', { cwd: workdir, stdio: 'ignore', env: gitSpawnEnv() })
    execSync('git config user.name "Test"', { cwd: workdir, stdio: 'ignore', env: gitSpawnEnv() })
    execSync('git add -A', { cwd: workdir, stdio: 'ignore', env: gitSpawnEnv() })
    execSync('git commit -m "initial"', { cwd: workdir, stdio: 'ignore', env: gitSpawnEnv() })

    const projectData = (await api('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name: 'git-test', workdir }),
    })) as { project: { id: string } }
    projectId = projectData.project.id

    const sessionData = (await api('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ projectId }),
    })) as { session: { id: string } }
    sessionId = sessionData.session.id
  })

  test.afterAll(async () => {
    await rm(workdir, { recursive: true, force: true })
    if (serverProcess?.pid) {
      try {
        process.kill(-serverProcess.pid, 'SIGKILL')
      } catch {
        serverProcess.kill('SIGKILL')
      }
    }
  })

  test('sidebar updates when file is modified on disk', async ({ page }) => {
    await page.goto(`${SERVER_URL}/p/${projectId}/s/${sessionId}`)
    await page.waitForLoadState('networkidle')

    const passwordInput = page.locator('input[placeholder="Enter password"]')
    try {
      const hasPassword = await passwordInput.isVisible({ timeout: 2000 })
      if (hasPassword) {
        await passwordInput.fill('password')
        await page.getByRole('button', { name: 'Connect' }).click()
        await page.waitForLoadState('networkidle')
        await page.waitForTimeout(1000)
      }
    } catch {
      // No password modal
    }

    await expect(page.getByText('No changes').first()).toBeVisible({ timeout: 5000 })

    // Wait for first poll to complete and store the hash
    await page.waitForTimeout(1_500)

    await writeFile(join(workdir, 'src', 'index.ts'), '// Modified content\n')

    // Wait for next poll cycle to detect the change
    await page.waitForTimeout(1_500)

    const sidebarContent = page.getByText('src/index.ts').first()
    await expect(sidebarContent).toBeVisible({ timeout: 3000 })
  })
})
