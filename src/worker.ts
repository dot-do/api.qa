/**
 * The api.qa Cloudflare Worker — the deployed mount of the verifier core.
 *
 * Routes:
 *   GET  /                      content-negotiated (curl → llms.txt, browser → HTML)
 *   GET  /llms.txt              agent-actionable usage doc
 *   GET  /.well-known/agents.json
 *   GET  /icp.json
 *   GET  /openapi.json
 *   GET  /health                keyless liveness
 *   GET  /offers/attested-run   the 402 boundary (a structured offer, not an error)
 *   GET  /self                  api.qa's live verdict on api.qa (loopback, no network)
 *   GET  /{domain}              the public grade page (markdown | HTML+JSON-LD | JSON)
 *   POST /verify                {target, specText?|spec?, expectedDigest?, seed?}
 *   POST /suite                 {environment, suite?|suiteText?|suiteDigest, target?, expectedDigest?, seed?}
 *                               — run a reusable suite (inline or a STORED suite by digest)
 *                                 against a selected environment
 *
 * `createApp` takes an injectable fetcher so tests and the self-route run the
 * verifier against this very handler without touching the network.
 */

import { verifyTarget, rejudge } from './verify.js'
import { verifyPinnedSpec, verifySuite, parseSuite, type PinnedReport, type SuiteReport } from './pinned.js'
import { reportMarkdown, pinnedMarkdown, suiteMarkdown } from './render.js'
import { landingHtml, reportPageHtml } from './views.js'
import { generateSigningKey, importSigningKeyPair, verdictDigest } from './attest.js'
import { sha256Hex } from './digest.js'
import type { Fetcher } from './http.js'
import {
  ReportCache,
  hostKey,
  DEFAULT_TTL_SECONDS,
  type KVLike,
  type CacheHit,
} from './cache.js'
import {
  DurableObjectCooldown,
  DEFAULT_MIN_INTERVAL_MS,
  type Cooldown,
  type CooldownDecision,
  type DONamespaceLike,
  type DOState,
} from './cooldown.js'
import {
  MonitorStore,
  parseIntervalSec,
  monitorId,
  DEFAULT_MAX_PER_TICK,
  DEFAULT_MAX_MONITORS,
  DEFAULT_MONITOR_TTL_DAYS,
  type MonitorRecord,
  type MonitorRunRecord,
} from './monitors.js'
import {
  TimeseriesStore,
  ScheduledRunSeriesSource,
  seriesPointsFromReport,
  type SeriesSource,
  type SeriesQueryOpts,
} from './timeseries.js'
import { normalizeTarget } from './http.js'
import {
  AlertDispatcher,
  AlertStateStore,
  StubEmailChannel,
  validateAlertRules,
  DEFAULT_ALERT_WINDOW_MS,
  type AlertRules,
} from './alerts.js'
import type { VerificationReport } from './types.js'
import {
  SELF_ORIGIN,
  selfAgentsJson,
  selfIcpJson,
  selfLlmsTxt,
  selfOffer,
  selfOpenapi,
} from './self.js'
import { VERIFIER_VERSION } from './verify.js'

// Re-exported so wrangler discovers the DO class as a named export of `main`.
export { DomainCooldown } from './cooldown.js'

export interface Env {
  /** base64 pkcs8 Ed25519 key — the held-out attestation key (Worker secret). */
  SIGNING_KEY?: string
  ALLOW_PRIVATE_TARGETS?: string
  /** KV report cache (per-target cooldown + replay store). */
  REPORTS?: KVLike
  /** Per-domain politeness Durable Object namespace (class DomainCooldown). */
  COOLDOWN?: DONamespaceLike
  /**
   * Singleton scheduler Durable Object namespace (class MonitorSchedulerDO,
   * bd ax-e6b.29.1 MED fix). When bound, scheduledTick() delegates the ENTIRE
   * tick to idFromName(MONITOR_SCHEDULER_SINGLETON_NAME) on this namespace —
   * exactly one such DO instance exists globally, so every isolate's
   * scheduled() call ends up running against that ONE DO's memoized
   * MonitorStore, making claimDue's claim cross-isolate-atomic (not just
   * same-instance). Unbound falls back to a local, same-instance-only tick
   * (still guarded by MonitorStore.claimDue's private claimChain).
   */
  MONITOR_SCHEDULER?: DONamespaceLike
  /** Cache freshness / per-target cooldown horizon, seconds. */
  CACHE_TTL_SECONDS?: string
  /** Minimum inter-probe interval per domain across isolates, ms. */
  COOLDOWN_MIN_INTERVAL_MS?: string
  /** Max monitors re-run per scheduled tick before carrying the rest over. */
  MONITOR_MAX_PER_TICK?: string
  /** Cap on ACTIVE (non-expired) registered monitors — bounds the open,
   * unauthenticated POST /monitors abuse surface (real per-principal auth
   * awaits bd ax-e6b.30, still 402-blocked). */
  MAX_MONITORS?: string
  /** Idle-eviction TTL, in days: a monitor not run/refreshed this long is
   * treated as abandoned (excluded from listing/ticking, evictable). */
  MONITOR_TTL_DAYS?: string
  /** Time-series raw-point ring cap per series before rollup (bd ax-e6b.29.2). */
  TS_RAW_CAP?: string
  /** Time-series hourly rollup-bucket cap before oldest are evicted. */
  TS_ROLLUP_CAP?: string
}

/** Summary of one scheduled tick — returned for tests/observability. */
export interface TickSummary {
  tickedAt: number
  /** Monitors whose nextDueAt had passed at tick time. */
  due: number
  /** Monitors actually re-verified this tick. */
  ran: number
  /** Due monitors skipped because their domain was in cooldown (retried next tick). */
  skippedCooldown: number
  /** Due monitors deferred to a later tick because the per-tick cap was hit. */
  deferredOverCap: number
  /**
   * Due monitors whose claim+verify+record threw (e.g. verifyTarget's
   * normalizeTarget throwing on a corrupted stored target) — bd ax-e6b.29.1
   * LOW fix. Isolated per monitor so one throw cannot abort the rest of the
   * tick's batch; the monitor's schedule is still advanced so it is not
   * retried every tick or left permanently stuck.
   */
  errored: number
  runs: MonitorRunRecord[]
}

