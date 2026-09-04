import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export function nextForkVersion(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-fork(?:\.(\d+))?)?$/.exec(version)
  if (!match) throw new Error(`Unsupported version for fork build: ${version}`)
  const [, major, minor, patch, build] = match
  const nextBuild = build === undefined ? 0 : Number(build) + 1
  return `${major}.${minor}.${patch}-fork.${nextBuild}`
}

export async function incrementForkVersion(root: string = process.cwd()): Promise<string> {
  const packagePath = join(root, 'package.json')
  const lockPath = join(root, 'package-lock.json')
  const pkg = JSON.parse(await readFile(packagePath, 'utf8')) as Record<string, unknown>
  const lock = JSON.parse(await readFile(lockPath, 'utf8')) as Record<string, unknown>
  const current = pkg['version']
  if (typeof current !== 'string') throw new Error('package.json has no version')
  const version = nextForkVersion(current)

  pkg['version'] = version
  lock['version'] = version
  const packages = lock['packages']
  if (typeof packages !== 'object' || packages === null) throw new Error('package-lock.json has no packages')
  const rootPackage = (packages as Record<string, unknown>)['']
  if (typeof rootPackage !== 'object' || rootPackage === null) {
    throw new Error('package-lock.json has no root package')
  }
  ;(rootPackage as Record<string, unknown>)['version'] = version

  await Promise.all([
    writeFile(packagePath, `${JSON.stringify(pkg, null, 2)}\n`),
    writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`),
  ])
  return version
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  incrementForkVersion()
    .then((version) => process.stdout.write(`${version}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    })
}
