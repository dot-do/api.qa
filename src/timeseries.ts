/**
 * Time-series store — the queryable HISTORY of every scheduled run
 * (bd ax-e6b.29.2). Where ax-e6b.29.1's MonitorStore keeps a BOUNDED per-monitor
 * run list (last-N grades) and src/cache.ts keeps only a head:{host} pointer +
 * content-addressed replay, THIS module retains a metric SERIES per API (target)
 * AND per ENDPOINT — uptime, response latency (percentiles queryable),
 * error-rate, freshness, and the AX grade OVER TIME. It is the substrate the
 * dashboards / trends / alerts (bd ax-e6b.29.4) read.
 *
 * Purity boundary (identical to MonitorStore): this module NEVER judges and
 * NEVER probes. It is pure storage + a PURE query over the injectable `KVLike`
 * (the same REPORTS binding the report cache + monitor registry use, a distinct
 * `ts:` key prefix). Every metric is DERIVED from a verify run's already-observed
 * evidence (per-probe status/latency) and the report grade — see
 * `seriesPointsFromReport`. No fetch happens here, on write or on read: the query
 * is a deterministic pure read over stored points (same stored data → same
 * result), and the WRITE reuses the already-SSRF-gated verify path in
 * scheduledTick (bd ax-e6b.29.1) — no new network surface.
 *
 * STORAGE CHOICE. The estate's durable per-tenant substrate is Durable-Object
 * storage: DomainCooldown and MonitorSchedulerDO are declared `new_sqlite_classes`
 * in wrangler.jsonc yet reach that SQLite backing through the estate's key/value
 * storage API (state.storage.get/put) and, for the scheduler, through the shared
 * REPORTS namespace its inner createApp() binds. This store follows the SAME
 * grain the ax-e6b.29.1 run-history already set: a pure store over `KVLike`,
 * bound to REPORTS in production and to MemoryKV in tests. Keeping it a pure
 * KVLike store (rather than a raw `sql.exec` DO) preserves the estate's two load-
 * bearing properties — determinism and workerd-free unit tests — while leaving a
 * clean seam (see SeriesSource below) for a per-target SQLite TimeseriesDO shard
 * should series cardinality ever outgrow a single KV value.
 *
 * RETENTION. Raw points are kept at full resolution in a bounded ring
 * (`rawCap`); when the ring overflows, the oldest points are not dropped but
 * FOLDED into hourly rollup buckets (`rollupCap` buckets, oldest evicted). A
 * query answers latency PERCENTILES from the full-resolution raw points in the
 * window, and folds the coarse rollup buckets into the window's uptime %,
 * error-rate, and grade histogram — so a long-window uptime number still counts
 * evicted history even though its per-point latencies are gone.
 */

import type { KVLike } from './cache.js'
import type { VerificationReport } from './types.js'

/** One metric sample for a (target, endpoint?) series at instant `at`. */
export interface SeriesPoint {
  /** ms epoch the sampled run was produced (the scheduled tick time). */
  at: number
  /** The monitored origin, e.g. 'https://api.qa'. */
  target: string
  /**
   * `METHOD /path` of the endpoint this sample scores, or ABSENT for the
   * target-level aggregate sample (the whole API's reachability that tick).
   */
  endpoint?: string
  /** Was the target/endpoint serving this run? (see `deriveUp`). */
  up: boolean
  /** Response latency, ms. Per-endpoint: that endpoint's probe latency
   *  (mean of its probes that run). Target-level: probe-weighted mean across
   *  ALL same-origin probes (Σ elapsedMs / Σ probe count) — consistent with
   *  how the target-level errorRate is derived from the same probe set. */
  latencyMs: number
  /** Fraction 0..1 of this sample's probes that errored (network / 5xx). */
  errorRate: number
  /** The AX grade the run produced (target-level grade, carried on every
   *  sample as the grade CONTEXT for that tick). */
  grade: string
  /** ms since the previous sample of the SAME series (0 for the first) — the
   *  effective sampling gap / data-staleness of this series' cadence. */
  freshness: number
}

/** Aggregate of a range of evicted raw points, one per (hour, endpoint?). */
export interface RollupBucket {
  /** ms epoch of the hour start this bucket covers. */
  hourStart: number
  endpoint?: string
  count: number
  upCount: number
  /** Σ errorRate across folded points. */
  errSum: number
  /** Σ latencyMs across folded points (mean = latSum / count). */
  latSum: number
  /** grade → count histogram across folded points. */
  grades: Record<string, number>
}