const LINKSET =
  '</llms.txt>; rel="service-doc", </.well-known/agents.json>; rel="service-desc", </openapi.json>; rel="describedby"'

const DOMAIN_ROUTE = /^\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/i

/**
 * The one global id every isolate's scheduledTick() resolves to on the
 * MONITOR_SCHEDULER namespace — the cross-isolate serialization point (bd
 * ax-e6b.29.1 MED fix: Workers KV has no CAS, so two isolates that each read
 * `nextDueAt` before either writes it can otherwise both claim and
 * double-run the same due slot).
 */
const MONITOR_SCHEDULER_SINGLETON_NAME = 'monitor-scheduler'

export interface App {
  fetch(request: Request): Promise<Response>
  /**
   * Run one scheduled monitoring tick: re-verify every DUE registered monitor
   * (respecting per-domain cooldown + the per-tick cap), attest exactly as a
   * fetch-triggered run would, and append run-history records. Fully AFK — no
   * human trigger. `nowMs` is the tick time (event.scheduledTime in prod).
   */
  scheduledTick(nowMs?: number): Promise<TickSummary>
}

export function createApp(
  env: Env = {},
  opts: {
    externalFetcher?: Fetcher
    externalDelayMs?: number
    /** Injected for tests; falls back to env.REPORTS when present. */
    cache?: ReportCache
    /** Injected for tests; falls back to env.COOLDOWN when present. */
    cooldown?: Cooldown
    /**
     * Injected for tests; falls back to env.MONITOR_SCHEDULER when present.
     * When set, scheduledTick() delegates the ENTIRE tick to this DO
     * namespace's singleton instance instead of running it locally — the
     * cross-isolate-atomic claim path (bd ax-e6b.29.1 MED fix).
     */
    scheduler?: DONamespaceLike
    /** Injected for tests; falls back to env.REPORTS when present. */
    monitors?: MonitorStore
    /**
     * Injected for tests; falls back to a TimeseriesStore over env.REPORTS.
     * The queryable per-target/per-endpoint metric series (bd ax-e6b.29.2)
     * written on each scheduled run + read by the /series query endpoints.
     */
    timeseries?: TimeseriesStore
    /**
     * Injected for tests; falls back to an AlertDispatcher over env.REPORTS.
     * Evaluates alert rules after each scheduled run + time-series write and
     * delivers to the configured channels (bd ax-e6b.29.3). Tests inject one
     * wired to a capturing fetcher to assert exactly-once / dedupe / SSRF-gating.
     */
    alerts?: AlertDispatcher
    /**
     * Convenience test seam: the outbound fetcher the DEFAULT AlertDispatcher
     * POSTs channel deliveries through (a new outbound surface, distinct from
     * the target-probing fetcher). Ignored when `alerts` is injected directly.
     */
    alertFetcher?: Fetcher
    /** Override the per-tick monitor cap (else env / default). */
    maxPerTick?: number
    /** Injectable clock so cache TTL / age is deterministic in tests. */
    now?: () => number
  } = {},
): App {
  const externalDelayMs = opts.externalDelayMs ?? 150
  const now = opts.now ?? (() => Date.now())
  let keysPromise: Promise<CryptoKeyPair> | undefined
  const keys = () =>
    (keysPromise ??= env.SIGNING_KEY ? importSigningKeyPair(env.SIGNING_KEY) : generateSigningKey())

  const ttlSeconds = env.CACHE_TTL_SECONDS ? Number(env.CACHE_TTL_SECONDS) : DEFAULT_TTL_SECONDS
  const minIntervalMs = env.COOLDOWN_MIN_INTERVAL_MS
    ? Number(env.COOLDOWN_MIN_INTERVAL_MS)
    : DEFAULT_MIN_INTERVAL_MS
  const cache = opts.cache ?? (env.REPORTS ? new ReportCache(env.REPORTS, ttlSeconds) : undefined)
  const cooldown =
    opts.cooldown ?? (env.COOLDOWN ? new DurableObjectCooldown(env.COOLDOWN, minIntervalMs) : undefined)
  const scheduler = opts.scheduler ?? env.MONITOR_SCHEDULER
  const monitors = opts.monitors ?? (env.REPORTS ? new MonitorStore(env.REPORTS) : undefined)
  // Time-series store (bd ax-e6b.29.2): retains a queryable per-target AND
  // per-endpoint metric series (uptime/latency/error-rate/grade over time)
  // written from each scheduled run — the substrate dashboards/trends/alerts
  // (bd ax-e6b.29.4) read. Bound to the same REPORTS namespace (distinct `ts:`
  // prefix), MemoryKV in tests.
  const timeseries =
    opts.timeseries ??
    (env.REPORTS
      ? new TimeseriesStore(env.REPORTS, {
          ...(env.TS_RAW_CAP ? { rawCap: Number(env.TS_RAW_CAP) } : {}),
          ...(env.TS_ROLLUP_CAP ? { rollupCap: Number(env.TS_ROLLUP_CAP) } : {}),
        })
      : undefined)
  // The pluggable READ seam (deferred apis.ax-ledger integration — see
  // timeseries.ts SeriesSource). Today the ONLY source is api.qa's own series
  // written from scheduled runs; the query endpoints depend on this interface,
  // never on how the points were produced.
  const seriesSource: SeriesSource | undefined = timeseries
    ? new ScheduledRunSeriesSource(timeseries)
    : undefined
  // Alerting (bd ax-e6b.29.3): evaluate a monitor's alert rules after each
  // scheduled run + time-series write and deliver to its configured channels.
  // Channel delivery is a NEW outbound-POST surface, SSRF-gated in alerts.ts at
  // config time AND before every POST. Default dispatcher POSTs through the real
  // `fetch` (or opts.alertFetcher in tests); the email channel is the documented
  // StubEmailChannel seam (no real provider wired here).
  const alertAllowPrivate = env.ALLOW_PRIVATE_TARGETS === 'true'
  const alerts =
    opts.alerts ??
    (env.REPORTS
      ? new AlertDispatcher(new AlertStateStore(env.REPORTS), {
          ...(opts.alertFetcher ? { fetcher: opts.alertFetcher } : {}),
          allowPrivate: alertAllowPrivate,
          email: new StubEmailChannel(),
        })
      : undefined)
  const maxPerTick =
    opts.maxPerTick ?? (env.MONITOR_MAX_PER_TICK ? Number(env.MONITOR_MAX_PER_TICK) : DEFAULT_MAX_PER_TICK)
  // LOW abuse-surface bound (bd ax-e6b.29.1): POST /monitors has no auth yet
  // (real per-principal quota + registration auth await bd ax-e6b.30, still
  // 402-blocked). Until then, cap total active registrations and evict idle
  // ones so an open registry cannot grow without bound.
  const maxMonitors = env.MAX_MONITORS ? Number(env.MAX_MONITORS) : DEFAULT_MAX_MONITORS
  const monitorTtlMs =
    (env.MONITOR_TTL_DAYS ? Number(env.MONITOR_TTL_DAYS) : DEFAULT_MONITOR_TTL_DAYS) * 24 * 60 * 60 * 1000

  // Loopback: any verification of api.qa itself dispatches back into this
  // handler — the verifier discovers itself over its own protocols. Hoisted to
  // createApp scope so BOTH the fetch path and the scheduled tick reuse the
  // same self-loopback / external-fetch routing (no bypass on either path).
  const loopback: Fetcher = (u, init) => app.fetch(new Request(u, init))
  const routed: Fetcher = (u, init) =>
    u.startsWith(SELF_ORIGIN) ? loopback(u, init) : (opts.externalFetcher ?? fetch)(u, init)

  /**
   * The actual tick body: claim + re-verify every DUE monitor through the
   * SAME attested verifyTarget/verifySuite/cooldown/SSRF path a fetch run
   * uses — no gate-skipping fork. Called directly when no scheduler DO is
   * configured (local dev / a single-instance test — same-instance overlap
   * is still guarded by MonitorStore.claimDue's private claimChain), and by
   * MonitorSchedulerDO.fetch() (via its own inner createApp()) for the
   * cross-isolate-atomic production path (bd ax-e6b.29.1 MED fix).
   */
  async function runLocalTick(nowMs: number): Promise<TickSummary> {
    const summary: TickSummary = {
      tickedAt: nowMs,
      due: 0,
      ran: 0,
      skippedCooldown: 0,
      deferredOverCap: 0,
      errored: 0,
      runs: [],
    }
    if (!monitors) return summary

    // Idle-eviction housekeeping (LOW abuse-surface bound): reclaim any
    // monitor that hasn't run/refreshed within its TTL before it can occupy
    // a MAX_MONITORS slot or be considered for this tick. Real per-principal
    // quota + registration auth await bd ax-e6b.30 (currently 402-blocked)
    // — this is a coarse interim bound.
    await monitors.evictExpired(nowMs)

    // Due = nextDueAt has passed. Run the MOST-overdue first so a cap does
    // not perpetually starve one monitor (fair carry-over).
    const all = await monitors.list()
    const due = all.filter((mon) => mon.nextDueAt <= nowMs).sort((a, b) => a.nextDueAt - b.nextDueAt)
    summary.due = due.length

    for (const mon of due) {
      if (summary.ran >= maxPerTick) {
        // Cap hit: defer the rest to a later tick (they stay due, unchanged).
        summary.deferredOverCap += 1
        continue
      }

      // Cross-isolate politeness: a monitor whose domain is in cooldown is
      // SKIPPED this tick (not forced) and retried next — we do NOT advance
      // its nextDueAt, so it remains due. Self (loopback) never gates.
      const isSelf = hostKey(mon.target) === 'api.qa'
      if (!isSelf && cooldown) {
        const decision = await cooldown.reserve(hostKey(mon.target))
        if (!decision.allowed) {
          summary.skippedCooldown += 1
          continue
        }
      }

      // One monitor's throw must not abort the rest of this tick's batch
      // (bd ax-e6b.29.1 LOW fix) — isolate claim+verify+record per monitor.
      try {
        // --- Claim this monitor's due slot BEFORE the verify await --------
        // Cloudflare does NOT guarantee non-overlapping scheduled()
        // invocations: two overlapping ticks can both have listed this same
        // pre-advance snapshot above. claimDue() is a best-effort OPTIMISTIC
        // claim: it skips if another concurrent tick already advanced this
        // monitor's nextDueAt past the snapshot (i.e. already claimed/ran it
        // this pass). Advancing nextDueAt HERE, as part of the claim and
        // before the verify await, means a crash (or a failed verify)
        // mid-run skips at most one slot rather than double-running it — a
        // genuinely due monitor still advances even when verify fails.
        const claimed = await monitors.claimDue(mon.id, mon.nextDueAt, nowMs + mon.intervalSec * 1000)
        if (!claimed) {
          // Lost the race to a concurrent tick (or deleted mid-tick) — not
          // due for US anymore. Not a skip worth counting; just move on.
          continue
        }

        // Re-verify through the SAME attested verify path a fetch run uses.
        const report = await verifyTarget(claimed.target, {
          mode: 'remote',
          fetcher: routed,
          delayMs: isSelf ? 0 : externalDelayMs,
          signingKeys: await keys(),
          allowPrivateTargets: env.ALLOW_PRIVATE_TARGETS === 'true',
        })

        let suiteVerdict: boolean | undefined
        if (claimed.suiteDigest && cache) {
          const suiteText = await cache.getSuiteText(claimed.suiteDigest)
          if (suiteText !== null && claimed.environment) {
            const suiteReport = await verifySuite(suiteText, claimed.environment, {
              mode: 'remote',
              fetcher: routed,
              target: claimed.target,
              delayMs: isSelf ? 0 : externalDelayMs,
              allowPrivateTargets: env.ALLOW_PRIVATE_TARGETS === 'true',
            })
            suiteVerdict = suiteReport.passed
          }
        }

        // The STABLE attested-verdict digest (seed-independent) — the anchor the
        // NEXT run's attestation-change alert compares against (bd ax-e6b.29.3).
        const vDigest = await verdictDigest(report)
        // Capture the PRIOR run BEFORE appending this one — grade-regression /
        // attestation-change compare this run against it.
        const priorRun = (await monitors.listRuns(claimed.id)).at(-1)

        const run: MonitorRunRecord = {
          monitorId: claimed.id,
          at: nowMs,
          grade: report.grade,
          ...(suiteVerdict !== undefined ? { suiteVerdict } : {}),
          digest: report.discovery.evidenceDigest,
          verdictDigest: vDigest,
        }
        await monitors.appendRun(run)

        // Time-series (bd ax-e6b.29.2): write a metric sample per target AND
        // per endpoint from THIS run's already-observed evidence — uptime,
        // latency, error-rate, grade, freshness — keyed by the monitor id. Pure
        // derivation over the report the SSRF-gated verify path just produced;
        // no new fetch. Keyed by monitor id so GET /monitors/:id/series reads it.
        if (timeseries) {
          await timeseries.record(claimed.id, seriesPointsFromReport(report, nowMs))
        }

        // Alerting (bd ax-e6b.29.3): AFTER the run + time-series write, evaluate
        // this monitor's alert rules over the stored series (uptime/latency/
        // error-rate) plus this-run-vs-prior (grade regression / attested-verdict
        // change) and deliver to the configured channels — deduped/debounced per
        // (monitor, rule). Wrapped so a delivery failure can never break the tick.
        if (alerts && claimed.alerts) {
          try {
            const windowMs = claimed.alerts.windowMs ?? DEFAULT_ALERT_WINDOW_MS
            const stats = timeseries
              ? await timeseries.query(claimed.id, { fromMs: nowMs - windowMs, toMs: nowMs, nowMs })
              : undefined
            await alerts.dispatch({
              monitor: { id: claimed.id, target: claimed.target, alerts: claimed.alerts },
              ...(stats
                ? {
                    series: {
                      uptimePct: stats.uptimePct,
                      errorRate: stats.errorRate,
                      latencyP95: stats.latencyMs.p95,
                      count: stats.count,
                    },
                  }
                : {}),
              run: { at: nowMs, grade: report.grade, digest: run.digest, verdictDigest: vDigest },
              ...(priorRun
                ? {
                    prior: {
                      grade: priorRun.grade,
                      digest: priorRun.digest,
                      ...(priorRun.verdictDigest !== undefined ? { verdictDigest: priorRun.verdictDigest } : {}),
                    },
                  }
                : {}),
              now: nowMs,
            })
          } catch (err) {
            const m = err instanceof Error ? err.message : String(err)
            console.error(`scheduledTick: alert dispatch for monitor ${claimed.id} failed: ${m}`)
          }
        }

        summary.runs.push(run)
        summary.ran += 1

        // A completed run refreshes lastRunAt + the idle-eviction TTL.
        // nextDueAt was already advanced at claim time above.
        claimed.lastRunAt = nowMs
        claimed.expiresAt = nowMs + monitorTtlMs
        await monitors.update(claimed)
      } catch (err) {
        // Isolate the failure to THIS monitor (bd ax-e6b.29.1 LOW fix): log
        // it and keep going so the rest of the due batch still runs this
        // tick. claimDue already advanced nextDueAt before the throwing
        // await in the common case (e.g. verifyTarget->normalizeTarget
        // throwing on a corrupted stored target); defensively re-check and
        // force the schedule forward here too, so a throw before/inside the
        // claim itself can never leave the monitor stuck re-due every tick.
        summary.errored += 1
        const message = err instanceof Error ? err.message : String(err)
        console.error(`scheduledTick: monitor ${mon.id} errored and was skipped this tick: ${message}`)
        const rec = await monitors.get(mon.id)
        if (rec && rec.nextDueAt === mon.nextDueAt) {
          await monitors.update({ ...rec, nextDueAt: nowMs + mon.intervalSec * 1000 })
        }
        continue
      }
    }

    return summary
  }

  const app: App = {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url)
      const accept = request.headers.get('accept') ?? ''
      const path = url.pathname

      try {
        if (request.method === 'GET' || request.method === 'HEAD') {
          if (path === '/') {
            return accept.includes('text/html')
              ? html(landingHtml())
              : text(selfLlmsTxt())
          }
          if (path === '/llms.txt') return text(selfLlmsTxt())
          if (path === '/.well-known/agents.json') return json(selfAgentsJson())
          if (path === '/icp.json') return json(selfIcpJson())
          if (path === '/openapi.json') return json(selfOpenapi())
          if (path === '/health') return json({ ok: true, verifier: 'api.qa', version: VERIFIER_VERSION })
          if (path === '/offers/attested-run') return json(selfOffer(), 402)

          const domain = path === '/self' ? 'api.qa' : DOMAIN_ROUTE.exec(path)?.[1]
          if (domain) {
            const isSelf = domain === 'api.qa'
            const bypass = isSelf // loopback self-verification is never cached / gated

            // 1. Serve a fresh cached verdict without re-probing the target.
            let staleHit: CacheHit<VerificationReport> | null = null
            if (!bypass && cache) {
              const hit = await cache.getDomain(domain, now())
              if (hit?.fresh) return respondReport(hit.report, accept, { cache: 'HIT', ageMs: hit.ageMs })
              staleHit = hit
            }

            // 2. Cross-isolate cooldown before probing a third party.
            if (!bypass && cooldown) {
              const decision = await cooldown.reserve(hostKey(domain))
              if (!decision.allowed) {
                if (staleHit)
                  return respondReport(staleHit.report, accept, {
                    cache: 'STALE',
                    ageMs: staleHit.ageMs,
                    retryAfterMs: decision.retryAfterMs,
                  })
                return cooldownResponse(decision, domain)
              }
            }

            // 3. Probe fresh, judge, attest, and cache.
            const report = await verifyTarget(`https://${domain}`, {
              mode: 'remote',
              fetcher: routed,
              delayMs: isSelf ? 0 : externalDelayMs,
              signingKeys: await keys(),
              allowPrivateTargets: env.ALLOW_PRIVATE_TARGETS === 'true',
            })
            if (!bypass && cache) await cache.putDomain(domain, report, now())
            return respondReport(report, accept, { cache: bypass ? undefined : 'MISS' })
          }
        }

        if (request.method === 'POST' && path === '/verify') {
          const body = (await request.json().catch(() => undefined)) as
            | {
                target?: string
                spec?: unknown
                specText?: string
                expectedDigest?: string
                seed?: number
              }
            | undefined
          if (!body?.target) return json({ error: 'body must include "target"' }, 400)

          const bypass = hostKey(body.target) === 'api.qa'

          const specText =
            body.specText ?? (body.spec !== undefined ? JSON.stringify(body.spec) : undefined)
          if (specText !== undefined) {
            const specDigest = await sha256Hex(specText)
            // The anti-Goodhart gate must fire on a bad pin BEFORE any cache
            // hit: a mismatched expectedDigest has to 400, never serve a
            // cached pass. Only consult the cache when the pin is consistent.
            const pinOk = !body.expectedDigest || body.expectedDigest === specDigest
            if (!bypass && cache && pinOk) {
              const hit = await cache.getPinned(body.target, specDigest, body.seed, now())
              if (hit?.fresh)
                return respondPinned(hit.report, accept, { cache: 'HIT', ageMs: hit.ageMs })
            }
            const report = await verifyPinnedSpec(body.target, specText, {
              mode: 'remote',
              fetcher: routed,
              seed: body.seed,
              expectedDigest: body.expectedDigest,
              delayMs: bypass ? 0 : externalDelayMs,
              allowPrivateTargets: env.ALLOW_PRIVATE_TARGETS === 'true',
            })
            if (!bypass && cache) await cache.putPinned(body.target, specDigest, body.seed, report, now())
            return respondPinned(report, accept, { cache: bypass ? undefined : 'MISS' })
          }

          // Domain-mode POST — same politeness as GET /{domain}.
          let staleHit: CacheHit<VerificationReport> | null = null
          if (!bypass && cache) {
            const hit = await cache.getDomain(body.target, now())
            if (hit?.fresh) return respondReport(hit.report, accept, { cache: 'HIT', ageMs: hit.ageMs })
            staleHit = hit
          }
          if (!bypass && cooldown) {
            const decision = await cooldown.reserve(hostKey(body.target))
            if (!decision.allowed) {
              if (staleHit)
                return respondReport(staleHit.report, accept, {
                  cache: 'STALE',
                  ageMs: staleHit.ageMs,
                  retryAfterMs: decision.retryAfterMs,
                })
              return cooldownResponse(decision, body.target)
            }
          }
          const report = await verifyTarget(body.target, {
            mode: 'remote',
            fetcher: routed,
            seed: body.seed,
            signingKeys: await keys(),
            allowPrivateTargets: env.ALLOW_PRIVATE_TARGETS === 'true',
          })
          if (!bypass && cache) await cache.putDomain(body.target, report, now())
          return respondReport(report, accept, { cache: bypass ? undefined : 'MISS' })
        }

        if (request.method === 'POST' && path === '/suite') {
          const body = (await request.json().catch(() => undefined)) as
            | {
                target?: string
                suite?: unknown
                suiteText?: string
                suiteDigest?: string
                environment?: string
                expectedDigest?: string
                seed?: number
              }
            | undefined
          if (!body?.environment) return json({ error: 'body must include "environment"' }, 400)

          // Resolve the suite text: supplied inline, OR a STORED suite fetched
          // by digest from the registry (the hosted "run a stored suite" path).
          let suiteText =
            body.suiteText ?? (body.suite !== undefined ? JSON.stringify(body.suite) : undefined)
          if (suiteText !== undefined && cache) {
            // Register the inline suite by its digest so it can later be run by
            // digest alone (content-addressed registry).
            await cache.putSuiteText(await sha256Hex(suiteText), suiteText)
          }
          if (suiteText === undefined && body.suiteDigest) {
            if (!cache) return json({ error: 'no suite registry configured for run-by-digest' }, 400)
            const stored = await cache.getSuiteText(body.suiteDigest)
            if (stored === null) return json({ error: `no stored suite for digest ${body.suiteDigest}` }, 404)
            suiteText = stored
          }
          if (suiteText === undefined) {
            return json({ error: 'body must include "suite"/"suiteText" or a stored "suiteDigest"' }, 400)
          }

          const suiteDigest = await sha256Hex(suiteText)
          // Resolve the target the SAME way verifySuite will (explicit override,
          // else the selected environment's baseUrl var) — needed to key the
          // per-(target, suite, env) verdict cache. parseSuite validates shape.
          let targetForKey = body.target
          if (targetForKey === undefined) {
            const suite = parseSuite(suiteText)
            const vars = suite.environments[body.environment]?.vars
            if (vars && typeof vars.baseUrl === 'string') targetForKey = vars.baseUrl
          }
          const bypass = targetForKey !== undefined && hostKey(targetForKey) === 'api.qa'

          // Anti-Goodhart gate must fire on a bad pin BEFORE any cache hit.
          const pinOk = !body.expectedDigest || body.expectedDigest === suiteDigest
          if (targetForKey !== undefined && !bypass && cache && pinOk) {
            const hit = await cache.getSuite(targetForKey, suiteDigest, body.environment, body.seed, now())
            if (hit?.fresh) return respondSuite(hit.report, accept, { cache: 'HIT', ageMs: hit.ageMs })
          }

          const report = await verifySuite(suiteText, body.environment, {
            mode: 'remote',
            fetcher: routed,
            seed: body.seed,
            expectedDigest: body.expectedDigest,
            target: body.target,
            delayMs: bypass ? 0 : externalDelayMs,
            allowPrivateTargets: env.ALLOW_PRIVATE_TARGETS === 'true',
          })
          if (!bypass && cache)
            await cache.putSuite(report.target, suiteDigest, body.environment, body.seed, report, now())
          return respondSuite(report, accept, { cache: bypass ? undefined : 'MISS' })
        }

        // --- Monitor registry (turns api.qa into a MONITOR) -----------------
        // POST /monitors {target, suiteDigest?, environment?, interval} → register
        // GET  /monitors                                               → list
        // DELETE /monitors/:id                                         → remove
        if (path === '/monitors' && request.method === 'GET') {
          if (!monitors) return json({ error: 'no monitor registry configured' }, 501)
          return json({ monitors: await monitors.listActive(now()) })
        }
        if (path === '/monitors' && request.method === 'POST') {
          if (!monitors) return json({ error: 'no monitor registry configured' }, 501)
          const body = (await request.json().catch(() => undefined)) as
            | {
                target?: string
                suiteDigest?: string
                environment?: string
                interval?: unknown
                alerts?: AlertRules
              }
            | undefined
          if (!body?.target) return json({ error: 'body must include "target"' }, 400)
          if (body.interval === undefined) return json({ error: 'body must include "interval"' }, 400)

          // SSRF belt at CONFIG time: an alert channel URL is user-configured and
          // api.qa POSTs to it — a private/metadata channel URL would make api.qa
          // an SSRF POST engine. Refuse an unsafe channel here (and re-gate before
          // every send in alerts.ts). Same private-host primitive as the target
          // gate. Nothing is registered when a channel is refused.
          if (body.alerts !== undefined) {
            const err = validateAlertRules(body.alerts, alertAllowPrivate)
            if (err) return json({ error: err }, 400)
          }

          // SSRF belt: refuse a private / IP-literal / off-scheme target at
          // REGISTRATION through the SAME gate /verify uses. A monitor must not
          // be registrable for a private/metadata host — the verify-time gate
          // (verifyTarget) is the suspenders; this is the belt.
          const normalized = normalizeTarget(
            body.target,
            env.ALLOW_PRIVATE_TARGETS === 'true',
          )
          if ('error' in normalized) return json({ error: normalized.error }, 400)

          let intervalSec: number
          try {
            intervalSec = parseIntervalSec(body.interval)
          } catch (e) {
            return json({ error: e instanceof Error ? e.message : String(e) }, 400)
          }

          // A suiteDigest must name a suite already in the registry; resolve the
          // default environment from the stored suite when none was supplied.
          let environment = body.environment
          if (body.suiteDigest !== undefined) {
            if (!cache) return json({ error: 'no suite registry configured for suiteDigest' }, 400)
            const suiteText = await cache.getSuiteText(body.suiteDigest)
            if (suiteText === null)
              return json({ error: `no stored suite for digest ${body.suiteDigest}` }, 404)
            const suite = parseSuite(suiteText)
            const envNames = Object.keys(suite.environments)
            if (environment === undefined) environment = envNames[0]
            if (environment === undefined || !Object.hasOwn(suite.environments, environment)) {
              return json(
                { error: `suite has no environment "${environment}" (defines ${envNames.map((n) => `"${n}"`).join(', ') || 'none'})` },
                400,
              )
            }
          }

          const id = monitorId(normalized.origin, body.suiteDigest, environment)

          // LOW abuse-surface bound: an open (unauthenticated) registry must
          // not grow without limit. Re-registering an EXISTING (id already
          // present) monitor is an idempotent refresh, not new growth, so it
          // never counts against the cap — only a genuinely new id does.
          const existing = await monitors.get(id)
          if (!existing) {
            const active = await monitors.listActive(now())
            if (active.length >= maxMonitors) {
              return json(
                {
                  error: `monitor registry full (${active.length}/${maxMonitors}) — refusing new registration`,
                  detail:
                    'per-principal quota + registration auth await ax-e6b.30 (402-blocked); MAX_MONITORS is a coarse interim cap, env-overridable',
                },
                429,
              )
            }
          }

          const record: MonitorRecord = {
            id,
            target: normalized.origin,
            ...(body.suiteDigest !== undefined ? { suiteDigest: body.suiteDigest } : {}),
            ...(environment !== undefined ? { environment } : {}),
            intervalSec,
            createdAt: now(),
            lastRunAt: null,
            // Due on the first tick after registration (nextDueAt <= now).
            nextDueAt: now(),
            // Idle-eviction TTL, refreshed on every (re-)registration.
            expiresAt: now() + monitorTtlMs,
            ...(body.alerts !== undefined ? { alerts: body.alerts } : {}),
          }
          await monitors.register(record)
          return json({ monitor: record }, 201)
        }
        // Time-series query (bd ax-e6b.29.2): a PURE read over stored scheduled-
        // run samples — NO re-probe at query time. Returns uptime %, latency
        // p50/p95/p99, error-rate, and grade history over a window. This is what
        // the dashboards (bd ax-e6b.29.4) consume.
        //   GET /monitors/:id/series?endpoint=&window=&from=&to=&breakdown=
        {
          const sm = /^\/monitors\/([A-Za-z0-9_.-]+)\/series$/.exec(path)
          if (sm && request.method === 'GET') {
            if (!seriesSource) return json({ error: 'no time-series store configured' }, 501)
            return json({ series: await seriesSource.query(sm[1]!, seriesOptsFromUrl(url, now())) })
          }
        }
        // GET /series?target=&endpoint=&window=&from=&to=&breakdown= — the same
        // series addressed by TARGET (resolved to its monitor id) rather than id.
        if (path === '/series' && request.method === 'GET') {
          if (!seriesSource) return json({ error: 'no time-series store configured' }, 501)
          const target = url.searchParams.get('target')
          if (!target) return json({ error: 'query must include "target" (or use /monitors/:id/series)' }, 400)
          // Same SSRF-consistent normalization the registry uses — a target that
          // could never be a monitor cannot address a series either.
          const normalized = normalizeTarget(target, env.ALLOW_PRIVATE_TARGETS === 'true')
          if ('error' in normalized) return json({ error: normalized.error }, 400)
          const suiteDigest = url.searchParams.get('suiteDigest') ?? undefined
          const environmentParam = url.searchParams.get('environment') ?? undefined
          // The id must match what REGISTRATION stored under, not just the
          // literal params: registration defaults `environment` to the
          // suite's first environment when none was given (worker.ts ~628),
          // so recomputing monitorId with an undefined environment here would
          // resolve a DIFFERENT id than the write path used, and read back an
          // empty series though data exists. Resolve by looking up the actual
          // monitor RECORD (by origin + suiteDigest [+ environment, when
          // given]) and using its STORED id — the read id always equals the
          // write id, independent of how registration resolved the default.
          let id = monitorId(normalized.origin, suiteDigest, environmentParam)
          if (monitors) {
            const match = (await monitors.list()).find(
              (m) =>
                m.target === normalized.origin &&
                m.suiteDigest === suiteDigest &&
                (environmentParam === undefined || m.environment === environmentParam),
            )
            if (match) id = match.id
          }
          return json({ series: await seriesSource.query(id, seriesOptsFromUrl(url, now())) })
        }
        {
          const m = /^\/monitors\/([A-Za-z0-9_.-]+)$/.exec(path)
          if (m && request.method === 'DELETE') {
            if (!monitors) return json({ error: 'no monitor registry configured' }, 501)
            const removed = await monitors.delete(m[1]!)
            return json({ deleted: removed, id: m[1] }, removed ? 200 : 404)
          }
          if (m && request.method === 'GET') {
            if (!monitors) return json({ error: 'no monitor registry configured' }, 501)
            const rec = await monitors.get(m[1]!)
            if (!rec) return json({ error: `no monitor ${m[1]}` }, 404)
            return json({ monitor: rec, runs: await monitors.listRuns(m[1]!) })
          }
        }

        if (request.method === 'POST' && path === '/rejudge') {
          const report = (await request.json().catch(() => undefined)) as
            | Parameters<typeof rejudge>[0]
            | undefined
          if (!report?.evidence) return json({ error: 'body must be a VerificationReport' }, 400)
          return json(await rejudge(report))
        }

        return json({ error: 'not found', see: `${SELF_ORIGIN}/llms.txt` }, 404)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        const status = /refusing|not a valid target|digest mismatch|not a PinnedSpec|not a Suite|unknown environment|Suite\.environments|Suite environment|supplies no string|cannot resolve a target/.test(message)
          ? 400
          : 500
        return json({ error: message }, status)
      }
    },

    async scheduledTick(nowMs: number = now()): Promise<TickSummary> {
      if (scheduler) {
        // Delegate the WHOLE tick to the singleton scheduler DO (bd
        // ax-e6b.29.1 MED fix). idFromName(MONITOR_SCHEDULER_SINGLETON_NAME)
        // always resolves to the SAME Durable Object instance, so every
        // isolate's scheduled() call ends up running against that ONE DO's
        // memoized App/MonitorStore — same JS object, same private
        // claimChain field — which serializes claims across isolates, not
        // just within one. The DO runs this exact tick body (runLocalTick,
        // via its own inner createApp()) — verifyTarget/verifySuite/
        // cooldown/SSRF are byte-for-byte the same path a fetch-triggered
        // run takes; no gate-skipping fork.
        const stub = scheduler.get(scheduler.idFromName(MONITOR_SCHEDULER_SINGLETON_NAME))
        const res = await stub.fetch(
          new Request(`https://monitor-scheduler.internal/tick?nowMs=${nowMs}`, { method: 'POST' }),
        )
        if (!res.ok) throw new Error(`scheduler DO tick failed: ${res.status} ${await res.text()}`)
        return (await res.json()) as TickSummary
      }
      // No scheduler DO configured (local dev / a single-instance test):
      // run the tick body directly. Same-instance overlap is still guarded
      // by MonitorStore.claimDue's private claimChain.
      return runLocalTick(nowMs)
    },
  }
  return app
}

