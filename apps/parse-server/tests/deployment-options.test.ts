import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  artifactBackendFromEnv,
  asyncSessionsFromEnv,
  deploymentOptionsFromEnv,
  restoreCheckFromEnv,
  storageAdmissionFromEnv,
} from '../src/deployment-options'

const dirs: string[] = []

async function writeManifest(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'parse-deployment-options-'))
  dirs.push(dir)
  const path = join(dir, 'manifest.json')
  await writeFile(path, content)
  return path
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('artifactBackendFromEnv', () => {
  it('returns undefined for unset or blank values and normalizes known backends', () => {
    expect(artifactBackendFromEnv({})).toBeUndefined()
    expect(artifactBackendFromEnv({ PARSE_SERVER_ARTIFACT_BACKEND: '' })).toBeUndefined()
    expect(artifactBackendFromEnv({ PARSE_SERVER_ARTIFACT_BACKEND: '   ' })).toBeUndefined()
    expect(artifactBackendFromEnv({ PARSE_SERVER_ARTIFACT_BACKEND: 'local' })).toBe('local')
    expect(artifactBackendFromEnv({ PARSE_SERVER_ARTIFACT_BACKEND: ' CATALOG ' })).toBe('catalog')
  })

  it('rejects unknown backends instead of falling back', () => {
    for (const raw of ['s3', 'catalogue', 'local,catalog', 'catalog;local']) {
      expect(() => artifactBackendFromEnv({ PARSE_SERVER_ARTIFACT_BACKEND: raw })).toThrow(
        'invalid artifact backend',
      )
    }
  })
})

describe('storageAdmissionFromEnv', () => {
  it('returns undefined for unset or blank values and normalizes known modes', () => {
    expect(storageAdmissionFromEnv({})).toBeUndefined()
    expect(storageAdmissionFromEnv({ PARSE_SERVER_STORAGE_ADMISSION: '' })).toBeUndefined()
    expect(storageAdmissionFromEnv({ PARSE_SERVER_STORAGE_ADMISSION: '  ' })).toBeUndefined()
    expect(storageAdmissionFromEnv({ PARSE_SERVER_STORAGE_ADMISSION: 'instance' })).toBe('instance')
    expect(storageAdmissionFromEnv({ PARSE_SERVER_STORAGE_ADMISSION: ' Shared ' })).toBe('shared')
  })

  it('rejects unknown modes', () => {
    for (const raw of ['global', 'instances', 'shared,instance']) {
      expect(() => storageAdmissionFromEnv({ PARSE_SERVER_STORAGE_ADMISSION: raw })).toThrow(
        'invalid storage admission',
      )
    }
  })
})

describe('restoreCheckFromEnv', () => {
  it('returns undefined when the drill is unconfigured', async () => {
    await expect(restoreCheckFromEnv({})).resolves.toBeUndefined()
    await expect(
      restoreCheckFromEnv({ PARSE_SERVER_RESTORE_MANIFEST: '   ' }),
    ).resolves.toBeUndefined()
  })

  it('requires a manifest path as soon as any restore switch is set', async () => {
    for (const name of [
      'PARSE_SERVER_RESTORE_DEEP',
      'PARSE_SERVER_RESTORE_READ_ONLY',
      'PARSE_SERVER_RESTORE_INVALIDATE',
    ]) {
      await expect(restoreCheckFromEnv({ [name]: '1' })).rejects.toThrow(
        'restore manifest path is required',
      )
    }
  })

  it('reads the manifest from disk and applies deep/invalidate defaults', async () => {
    const path = await writeManifest('{"schemaVersion":1,"entries":[]}')
    const options = await restoreCheckFromEnv({ PARSE_SERVER_RESTORE_MANIFEST: path })
    expect(options).toEqual({
      manifest: { schemaVersion: 1, entries: [] },
      deep: false,
      invalidate: true,
    })
  })

  it('honors an injected reader and keeps the manifest bytes untouched', async () => {
    const calls: string[] = []
    const options = await restoreCheckFromEnv(
      { PARSE_SERVER_RESTORE_MANIFEST: '/manifests/backup.json', PARSE_SERVER_RESTORE_DEEP: 'on' },
      async (path) => {
        calls.push(path)
        return '{"schemaVersion":1,"digest":"sha256:abc"}'
      },
    )
    expect(calls).toEqual(['/manifests/backup.json'])
    expect(options).toEqual({
      manifest: { schemaVersion: 1, digest: 'sha256:abc' },
      deep: true,
      invalidate: true,
    })
  })

  it('rejects unreadable, corrupted and non-object manifests with the path', async () => {
    const corrupted = await writeManifest('{"schemaVersion":1,')
    await expect(restoreCheckFromEnv({ PARSE_SERVER_RESTORE_MANIFEST: corrupted })).rejects.toThrow(
      new Error(`invalid restore manifest: ${corrupted}`),
    )
    const missing = join(tmpdir(), 'parse-restore-manifest-that-does-not-exist.json')
    await expect(restoreCheckFromEnv({ PARSE_SERVER_RESTORE_MANIFEST: missing })).rejects.toThrow(
      `invalid restore manifest: ${missing}`,
    )
    for (const content of ['[]', 'null', '42', '"manifest"', 'true']) {
      const path = await writeManifest(content)
      await expect(restoreCheckFromEnv({ PARSE_SERVER_RESTORE_MANIFEST: path })).rejects.toThrow(
        `invalid restore manifest: ${path}`,
      )
    }
  })

  it('parses deep/invalidate/read-only booleans with read-only precedence', async () => {
    const path = '/manifests/backup.json'
    const read = async (): Promise<string> => '{"schemaVersion":1}'
    const resolve = async (env: NodeJS.ProcessEnv) => {
      const options = await restoreCheckFromEnv(
        { PARSE_SERVER_RESTORE_MANIFEST: path, ...env },
        read,
      )
      return { deep: options?.deep, invalidate: options?.invalidate }
    }
    expect(await resolve({})).toEqual({ deep: false, invalidate: true })
    expect(await resolve({ PARSE_SERVER_RESTORE_DEEP: 'TRUE' })).toEqual({
      deep: true,
      invalidate: true,
    })
    expect(await resolve({ PARSE_SERVER_RESTORE_DEEP: 'off' })).toEqual({
      deep: false,
      invalidate: true,
    })
    expect(await resolve({ PARSE_SERVER_RESTORE_INVALIDATE: '0' })).toEqual({
      deep: false,
      invalidate: false,
    })
    expect(await resolve({ PARSE_SERVER_RESTORE_READ_ONLY: '1' })).toEqual({
      deep: false,
      invalidate: false,
    })
    // Read-only wins even when invalidation was explicitly requested.
    expect(
      await resolve({
        PARSE_SERVER_RESTORE_READ_ONLY: 'yes',
        PARSE_SERVER_RESTORE_INVALIDATE: '1',
      }),
    ).toEqual({ deep: false, invalidate: false })
    expect(
      await resolve({ PARSE_SERVER_RESTORE_READ_ONLY: '0', PARSE_SERVER_RESTORE_INVALIDATE: 'ON' }),
    ).toEqual({ deep: false, invalidate: true })
  })

  it('rejects unrecognized boolean spellings', async () => {
    const read = async (): Promise<string> => '{"schemaVersion":1}'
    for (const name of [
      'PARSE_SERVER_RESTORE_DEEP',
      'PARSE_SERVER_RESTORE_READ_ONLY',
      'PARSE_SERVER_RESTORE_INVALIDATE',
    ]) {
      await expect(
        restoreCheckFromEnv(
          { PARSE_SERVER_RESTORE_MANIFEST: '/manifests/backup.json', [name]: 'maybe' },
          read,
        ),
      ).rejects.toThrow('must be one of 1/0/true/false/yes/no/on/off')
    }
  })
})