/** Latency percentile summary over the raw points in a window. */
export interface LatencyStats {
  p50: number
  p95: number
  p99: number
  /** Number of full-resolution raw points the percentiles were computed from. */
  count: number
}

/** The pure query result over one series (target-level, or one endpoint). */
export interface SeriesStats {
  target: string
  /** ABSENT for the target-level series; `METHOD /path` for an endpoint. */
  endpoint?: string
  window: { fromMs: number; toMs: number }
  /** Total samples in the window (raw + folded rollup). */
  count: number
  /** upCount / count * 100, over raw + rollup. 0 when no samples. */
  uptimePct: number
  /** Mean error-rate 0..1 over raw + rollup. */
  errorRate: number
  /** Percentiles from the full-resolution raw points in the window. */
  latencyMs: LatencyStats
  /** grade → count histogram over raw + rollup. */
  grades: Record<string, number>
  /** Per-raw-point grade over time (rollups drop per-point detail), oldest→newest,
   *  bounded to the most recent `GRADE_HISTORY_CAP`. */
  gradeHistory: Array<{ at: number; grade: string }>
  /** The raw points in the window, oldest→newest, bounded to the most recent
   *  `SERIES_POINTS_CAP` (for dashboards that plot the line directly). */
  points: SeriesPoint[]
}

/** A target-level query, optionally with a per-endpoint breakdown. */
export interface SeriesQueryResult extends SeriesStats {
  /** Present when the query requested a breakdown: one SeriesStats per endpoint. */
  perEndpoint?: SeriesStats[]
}

export interface SeriesQueryOpts {
  /** Restrict to this endpoint (`METHOD /path`). Omit → the target-level series. */
  endpoint?: string
  /** Window lower bound, ms epoch (inclusive). Default: no lower bound. */
  fromMs?: number
  /**
   * Window upper bound, ms epoch (inclusive). Default: `nowMs` if supplied,
   * else the latest timestamp actually present in the stored series
   * (data-driven — the store never reads the wall clock; see
   * `TimeseriesStore.query`).
   */
  toMs?: number
  /** Reference "now" for a relative window / the default upper bound. Callers
   *  that want a wall-clock-relative window must supply this themselves. */
  nowMs?: number
  /** Also compute a per-endpoint breakdown (target-level query only). */
  breakdown?: boolean
}

/** Full-resolution raw points retained per series-set before rollup. */
export const DEFAULT_RAW_CAP = 4000
/** Hourly rollup buckets retained before the oldest are evicted. */
export const DEFAULT_ROLLUP_CAP = 2000
/** Cap on the gradeHistory array returned by a query. */
export const GRADE_HISTORY_CAP = 1000
/** Cap on the raw `points` array returned by a query. */
export const SERIES_POINTS_CAP = 2000

const HOUR_MS = 3_600_000

// ---------------------------------------------------------------------------
// Pure metric derivation from a verify run's evidence + report grade
// ---------------------------------------------------------------------------

/** A probe "errored" when it got no answer (network/timeout → null status) or a
 *  server error (5xx). A 2xx/3xx/4xx (incl. 402 offer, 404 missing surface) all
 *  count as the target ANSWERING — degraded maybe, but not down. */
function isProbeError(status: number | null): boolean {
  return status === null || status >= 500
}

/**
 * Target is UP for the tick when at least one same-origin probe got an answer
 * (errCount < total) — i.e. not a total outage. Degradation is carried in
 * `errorRate`, not by flipping `up`. An empty probe set is treated as down.
 */
function deriveUp(errCount: number, total: number): boolean {
  return total > 0 && errCount < total
}

function round(n: number): number {
  return Math.round(n)
}

/**
 * Derive the per-target + per-endpoint samples for one verify run from its
 * already-observed evidence (per-probe status + elapsedMs) and report grade.
 * PURE: no fetch, no judging — it reads what the SSRF-gated verify path already
 * recorded. Only SAME-ORIGIN probes count toward the monitored target's own
 * reachability (an off-origin OAuth AS-metadata hop is excluded).
 *
 * `freshness` is left at 0 here; the store fills it in at record time from the
 * previous sample of each series (it needs stored history to compute the gap).
 */