/**
 * The singleton scheduler Durable Object (bd ax-e6b.29.1 MED fix — Option A).
 * Exactly ONE instance of this class exists globally: every isolate's
 * scheduled() call resolves the SAME id (MONITOR_SCHEDULER_SINGLETON_NAME) on
 * the MONITOR_SCHEDULER namespace and lands here. It memoizes one
 * createApp() — and therefore one MonitorStore, with its private claimChain —
 * for its own lifetime, so concurrent tick requests (same-isolate OR
 * cross-isolate) serialize through that one object: MonitorStore's existing
 * same-instance guard, just promoted to a cross-isolate scope by being routed
 * through a single DO. It reuses the SAME createApp() the fetch path uses, so
 * verifyTarget/verifySuite/cooldown/SSRF are exactly the same path a
 * fetch-triggered run takes — no gate-skipping fork.
 *
 * The env handed to the INNER createApp() has MONITOR_SCHEDULER stripped so
 * that inner App's own scheduledTick() runs the tick body (runLocalTick)
 * directly instead of looping back through this very DO via HTTP — a Durable
 * Object's env mirrors the same bindings declared for the Worker script that
 * defines it, so leaving MONITOR_SCHEDULER in place would self-recurse.
 *
 * The real Cloudflare runtime only ever constructs this class with the two
 * standard DO args (state, env); `testOpts` is a THIRD, optional parameter
 * that only test doubles pass — it forwards the same externalFetcher/
 * externalDelayMs/now test seams `createApp` already accepts, so a fake DO
 * namespace in tests can inject a network-free fetcher into the DO's inner
 * app instead of it falling back to a real, slow, non-deterministic `fetch`.
 */
