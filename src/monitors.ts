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
  /**
   * ms epoch after which an idle monitor is treated as abandoned: excluded
   * from listing/ticking and evictable (bd ax-e6b.29.1 LOW-abuse-surface
   * bound — see DEFAULT_MONITOR_TTL_DAYS). Refreshed on every registration
   * and every completed run, so an actively-monitored target never expires.
   */
  expiresAt: number
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
 * Minimum registrable interval, in whole seconds. Without a floor, a
 * sub-integer interval (e.g. 0.5) would previously pass the `> 0` check and
 * then floor to 0 via `Math.floor`, making `nextDueAt` equal to `now` on
 * every tick forever — DUE every tick, unbounded (worst on the no-cooldown
 * self monitor). The production cron cadence is "*\/5 * * * *" (300s — see
 * wrangler.jsonc `triggers.crons`), so nothing can usefully run faster than
 * that today; 60s is chosen as a conservative floor well under that cadence
 * (headroom for tests / a future faster cron) that still rejects anything
 * that would floor to (near) zero.
 */
export const MIN_INTERVAL_SEC = 60

/**
 * Parse a registration `interval` into whole seconds. Accepts either a number
 * of seconds, a numeric string, or an every-N-minutes cron expression of the
 * form "(star)/N * * * *" (the shape the wrangler cron trigger uses) → N*60s.
 * Rejects anything non-integer, non-finite, or below MIN_INTERVAL_SEC.
 */
export function parseIntervalSec(interval: unknown): number {
  if (typeof interval === 'number') {
    if (!Number.isFinite(interval) || !Number.isInteger(interval) || interval < MIN_INTERVAL_SEC) {
      throw new Error(
        `invalid interval: ${interval} — must be a whole number of seconds >= ${MIN_INTERVAL_SEC}`,
      )
    }
    return interval
  }
  if (typeof interval === 'string') {
    const s = interval.trim()
    const cron = /^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/.exec(s)
    if (cron) {
      const mins = Number(cron[1])
      if (mins <= 0) throw new Error(`invalid cron interval "${interval}"`)
      const secs = mins * 60
      if (secs < MIN_INTERVAL_SEC)
        throw new Error(`invalid cron interval "${interval}" — must be >= ${MIN_INTERVAL_SEC}s`)
      return secs
    }
    if (/^\d+$/.test(s)) {
      const secs = Number(s)
      if (secs < MIN_INTERVAL_SEC)
        throw new Error(`invalid interval "${interval}" — must be >= ${MIN_INTERVAL_SEC} seconds`)
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

/**
 * Default cap on the number of ACTIVE (non-expired) monitors the registry
 * will hold. POST /monitors has no auth yet (real per-principal auth + quota
 * await bd ax-e6b.30, currently 402-blocked) — this is a coarse, global bound
 * on the open-registration abuse surface in the meantime. Env-overridable via
 * Env.MAX_MONITORS (see worker.ts).
 */
export const DEFAULT_MAX_MONITORS = 1000

/**
 * Default TTL, in days, for an idle monitor. A monitor not run (and not
 * re-registered) within this window is treated as abandoned: excluded from
 * `listActive`/scheduled ticks and reclaimed by `evictExpired`. Chosen
 * generously so a legitimately slow-interval monitor is never evicted
 * between its own runs, while still bounding registry storage from
 * forgotten registrations. Env-overridable via Env.MONITOR_TTL_DAYS.
 */
export const DEFAULT_MONITOR_TTL_DAYS = 30

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

  // Serializes claimDue() attempts made against THIS store instance, so two
  // overlapping scheduledTick() calls sharing one isolate/store (the
  // realistic same-isolate re-entrancy risk, and exactly what a unit test
  // simulates via Promise.all) cannot both win the same monitor's due slot.
  // Workers KV has no native CAS, so this does NOT provide cross-isolate
  // atomicity — a genuinely distinct isolate racing the same KV namespace at
  // the same instant is a residual, out-of-process risk that claimDue's
  // read-then-write narrows (by claiming before the verify await) but
  // cannot fully close. See claimDue() below.
  private claimChain: Promise<unknown> = Promise.resolve()

  /**
   * Best-effort optimistic claim of a due monitor's slot. Verifies the
   * monitor's `nextDueAt` still equals `expectedNextDueAt` — i.e. nobody
   * else has already claimed it — and, if so, atomically (relative to other
   * claimDue() calls on this instance) advances it to `newNextDueAt` and
   * returns the updated record. Returns null if the monitor is gone, or if
   * another caller already claimed/advanced it (lost the race).
   *
   * Advancing nextDueAt is done as PART of the claim, before the caller does
   * any verify work: a crash (or a failed verify) mid-run still leaves the
   * schedule advanced by exactly one interval, rather than stuck re-due
   * forever or double-run by a retry.
   */
  claimDue(id: string, expectedNextDueAt: number, newNextDueAt: number): Promise<MonitorRecord | null> {
    const attempt = this.claimChain.then(async () => {
      const rec = await this.get(id)
      if (!rec || rec.nextDueAt !== expectedNextDueAt) return null
      const claimed: MonitorRecord = { ...rec, nextDueAt: newNextDueAt }
      await this.update(claimed)
      return claimed
    })
    // Chain the NEXT claim after this one fully settles (win or lose), so
    // claims against this store are strictly serialized in call order.
    this.claimChain = attempt.then(
      () => undefined,
      () => undefined,
    )
    return attempt
  }

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

  /**
   * Active monitors as of `nowMs`: every registered monitor whose
   * `expiresAt` has not yet passed. Used by GET /monitors and registration
   * cap checks — a plain read, no eviction side effect.
   */
  async listActive(nowMs: number): Promise<MonitorRecord[]> {
    const all = await this.list()
    return all.filter((m) => m.expiresAt === undefined || m.expiresAt > nowMs)
  }

  /**
   * Reclaim (delete) monitors whose `expiresAt` has passed as of `nowMs`.
   * Best-effort idle-eviction housekeeping — called each scheduled tick so
   * abandoned registrations don't accumulate against MAX_MONITORS forever.
   * Returns the number evicted.
   */
  async evictExpired(nowMs: number): Promise<number> {
    const all = await this.list()
    const dead = all.filter((m) => m.expiresAt !== undefined && m.expiresAt <= nowMs)
    for (const m of dead) await this.delete(m.id)
    return dead.length
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