export function seriesPointsFromReport(
  report: VerificationReport,
  at: number,
): Array<Omit<SeriesPoint, 'freshness'>> {
  const target = report.target
  const targetOrigin = safeOrigin(target)
  const items = report.evidence.items.filter((it) => safeOrigin(it.url) === targetOrigin)

  // Group same-origin probes by endpoint identity `METHOD /path`.
  const byEndpoint = new Map<string, { errCount: number; total: number; latSum: number }>()
  for (const it of items) {
    const key = endpointKey(it.method, it.url)
    if (key === undefined) continue
    const g = byEndpoint.get(key) ?? { errCount: 0, total: 0, latSum: 0 }
    g.total += 1
    g.latSum += Math.max(0, it.elapsedMs)
    if (isProbeError(it.status)) g.errCount += 1
    byEndpoint.set(key, g)
  }

  const endpointPoints: Array<Omit<SeriesPoint, 'freshness'>> = []
  for (const [endpoint, g] of byEndpoint) {
    const latencyMs = round(g.latSum / g.total)
    endpointPoints.push({
      at,
      target,
      endpoint,
      up: deriveUp(g.errCount, g.total),
      latencyMs,
      errorRate: g.errCount / g.total,
      grade: report.grade,
    })
  }

  // Target-level aggregate over ALL same-origin probes. latencyMs is
  // PROBE-weighted — Σ(elapsedMs) / Σ(probe count) over every same-origin
  // probe — matching how errorRate is derived from the SAME `items`
  // population, rather than an unweighted mean of each endpoint's own mean
  // (which would over-weight endpoints with few probes).
  const total = items.length
  const errCount = items.filter((it) => isProbeError(it.status)).length
  const latTotal = items.reduce((a, it) => a + Math.max(0, it.elapsedMs), 0)
  const targetLatency = total > 0 ? round(latTotal / total) : 0
  const targetPoint: Omit<SeriesPoint, 'freshness'> = {
    at,
    target,
    up: deriveUp(errCount, total),
    latencyMs: targetLatency,
    errorRate: total > 0 ? errCount / total : 1,
    grade: report.grade,
  }

  // Target-level first, then endpoints sorted for deterministic order.
  endpointPoints.sort((a, b) => (a.endpoint! < b.endpoint! ? -1 : a.endpoint! > b.endpoint! ? 1 : 0))
  return [targetPoint, ...endpointPoints]
}

function endpointKey(method: string, url: string): string | undefined {
  try {
    return `${method.toUpperCase()} ${new URL(url).pathname}`
  } catch {
    return undefined
  }
}

function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Percentiles (pure) — nearest-rank, deterministic
// ---------------------------------------------------------------------------

/** Nearest-rank percentile of an ASCENDING-sorted array. p in [0,100]. */
export function percentile(sortedAsc: number[], p: number): number {
  const n = sortedAsc.length
  if (n === 0) return 0
  const rank = Math.ceil((p / 100) * n)
  const idx = Math.min(n - 1, Math.max(0, rank - 1))
  return sortedAsc[idx]!
}

// ---------------------------------------------------------------------------
// The store — pure storage + pure query over KVLike (REPORTS in prod)
// ---------------------------------------------------------------------------

/** Pure storage over KVLike. No judging, no probing, no SSRF policy. */
export class TimeseriesStore {
  private readonly rawCap: number
  private readonly rollupCap: number

  constructor(
    private readonly kv: KVLike,
    opts: { rawCap?: number; rollupCap?: number } = {},
  ) {
    this.rawCap = opts.rawCap ?? DEFAULT_RAW_CAP
    this.rollupCap = opts.rollupCap ?? DEFAULT_ROLLUP_CAP
  }

  private rawK(id: string): string {
    return `ts:raw:${id}`
  }
  private rollK(id: string): string {
    return `ts:roll:${id}`
  }

  private async readRaw(id: string): Promise<SeriesPoint[]> {
    const raw = await this.kv.get(this.rawK(id))
    if (!raw) return []
    try {
      const arr = JSON.parse(raw) as unknown
      return Array.isArray(arr) ? (arr as SeriesPoint[]) : []
    } catch {
      return []
    }
  }

  private async readRollups(id: string): Promise<RollupBucket[]> {
    const raw = await this.kv.get(this.rollK(id))
    if (!raw) return []
    try {
      const arr = JSON.parse(raw) as unknown
      return Array.isArray(arr) ? (arr as RollupBucket[]) : []
    } catch {
      return []
    }
  }

