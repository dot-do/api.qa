/**
 * Monitor registry + run-history store — the state that turns api.qa from a
 * one-shot grader into a MONITOR (bd ax-e6b.29.1).
 *
 * A MONITOR is a durable registration: "re-verify THIS registered target on
 * THIS interval, fully AFK." The scheduled() Worker handler (see worker.ts)
 * walks this registry every tick, finds monitors whose `nextDueAt` has passed,
 * and re-runs the SAME attested verify path a fetch-triggered run would — no
 * human trigger. Each run appends a minimal-but-real record to a per-monitor
 * run-history list; the time-series work (ax-e6b.29.2) consumes that list.
 *
 * Purity boundary: this module NEVER judges and NEVER probes. It is pure
 * storage over the injectable `KVLike` (the same REPORTS binding the report
 * cache uses, different key prefixes). The SSRF gate that refuses a
 * private/metadata target at registration lives in the Worker (it reuses
 * `normalizeTarget`), so this store only ever holds already-normalized origins.
 */

import type { KVLike } from './cache.js'
import { hostKey } from './cache.js'

/** A registered monitor: re-verify `target` (+ optional stored suite) on `intervalSec`. */
export interface MonitorRecord {
  id: string
  /** A normalized origin (already through the SSRF gate at registration). */
  target: string
  /** When present, also run this STORED suite (by digest) each tick. */
  suiteDigest?: string
  /** The suite environment to select (defaulted to the suite's first env at registration). */
  environment?: string
  intervalSec: number
  createdAt: number
  /** ms epoch of the last completed run, or null if never run. */
  lastRunAt: number | null
  /** ms epoch at/after which the next run is due. */
  nextDueAt: number
}

/** One scheduled run's minimal, replay-consumable record. */
export interface MonitorRunRecord {
  monitorId: string
  at: number
  grade: string
  /** Present only when the monitor carries a suiteDigest. */
  suiteVerdict?: boolean
  /** The grade run's evidence digest — the attestation anchor for this run. */
  digest: string
}

/**
 * Parse a registration `interval` into whole seconds. Accepts either a number
 * of seconds, a numeric string, or an every-N-minutes cron expression of the
 * form "(star)/N * * * *" (the shape the wrangler cron trigger uses) → N*60s.
 */
export function parseIntervalSec(interval: unknown): number {
  if (typeof interval === 'number') {
    if (!Number.isFinite(interval) || interval <= 0) {
      throw new Error(`invalid interval: ${interval} — must be a positive number of seconds`)
    }
    return Math.floor(interval)
  }
  if (typeof interval === 'string') {
    const s = interval.trim()
    const cron = /^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/.exec(s)
    if (cron) {
      const mins = Number(cron[1])
      if (mins <= 0) throw new Error(`invalid cron interval "${interval}"`)
      return mins * 60
    }
    if (/^\d+$/.test(s)) {
      const secs = Number(s)
      if (secs <= 0) throw new Error(`invalid interval "${interval}" — must be > 0 seconds`)
      return secs
    }
  }
  throw new Error(
    `unsupported interval ${JSON.stringify(interval)} — use seconds (e.g. 300) or a "*/N * * * *" cron`,
  )
}

/** Default cap on monitors run in a single scheduled tick (rest carry over). */
export const DEFAULT_MAX_PER_TICK = 20
/** Bound the per-monitor run-history so a KV value cannot grow without limit. */
export const RUN_HISTORY_CAP = 500

const INDEX_KEY = 'monitors:index'

/**
 * Content-addressed monitor id: stable for the same (target, suite, env) tuple
 * so re-registering the same monitor is idempotent rather than duplicating.
 */
export function monitorId(target: string, suiteDigest?: string, environment?: string): string {
  const parts = [hostKey(target), suiteDigest ?? '-', environment ?? '-']
  // A short, filesystem/URL-safe id derived from the tuple. Not a secret.
  let h = 2166136261 >>> 0
  const s = parts.join('|')
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return `mon_${h.toString(36)}`
}

/** Pure storage over KVLike. No judging, no probing, no SSRF policy. */
export class MonitorStore {
  constructor(private readonly kv: KVLike) {}

  private monK(id: string): string {
    return `monitor:${id}`
  }
  private runsK(id: string): string {
    return `runs:${id}`
  }

  private async index(): Promise<string[]> {
    const raw = await this.kv.get(INDEX_KEY)
    if (!raw) return []
    try {
      const ids = JSON.parse(raw) as unknown
      return Array.isArray(ids) ? (ids as string[]) : []
    } catch {
      return []
    }
  }

  private async writeIndex(ids: string[]): Promise<void> {
    await this.kv.put(INDEX_KEY, JSON.stringify(ids))
  }

  /** Register (or idempotently replace) a monitor. Returns the stored record. */
  async register(rec: MonitorRecord): Promise<MonitorRecord> {
    await this.kv.put(this.monK(rec.id), JSON.stringify(rec))
    const ids = await this.index()
    if (!ids.includes(rec.id)) {
      ids.push(rec.id)
      await this.writeIndex(ids)
    }
    return rec
  }

  async get(id: string): Promise<MonitorRecord | null> {
    const ids = await this.index()
    if (!ids.includes(id)) return null
    const raw = await this.kv.get(this.monK(id))
    return raw ? (JSON.parse(raw) as MonitorRecord) : null
  }

  async list(): Promise<MonitorRecord[]> {
    const ids = await this.index()
    const out: MonitorRecord[] = []
    for (const id of ids) {
      const raw = await this.kv.get(this.monK(id))
      if (raw) out.push(JSON.parse(raw) as MonitorRecord)
    }
    return out
  }

  /** Remove a monitor from the registry. Returns true if it was present. */
  async delete(id: string): Promise<boolean> {
    const ids = await this.index()
    if (!ids.includes(id)) return false
    await this.writeIndex(ids.filter((x) => x !== id))
    return true
  }

  /** Persist an updated record (e.g. after a run advances lastRunAt/nextDueAt). */
  async update(rec: MonitorRecord): Promise<void> {
    await this.kv.put(this.monK(rec.id), JSON.stringify(rec))
  }

  /** Append a run record to the monitor's history (bounded to the last N). */
  async appendRun(run: MonitorRunRecord): Promise<void> {
    const history = await this.listRuns(run.monitorId)
    history.push(run)
    const bounded = history.slice(-RUN_HISTORY_CAP)
    await this.kv.put(this.runsK(run.monitorId), JSON.stringify(bounded))
  }

  /** The monitor's run history, oldest→newest. Empty if none. */
  async listRuns(monitorId: string): Promise<MonitorRunRecord[]> {
    const raw = await this.kv.get(this.runsK(monitorId))
    if (!raw) return []
    try {
      const runs = JSON.parse(raw) as unknown
      return Array.isArray(runs) ? (runs as MonitorRunRecord[]) : []
    } catch {
      return []
    }
  }
}