describe('deploymentOptionsFromEnv', () => {
  it('only returns the keys whose environment variables are set', async () => {
    expect(await deploymentOptionsFromEnv({})).toEqual({})
    expect(await deploymentOptionsFromEnv({ PARSE_SERVER_ARTIFACT_BACKEND: 'catalog' })).toEqual({
      artifactBackend: 'catalog',
    })
    expect(await deploymentOptionsFromEnv({ PARSE_SERVER_STORAGE_ADMISSION: 'shared' })).toEqual({
      storageAdmission: 'shared',
    })

    const path = await writeManifest('{"schemaVersion":1}')
    const bundle = await deploymentOptionsFromEnv({
      PARSE_SERVER_ARTIFACT_BACKEND: 'local',
      PARSE_SERVER_STORAGE_ADMISSION: 'instance',
      PARSE_SERVER_RESTORE_MANIFEST: path,
    })
    expect(Object.keys(bundle).sort()).toEqual([
      'artifactBackend',
      'restoreCheck',
      'storageAdmission',
    ])
    expect(bundle.restoreCheck).toEqual({
      manifest: { schemaVersion: 1 },
      deep: false,
      invalidate: true,
    })
  })

  it('propagates a half-configured restore drill', async () => {
    await expect(deploymentOptionsFromEnv({ PARSE_SERVER_RESTORE_DEEP: '1' })).rejects.toThrow(
      'restore manifest path is required',
    )
  })
})

it('parses the staged async-session rollback switch', async () => {
  expect(asyncSessionsFromEnv({})).toBeUndefined()
  expect(asyncSessionsFromEnv({ PARSE_SERVER_ASYNC_SESSIONS: '1' })).toBe(true)
  expect(asyncSessionsFromEnv({ PARSE_SERVER_ASYNC_SESSIONS: 'off' })).toBe(false)
  expect(() => asyncSessionsFromEnv({ PARSE_SERVER_ASYNC_SESSIONS: 'maybe' })).toThrow(
    /PARSE_SERVER_ASYNC_SESSIONS/,
  )
  const options = await deploymentOptionsFromEnv({ PARSE_SERVER_ASYNC_SESSIONS: 'false' })
  expect(options.asyncSessions).toBe(false)
})

it('normalizes legacy deployment aliases and rejects conflicts without enabling async jobs', async () => {
  expect(asyncSessionsFromEnv({ PARSE_SERVER_ASYNC_SESSIONS_V2: 'off' })).toBe(false)
  expect(() =>
    asyncSessionsFromEnv({
      PARSE_SERVER_ASYNC_SESSIONS: 'on',
      PARSE_SERVER_ASYNC_SESSIONS_V2: 'off',
    }),
  ).toThrow(/conflicting/)
  expect(
    await deploymentOptionsFromEnv({
      PARSE_SERVER_V2_ROLLOUT_PERCENT: '0',
      PARSE_SERVER_V2_ROLLOUT_HEADER: 'x-tenant-id',
    }),
  ).toMatchObject({ asyncRolloutPercent: 0, asyncRolloutHeader: 'x-tenant-id' })
  await expect(
    deploymentOptionsFromEnv({
      PARSE_SERVER_ASYNC_ROLLOUT_PERCENT: '50',
      PARSE_SERVER_V2_ROLLOUT_PERCENT: '0',
    }),
  ).rejects.toThrow(/conflicting/)
  await expect(
    deploymentOptionsFromEnv({ PARSE_SERVER_ASYNC_ROLLOUT_PERCENT: '101' }),
  ).rejects.toThrow(/0 and 100/)
})