  /**
   * Record one verify run's samples (target-level + per-endpoint) under series
   * id `id`. Computes each sample's `freshness` from the previous sample of the
   * same (endpoint) series, appends to the raw ring, and folds any overflow into
   * hourly rollup buckets. One KV read + one write per series id per run.
   */
  async record(id: string, samples: Array<Omit<SeriesPoint, 'freshness'>>): Promise<void> {
    const raw = await this.readRaw(id)
    const rollups = await this.readRollups(id)

    // freshness: gap since the LAST sample of the same endpoint series (looking
    // at already-stored raw first, then samples appended earlier in THIS batch).
    const lastAt = new Map<string | undefined, number>()
    for (const p of raw) {
      const k = p.endpoint
      const prev = lastAt.get(k)
      if (prev === undefined || p.at > prev) lastAt.set(k, p.at)
    }
    for (const s of samples) {
      const prev = lastAt.get(s.endpoint)
      const freshness = prev === undefined ? 0 : Math.max(0, s.at - prev)
      raw.push({ ...s, freshness })
      lastAt.set(s.endpoint, s.at)
    }

    // Retention: overflow oldest raw points into hourly rollup buckets.
    if (raw.length > this.rawCap) {
      const overflow = raw.splice(0, raw.length - this.rawCap)
      for (const p of overflow) foldIntoRollup(rollups, p)
      // Keep rollups bounded + ordered oldest→newest.
      rollups.sort((a, b) =>
        a.hourStart - b.hourStart ||
        (a.endpoint ?? '').localeCompare(b.endpoint ?? ''),
      )
      if (rollups.length > this.rollupCap) rollups.splice(0, rollups.length - this.rollupCap)
    }

    await this.kv.put(this.rawK(id), JSON.stringify(raw))
    if (rollups.length) await this.kv.put(this.rollK(id), JSON.stringify(rollups))
  }

  /**
   * PURE READ (no re-probe): the time-series over a window for series `id`.
   * uptime %, latency p50/p95/p99, error-rate, and grade history — computed
   * deterministically from stored points. Same stored data → same result.
   */
  async query(id: string, opts: SeriesQueryOpts = {}): Promise<SeriesQueryResult> {
    const raw = await this.readRaw(id)
    const rollups = await this.readRollups(id)
    // No wall-clock read here — the store's query API must be clock-
    // independent for determinism (same stored data → same result on every
    // call, forever). When neither `toMs` nor `nowMs` is supplied, the
    // default window end is DATA-DRIVEN: the latest timestamp actually
    // present in the stored series, never `Date.now()`. Callers that need a
    // "now"-relative window (e.g. the Worker's /series routes) must pass an
    // explicit `nowMs`/`toMs`.
    const toMs = opts.toMs ?? opts.nowMs ?? latestStoredAt(raw, rollups)
    const fromMs = opts.fromMs ?? Number.NEGATIVE_INFINITY
    // Rollup buckets do not retain the target string; fall back to the series id.
    const target = raw.find((p) => p.target)?.target ?? id

    const base = computeStats(raw, rollups, { endpoint: opts.endpoint, fromMs, toMs, target })

    if (!opts.breakdown || opts.endpoint !== undefined) return base

    // Per-endpoint breakdown: every distinct endpoint present in raw or rollup.
    const endpoints = new Set<string>()
    for (const p of raw) if (p.endpoint !== undefined) endpoints.add(p.endpoint)
    for (const b of rollups) if (b.endpoint !== undefined) endpoints.add(b.endpoint)
    const perEndpoint = [...endpoints]
      .sort()
      .map((endpoint) => computeStats(raw, rollups, { endpoint, fromMs, toMs, target: base.target }))

    return { ...base, perEndpoint }
  }
}

/**
 * Deterministic default window end when a query supplies neither `toMs` nor
 * `nowMs`: the latest timestamp actually present in the stored data — the
 * newest raw point's `at`, or the end of the newest rollup hour, whichever is
 * later. NEVER the wall clock (see `TimeseriesStore.query`). An empty series
 * (no raw points, no rollups) falls back to 0 — an empty window, not "now".
 */
function latestStoredAt(raw: SeriesPoint[], rollups: RollupBucket[]): number {
  let latest = 0
  for (const p of raw) if (p.at > latest) latest = p.at
  for (const b of rollups) {
    const end = b.hourStart + HOUR_MS
    if (end > latest) latest = end
  }
  return latest
}

