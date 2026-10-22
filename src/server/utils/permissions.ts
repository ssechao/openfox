import { resolve } from 'node:path'
import { access, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { PERMISSIONS_COMMAND_TIMEOUT_MS, runFile } from './bounded-exec.js'

export type PermissionsOptions = { signal?: AbortSignal }

function sanitizeShellArg(arg: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(arg)) {
    throw new Error(`Invalid argument: ${arg}`)
  }
  return arg
}

async function runPerm(
  file: string,
  args: string[],
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  return runFile(file, args, {
    timeoutMs: PERMISSIONS_COMMAND_TIMEOUT_MS,
    ...(signal ? { signal } : {}),
  })
}

async function addUserToGroup(groupName: string, signal?: AbortSignal): Promise<void> {
  const currentUser = (await runPerm('id', ['-un'], signal)).stdout.trim()
  await runPerm('sudo', ['usermod', '-aG', sanitizeShellArg(groupName), sanitizeShellArg(currentUser)], signal)
}

interface DirInfo {
  resolvedPath: string
  groupGid: number
  groupName: string | null
  userGroups: string[]
  userInGroup: boolean
  groupHasWrite: boolean
  sudoAvailable: boolean
}

async function getDirInfo(targetPath: string, signal?: AbortSignal): Promise<DirInfo> {
  const resolvedPath = resolve(targetPath)

  try {
    await access(resolvedPath, constants.F_OK)
  } catch {
    throw new Error('Path not found')
  }

  let sudoAvailable: boolean
  try {
    await runPerm('sudo', ['-n', 'true'], signal)
    sudoAvailable = true
  } catch {
    sudoAvailable = false
  }

  const dirStat = await stat(resolvedPath)
  const groupGid = dirStat.gid

  const currentUser = sanitizeShellArg((await runPerm('id', ['-un'], signal)).stdout.trim())
  const groupsOutput = (await runPerm('id', ['-Gn', currentUser], signal)).stdout.trim()
  const userGroups = groupsOutput.split(/\s+/)

  let groupName: string | null = null
  try {
    const rawGroupName = (await runPerm('getent', ['group', String(groupGid)], signal)).stdout.split(':')[0]?.trim()
    groupName = rawGroupName ? sanitizeShellArg(rawGroupName) : null
  } catch {
    // ignore
  }

  const userInGroup = groupName ? userGroups.includes(groupName) : false
  const groupHasWrite = (dirStat.mode & 0o020) !== 0

  return { resolvedPath, groupGid, groupName, userGroups, userInGroup, groupHasWrite, sudoAvailable }
}

export async function checkPermissions(targetPath: string, options?: PermissionsOptions) {
  if (process.platform === 'win32') {
    return { success: false, error: 'Automatic permission management is not supported on Windows', status: 501 }
  }
  try {
    const info = await getDirInfo(targetPath, options?.signal)
    return {
      success: true,
      sudoAvailable: info.sudoAvailable,
      userInGroup: info.userInGroup,
      groupHasWrite: info.groupHasWrite,
      groupName: info.groupName,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    if (message === 'Path not found') {
      return { success: false, error: message, status: 404 }
    }
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error', status: 500 }
  }
}

export async function fixPermissions(targetPath: string, action: string, options?: PermissionsOptions) {
  if (process.platform === 'win32') {
    return {
      success: false,
      sudoAvailable: false,
      error: 'Automatic permission fixes are not supported on Windows',
      status: 501,
    }
  }
  try {
    const info = await getDirInfo(targetPath, options?.signal)
    const signal = options?.signal

    if (action === 'group') {
      if (!info.userInGroup) {
        return {
          success: false,
          sudoAvailable: info.sudoAvailable,
          error:
            'You are not in the group that owns this directory. Use "Join group & extend group permissions" instead.',
        }
      }
      await runPerm('sudo', ['chmod', 'g+w', info.resolvedPath], signal)
      return { success: true, sudoAvailable: info.sudoAvailable, method: 'group' }
    }

    if (action === 'join_group') {
      if (!info.groupName) {
        return { success: false, sudoAvailable: info.sudoAvailable, error: 'Could not determine group name' }
      }
      await addUserToGroup(info.groupName, signal)
      return { success: true, sudoAvailable: info.sudoAvailable, method: 'join_group' }
    }

    if (action === 'join_group_and_group') {
      if (!info.groupName) {
        return { success: false, sudoAvailable: info.sudoAvailable, error: 'Could not determine group name' }
      }
      await runPerm('sudo', ['chmod', 'g+w', info.resolvedPath], signal)
      await addUserToGroup(info.groupName, signal)
      return { success: true, sudoAvailable: info.sudoAvailable, method: 'join_group_and_group' }
    }

    const ownerUser = (await runPerm('id', ['-un'], signal)).stdout.trim()
    await runPerm('sudo', ['chown', '-R', sanitizeShellArg(ownerUser), info.resolvedPath], signal)
    return { success: true, sudoAvailable: info.sudoAvailable, method: 'ownership' }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    if (message === 'Path not found') {
      return { success: false, sudoAvailable: true, error: message, status: 404 }
    }
    return { success: false, sudoAvailable: true, error: message }
  }
}
