/**
 * Persisted settings: one credential record holds the global profile and region and each server's switches and
 * form values; secret values are separate credential references (`DSH_AWS_<SERVER>_<FIELD>`) the MCP manager
 * resolves at spawn time, so they never sit in the record or reach the page.
 */
import { EMPTY_SERVER, type GlobalSettings, type ServerSettings } from './launch.ts'
import type { Credentials } from './dsh.ts'

/** The record key. */
export const SETTINGS_RECORD = 'dsh-aws/settings'

/** Everything the record holds. */
export interface StoredSettings extends GlobalSettings {
  readonly servers: Readonly<Record<string, ServerSettings>>
}

const str = (value: unknown): string => typeof value === 'string' ? value : ''

function parseServer(value: unknown): ServerSettings {
  if (typeof value !== 'object' || value === null) return EMPTY_SERVER
  const raw = value as Record<string, unknown>
  const values = typeof raw.values === 'object' && raw.values !== null
    ? Object.fromEntries(Object.entries(raw.values).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    : {}
  return {
    enabled: raw.enabled === true,
    values,
    allowWrite: raw.allowWrite === true,
    allowSensitive: raw.allowSensitive === true,
    profile: str(raw.profile),
    region: str(raw.region),
    extraEnv: str(raw.extraEnv),
  }
}

/**
 * Read the settings; a missing or malformed record reads as empty.
 * @param credentials Credential store.
 * @returns The settings.
 */
export async function readSettings(credentials: Credentials): Promise<StoredSettings> {
  const record = await credentials.readRecord(SETTINGS_RECORD)
  const payload = record?.kind === 'grant' && typeof record.payload === 'object' && record.payload !== null
    ? record.payload as Record<string, unknown>
    : {}
  const servers = typeof payload.servers === 'object' && payload.servers !== null
    ? Object.fromEntries(Object.entries(payload.servers).map(([id, value]) => [id, parseServer(value)]))
    : {}
  return { profile: str(payload.profile), region: str(payload.region), servers }
}

/**
 * Write the settings.
 * @param credentials Credential store.
 * @param settings The full settings.
 */
export async function writeSettings(credentials: Credentials, settings: StoredSettings): Promise<void> {
  await credentials.modifyRecord(SETTINGS_RECORD, () => Promise.resolve({ kind: 'grant', payload: { version: 1, ...settings } }))
}