/** Fold one evicted raw point into its (hour, endpoint) rollup bucket. */
function foldIntoRollup(rollups: RollupBucket[], p: SeriesPoint): void {
  const hourStart = Math.floor(p.at / HOUR_MS) * HOUR_MS
  let bucket = rollups.find((b) => b.hourStart === hourStart && b.endpoint === p.endpoint)
  if (!bucket) {
    bucket = { hourStart, endpoint: p.endpoint, count: 0, upCount: 0, errSum: 0, latSum: 0, grades: {} }
    rollups.push(bucket)
  }
  bucket.count += 1
  if (p.up) bucket.upCount += 1
  bucket.errSum += p.errorRate
  bucket.latSum += p.latencyMs
  bucket.grades[p.grade] = (bucket.grades[p.grade] ?? 0) + 1
}

/** The pure aggregation for ONE series (endpoint filter) over a window. */
function computeStats(
  raw: SeriesPoint[],
  rollups: RollupBucket[],
  q: { endpoint?: string; fromMs: number; toMs: number; target: string },
): SeriesStats {
  const inWindowRaw = raw
    .filter((p) => p.endpoint === q.endpoint && p.at >= q.fromMs && p.at <= q.toMs)
    .sort((a, b) => a.at - b.at)
  const inWindowRollups = rollups.filter(
    (b) => b.endpoint === q.endpoint && b.hourStart <= q.toMs && b.hourStart + HOUR_MS > q.fromMs,
  )

  let count = inWindowRaw.length
  let upCount = inWindowRaw.filter((p) => p.up).length
  let errSum = inWindowRaw.reduce((a, p) => a + p.errorRate, 0)
  const grades: Record<string, number> = {}
  for (const p of inWindowRaw) grades[p.grade] = (grades[p.grade] ?? 0) + 1
  for (const b of inWindowRollups) {
    count += b.count
    upCount += b.upCount
    errSum += b.errSum
    for (const [g, n] of Object.entries(b.grades)) grades[g] = (grades[g] ?? 0) + n
  }

  const latencies = inWindowRaw.map((p) => p.latencyMs).sort((a, b) => a - b)
  const latencyMs: LatencyStats = {
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    count: latencies.length,
  }

  const stats: SeriesStats = {
    target: q.target,
    window: { fromMs: isFinite(q.fromMs) ? q.fromMs : (inWindowRaw[0]?.at ?? 0), toMs: q.toMs },
    count,
    uptimePct: count > 0 ? (upCount / count) * 100 : 0,
    errorRate: count > 0 ? errSum / count : 0,
    latencyMs,
    grades,
    gradeHistory: inWindowRaw.slice(-GRADE_HISTORY_CAP).map((p) => ({ at: p.at, grade: p.grade })),
    points: inWindowRaw.slice(-SERIES_POINTS_CAP),
  }
  if (q.endpoint !== undefined) stats.endpoint = q.endpoint
  return stats
}

// ---------------------------------------------------------------------------
// SeriesSource — the pluggable READ seam (deferred apis.ax-ledger integration)
// ---------------------------------------------------------------------------

/**
 * Where a series is SOURCED from. api.qa writes and reads its OWN series from
 * scheduled runs (ScheduledRunSeriesSource) for external targets + the default.
 *
 * DEFERRED INTEGRATION (do NOT build here — bd ax-e6b.3 §2.6). For an
 * apis.ax-FRONTED upstream, the series should eventually be sourced from the
 * apis.ax supply-engine USAGE LEDGER — the real per-request usage/latency/error
 * record the gateway already keeps — instead of api.qa re-probing the origin.
 * That ledger lives in packages/apis.ax (concurrent-owned); it would be a second
 * `SeriesSource` implementation (an `ApisAxLedgerSeriesSource`) selected when the
 * target is apis.ax-fronted. This interface is the clean seam for that swap: the
 * query endpoint depends only on `SeriesSource`, never on how the points were
 * produced. Nothing in this repo reaches into packages/apis.ax.
 */
export interface SeriesSource {
  query(id: string, opts: SeriesQueryOpts): Promise<SeriesQueryResult>
}

/** The default source: api.qa's own series, written from scheduled runs. */
export class ScheduledRunSeriesSource implements SeriesSource {
  constructor(private readonly store: TimeseriesStore) {}
  query(id: string, opts: SeriesQueryOpts): Promise<SeriesQueryResult> {
    return this.store.query(id, opts)
  }
}