export class MonitorSchedulerDO {
  private appInstance: App | undefined

  constructor(
    private readonly state: DOState,
    private readonly env: Env,
    private readonly testOpts?: { externalFetcher?: Fetcher; externalDelayMs?: number; now?: () => number },
  ) {}

  private getApp(): App {
    if (!this.appInstance) {
      const { MONITOR_SCHEDULER: _selfBinding, ...innerEnv } = this.env
      this.appInstance = createApp(innerEnv, this.testOpts)
    }
    return this.appInstance
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const nowMsParam = url.searchParams.get('nowMs')
    const nowMs = nowMsParam !== null && nowMsParam !== '' ? Number(nowMsParam) : undefined
    const summary = await this.getApp().scheduledTick(nowMs)
    return new Response(JSON.stringify(summary), { headers: { 'content-type': 'application/json' } })
  }
}

/**
 * Parse a time-series query's window/filter params off the URL into
 * SeriesQueryOpts (bd ax-e6b.29.2). `window` is a relative span ending at `now`
 * (e.g. "1h", "24h", "7d", or a bare ms number); explicit `from`/`to` (ms epoch)
 * override it. `endpoint` filters to one endpoint; `breakdown=1` adds the
 * per-endpoint breakdown.
 */
function seriesOptsFromUrl(url: URL, nowMs: number): SeriesQueryOpts {
  const q = url.searchParams
  const opts: SeriesQueryOpts = { nowMs }
  const endpoint = q.get('endpoint')
  if (endpoint) opts.endpoint = endpoint
  const from = q.get('from')
  const to = q.get('to')
  if (to !== null && to !== '' && Number.isFinite(Number(to))) opts.toMs = Number(to)
  if (from !== null && from !== '' && Number.isFinite(Number(from))) opts.fromMs = Number(from)
  const windowMs = parseWindowMs(q.get('window'))
  // A relative window sets fromMs = (toMs|now) - span when no explicit from given.
  if (opts.fromMs === undefined && windowMs !== undefined) opts.fromMs = (opts.toMs ?? nowMs) - windowMs
  const breakdown = q.get('breakdown')
  if (breakdown === '1' || breakdown === 'true') opts.breakdown = true
  return opts
}

