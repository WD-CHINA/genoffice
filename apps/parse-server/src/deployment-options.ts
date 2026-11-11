/**
 * Deployment-time switches read from the environment by `bin.ts`.
 *
 * Parsing is strict on purpose: a malformed value aborts startup instead of
 * silently selecting a default, and a half-configured restore drill (a toggle
 * without a manifest path) is rejected rather than dropped. The manifest JSON
 * only has its top-level kind checked here; `verifyRestore` owns the full shape
 * and digest validation before any catalog mutation.
 */
import { readFile as readFileText } from 'node:fs/promises'
import type { BackupManifest } from './backup-manifest'
import type { ParseServerOptions } from './server'

export interface RestoreCheckOptions {
  /** Parsed manifest, kept as written on disk; validated later by verifyRestore. */
  manifest: BackupManifest
  /** Also decompress and verify every data frame; defaults to false. */
  deep?: boolean
  /** Withdraw proven-bad ready pointers; false is a read-only drill. */
  invalidate?: boolean
}

type ArtifactBackend = NonNullable<ParseServerOptions['artifactBackend']>
type StorageAdmission = NonNullable<ParseServerOptions['storageAdmission']>
type DeploymentOptions = Pick<
  ParseServerOptions,
  'artifactBackend' | 'storageAdmission' | 'restoreCheck' | 'asyncSessionsV2'
>

const ARTIFACT_BACKENDS: readonly ArtifactBackend[] = ['local', 'catalog']
const STORAGE_ADMISSIONS: readonly StorageAdmission[] = ['instance', 'shared']
const TRUE_WORDS = new Set(['1', 'true', 'yes', 'on'])
const FALSE_WORDS = new Set(['0', 'false', 'no', 'off'])

const RESTORE_MANIFEST = 'PARSE_SERVER_RESTORE_MANIFEST'
const RESTORE_DEEP = 'PARSE_SERVER_RESTORE_DEEP'
const RESTORE_READ_ONLY = 'PARSE_SERVER_RESTORE_READ_ONLY'
const RESTORE_INVALIDATE = 'PARSE_SERVER_RESTORE_INVALIDATE'

/** Trimmed value; empty and whitespace-only strings count as unset. */
function readEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name]
  if (raw === undefined) return undefined
  const value = raw.trim()
  return value === '' ? undefined : value
}

function enumSetting<T extends string>(
  env: NodeJS.ProcessEnv,
  name: string,
  allowed: readonly T[],
  label: string,
): T | undefined {
  const raw = readEnv(env, name)
  if (raw === undefined) return undefined
  const value = raw.toLowerCase()
  if (!(allowed as readonly string[]).includes(value))
    throw new Error(`invalid ${label}: ${raw}`)
  return value as T
}

/** Accepts 1/0/true/false/yes/no/on/off in any case; anything else is fatal. */
function booleanSetting(env: NodeJS.ProcessEnv, name: string): boolean | undefined {
  const raw = readEnv(env, name)
  if (raw === undefined) return undefined
  const value = raw.toLowerCase()
  if (TRUE_WORDS.has(value)) return true
  if (FALSE_WORDS.has(value)) return false
  throw new Error(`${name} must be one of 1/0/true/false/yes/no/on/off`)
}

/** `PARSE_SERVER_ARTIFACT_BACKEND`; unset/empty leaves the local default in place. */
export function artifactBackendFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): 'local' | 'catalog' | undefined {
  return enumSetting(env, 'PARSE_SERVER_ARTIFACT_BACKEND', ARTIFACT_BACKENDS, 'artifact backend')
}

/** `PARSE_SERVER_STORAGE_ADMISSION`; unset/empty keeps the backend-derived default. */
export function storageAdmissionFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): 'instance' | 'shared' | undefined {
  return enumSetting(
    env,
    'PARSE_SERVER_STORAGE_ADMISSION',
    STORAGE_ADMISSIONS,
    'storage admission mode',
  )
}

async function defaultReadFile(path: string): Promise<string> {
  return readFileText(path, 'utf8')
}

function parseManifestText(path: string, text: string): BackupManifest {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (cause) {
    throw new Error(`invalid restore manifest: ${path}`, { cause })
  }
  // A JSON array or scalar is never a manifest; field-level shape is verifyRestore's job.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error(`invalid restore manifest: ${path}`)
  return parsed as BackupManifest
}

/**
 * Reads the recovery-drill switches. Returns undefined only when the drill is
 * completely unconfigured; any toggle without a manifest path is an error so a
 * typo cannot quietly disable a restore gate.
 */
/**
 * `PARSE_SERVER_ASYNC_SESSIONS_V2`: staged-rollback switch for the v2 async
 * session contract (plan §10). When disabled the v2 session routes answer 404
 * and clients fall back to v1 exactly as they do for older servers.
 */
export function asyncSessionsV2FromEnv(env: NodeJS.ProcessEnv = process.env): boolean | undefined {
  return booleanSetting(env, 'PARSE_SERVER_ASYNC_SESSIONS_V2')
}

export async function restoreCheckFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  readFile: (path: string) => Promise<string> = defaultReadFile,
): Promise<RestoreCheckOptions | undefined> {
  const path = readEnv(env, RESTORE_MANIFEST)
  if (path === undefined) {
    const configured =
      readEnv(env, RESTORE_DEEP) !== undefined ||
      readEnv(env, RESTORE_READ_ONLY) !== undefined ||
      readEnv(env, RESTORE_INVALIDATE) !== undefined
    if (configured) throw new Error('restore manifest path is required')
    return undefined
  }
  const deep = booleanSetting(env, RESTORE_DEEP) ?? false
  const readOnly = booleanSetting(env, RESTORE_READ_ONLY)
  const invalidateSetting = booleanSetting(env, RESTORE_INVALIDATE)
  // Conflicting switches resolve to the safe side: read-only never mutates,
  // even if invalidation was also requested.
  const invalidate = readOnly === true ? false : (invalidateSetting ?? true)
  let text: string
  try {
    text = await readFile(path)
  } catch (cause) {
    throw new Error(`invalid restore manifest: ${path}`, { cause })
  }
  return { manifest: parseManifestText(path, text), deep, invalidate }
}

/** Convenience bundle for `bin.ts`: only keys whose env variable is set appear. */
export async function deploymentOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<DeploymentOptions> {
  const options: DeploymentOptions = {}
  const artifactBackend = artifactBackendFromEnv(env)
  if (artifactBackend !== undefined) options.artifactBackend = artifactBackend
  const storageAdmission = storageAdmissionFromEnv(env)
  if (storageAdmission !== undefined) options.storageAdmission = storageAdmission
  const asyncSessionsV2 = asyncSessionsV2FromEnv(env)
  if (asyncSessionsV2 !== undefined) options.asyncSessionsV2 = asyncSessionsV2
  const restoreCheck = await restoreCheckFromEnv(env)
  if (restoreCheck !== undefined) options.restoreCheck = restoreCheck
  return options
}