/** "1h"/"24h"/"7d"/"30m"/"45s" or a bare ms number → ms; undefined if unset/bad. */
function parseWindowMs(raw: string | null): number | undefined {
  if (raw === null || raw.trim() === '') return undefined
  const s = raw.trim()
  const m = /^(\d+)(ms|s|m|h|d)?$/.exec(s)
  if (!m) return undefined
  const n = Number(m[1])
  switch (m[2]) {
    case undefined:
    case 'ms':
      return n
    case 's':
      return n * 1000
    case 'm':
      return n * 60_000
    case 'h':
      return n * 3_600_000
    case 'd':
      return n * 86_400_000
    default:
      return undefined
  }
}

function text(body: string, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/markdown; charset=utf-8', link: LINKSET, 'access-control-allow-origin': '*', ...extra },
  })
}

function html(body: string, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', link: LINKSET, 'access-control-allow-origin': '*', ...extra },
  })
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', link: LINKSET, 'access-control-allow-origin': '*', ...extra },
  })
}

/** Cache/politeness observability headers (x-cache, age, retry-after). */
interface CacheMeta {
  cache?: 'HIT' | 'MISS' | 'STALE'
  ageMs?: number
  retryAfterMs?: number
}
function cacheHeaders(meta?: CacheMeta): Record<string, string> {
  const h: Record<string, string> = {}
  if (meta?.cache) h['x-cache'] = meta.cache
  if (meta?.ageMs !== undefined) h['age'] = String(Math.floor(meta.ageMs / 1000))
  if (meta?.retryAfterMs !== undefined) h['retry-after'] = String(Math.ceil(meta.retryAfterMs / 1000))
  return h
}

function respondReport(report: VerificationReport, accept: string, meta?: CacheMeta): Response {
  const headers = cacheHeaders(meta)
  if (accept.includes('application/json')) return json(report, 200, headers)
  if (accept.includes('text/html')) return html(reportPageHtml(report), 200, headers)
  return text(reportMarkdown(report), 200, headers)
}

function respondPinned(report: PinnedReport, accept: string, meta?: CacheMeta): Response {
  const headers = cacheHeaders(meta)
  return accept.includes('text/markdown')
    ? text(pinnedMarkdown(report), 200, headers)
    : json(report, 200, headers)
}

function respondSuite(report: SuiteReport, accept: string, meta?: CacheMeta): Response {
  const headers = cacheHeaders(meta)
  return accept.includes('text/markdown')
    ? text(suiteMarkdown(report), 200, headers)
    : json(report, 200, headers)
}

function cooldownResponse(decision: CooldownDecision, domain: string): Response {
  return json(
    {
      error: 'per-domain cooldown active',
      domain,
      retryAfterMs: decision.retryAfterMs,
      see: `${SELF_ORIGIN}/llms.txt`,
    },
    429,
    cacheHeaders({ retryAfterMs: decision.retryAfterMs }),
  )
}

/** Structural subset of Cloudflare's `ScheduledEvent`. */
interface ScheduledEventLike {
  scheduledTime: number
  cron?: string
}
/** Structural subset of Cloudflare's `ExecutionContext`. */
interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void
}

// Cloudflare Workers module entry — fetch (on-demand grade) + scheduled (AFK
// monitor). The cron trigger in wrangler.jsonc drives scheduled(); it fires
// only once Nathan deploys (config-only here, nothing runs on its own).
export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return createApp(env).fetch(request)
  },
  async scheduled(event: ScheduledEventLike, env: Env, ctx: ExecutionContextLike): Promise<void> {
    const tick = createApp(env).scheduledTick(event.scheduledTime)
    ctx.waitUntil(tick)
    await tick
  },
}
