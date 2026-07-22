/**
 * Scheduled recurring verification (ax-e6b.29.1) — api.qa as a MONITOR.
 *
 * These tests invoke the scheduled() path DIRECTLY (via `app.scheduledTick`)
 * with a mock env + injected clock — never a real cron. They assert:
 *   - a registered {target, suiteDigest?, interval} is re-verified on a
 *     simulated tick producing a grade (+ suite verdict) with NO human trigger;
 *   - a monitor whose domain is in per-domain cooldown is SKIPPED that tick and
 *     retried the next;
 *   - a monitor for a PRIVATE / off-origin target is REFUSED at registration;
 *   - run-history records are stored + listable;
 *   - the per-tick cap defers the overflow, which runs on a later tick;
 *   - dogfood: monitoring api.qa itself + apis.directory both yield run records.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createApp, MonitorSchedulerDO, type Env } from '../src/worker.js'
import { ReportCache, MemoryKV } from '../src/cache.js'
import { MemoryCooldown, type DOState, type DOStorage, type DONamespaceLike } from '../src/cooldown.js'
import { MonitorStore, parseIntervalSec, monitorId } from '../src/monitors.js'
import { sha256Hex } from '../src/digest.js'
import { goodTargetRoutes, makeFetcher, GOOD } from './helpers.js'
import type { Fetcher } from '../src/http.js'

const SUITE_PATH = fileURLToPath(new URL('../examples/golden-scenario.suite.json', import.meta.url))
const suiteText = readFileSync(SUITE_PATH, 'utf8')
const APIS = 'https://apis.directory'

const req = (path: string, init?: RequestInit) => new Request(`https://api.qa${path}`, init)
const jsonReq = (path: string, body: unknown) =>
  req(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

/** Serve ANY host as a good.example clone (rewrite GOOD ↔ the requested origin). */
function siteFetcher(): Fetcher {
  const base = makeFetcher(goodTargetRoutes())
  return async (url, init) => {
    const u = new URL(url)
    const origin = u.origin
    const res = await base(url.replace(origin, GOOD), init)
    const body = (await res.text()).split(GOOD).join(origin)
    return new Response(body, {
      status: res.status,
      headers: { 'content-type': res.headers.get('content-type') ?? 'text/plain' },
    })
  }
}

/** apis.directory clone that ALSO serves the golden completion-ladder endpoints. */
function apisDirectoryFetcher(): Fetcher {
  const surfaces = siteFetcher()
  const jsonRes = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })
  return async (url, init) => {
    const u = new URL(url)
    const method = (init?.method ?? 'GET').toUpperCase()
    if (u.origin === APIS && method === 'POST' && u.pathname === '/golden/run') {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
        scenario?: unknown
        seed?: unknown
      }
      if (typeof body.scenario !== 'string' || body.scenario.length === 0) return jsonRes({ error: 'unknown scenario' }, 422)
      if (typeof body.seed !== 'number') return jsonRes({ error: 'seed must be a number' }, 422)
      return jsonRes({ settled: true, ledgerBalanced: true, runId: `run-${body.seed}-${body.scenario}` })
    }
    const m = /^\/golden\/run\/(.+)$/.exec(u.pathname)
    if (u.origin === APIS && method === 'GET' && m) {
      return jsonRes({ runId: decodeURIComponent(m[1]!), settled: true })
    }
    return surfaces(url, init)
  }
}

/** In-memory DO storage double — zero runtime, zero network (mirrors cooldown.test.ts). */
function fakeDOState(): DOState {
  const m = new Map<string, unknown>()
  const storage: DOStorage = {
    async get<T = unknown>(key: string) {
      return m.has(key) ? (m.get(key) as T) : undefined
    },
    async put<T = unknown>(key: string, value: T) {
      m.set(key, value)
    },
  }
  return { storage }
}

/**
 * A fake MONITOR_SCHEDULER namespace that routes idFromName(name) to ONE
 * MonitorSchedulerDO instance per name — exactly like the real runtime's
 * singleton-by-id semantics — proving cross-isolate serialization works.
 * `env` is the SAME env every "isolate" App shares (in particular the same
 * REPORTS KV), so the DO's own inner MonitorStore sees the same data.
 * `testOpts` forwards a network-free fetcher into the DO's inner app (the
 * DO only receives `env`, not `opts`, so without this it would fall back to
 * a real, slow `fetch`).
 */
function fakeSchedulerNamespace(
  env: Env,
  testOpts?: { externalFetcher?: Fetcher; externalDelayMs?: number },
): DONamespaceLike {
  const instances = new Map<string, MonitorSchedulerDO>()
  return {
    idFromName(name: string) {
      return name
    },
    get(id: unknown) {
      const key = String(id)
      if (!instances.has(key)) instances.set(key, new MonitorSchedulerDO(fakeDOState(), env, testOpts))
      return instances.get(key)!
    },
  }
}

describe('parseIntervalSec', () => {
  it('accepts seconds (number + numeric string) and an every-N-minutes cron', () => {
    expect(parseIntervalSec(300)).toBe(300)
    expect(parseIntervalSec('300')).toBe(300)
    expect(parseIntervalSec('*/5 * * * *')).toBe(300)
    expect(parseIntervalSec('*/2 * * * *')).toBe(120)
  })
  it('rejects nonsense / non-positive intervals', () => {
    expect(() => parseIntervalSec(0)).toThrow()
    expect(() => parseIntervalSec(-5)).toThrow()
    expect(() => parseIntervalSec('every minute')).toThrow()
    expect(() => parseIntervalSec('0 0 * * *')).toThrow() // not the every-N-min shape
  })
  it('rejects sub-integer/sub-floor intervals — the MED fix (would otherwise floor to 0 and run every tick)', () => {
    expect(() => parseIntervalSec(0.5)).toThrow()
    expect(() => parseIntervalSec(0)).toThrow()
    expect(() => parseIntervalSec(-1)).toThrow()
    expect(() => parseIntervalSec(30.7)).toThrow() // non-integer
    expect(() => parseIntervalSec(30)).toThrow() // integer but below the 60s floor
    expect(() => parseIntervalSec(NaN)).toThrow()
    expect(() => parseIntervalSec(Infinity)).toThrow()
    expect(() => parseIntervalSec('0.5')).toThrow() // string path: not /^\d+$/
  })
  it('accepts a valid integer interval at/above the 60s floor', () => {
    expect(parseIntervalSec(60)).toBe(60)
    expect(parseIntervalSec(300)).toBe(300)
  })
})

describe('monitor registry CRUD', () => {
  it('registers, lists, gets, and deletes a monitor', async () => {
    const cache = new ReportCache(new MemoryKV(), 300)
    const monitors = new MonitorStore(new MemoryKV())
    const app = createApp({}, { externalFetcher: siteFetcher(), externalDelayMs: 0, cache, monitors, now: () => 0 })

    const reg = await app.fetch(jsonReq('/monitors', { target: 'good.example', interval: 300 }))
    expect(reg.status).toBe(201)
    const { monitor } = (await reg.json()) as { monitor: { id: string; target: string; intervalSec: number; nextDueAt: number } }
    expect(monitor.target).toBe(GOOD)
    expect(monitor.intervalSec).toBe(300)
    expect(monitor.nextDueAt).toBe(0) // due on the first tick

    const listed = await app.fetch(req('/monitors'))
    expect(((await listed.json()) as { monitors: unknown[] }).monitors).toHaveLength(1)

    const one = await app.fetch(req(`/monitors/${monitor.id}`))
    expect(((await one.json()) as { monitor: { id: string } }).monitor.id).toBe(monitor.id)

    const del = await app.fetch(req(`/monitors/${monitor.id}`, { method: 'DELETE' }))
    expect(((await del.json()) as { deleted: boolean }).deleted).toBe(true)
    const after = await app.fetch(req('/monitors'))
    expect(((await after.json()) as { monitors: unknown[] }).monitors).toHaveLength(0)
  })

  it('re-registering the same (target,suite,env) is idempotent (content-addressed id)', async () => {
    const monitors = new MonitorStore(new MemoryKV())
    const app = createApp({}, { externalFetcher: siteFetcher(), externalDelayMs: 0, cache: new ReportCache(new MemoryKV(), 300), monitors, now: () => 0 })
    await app.fetch(jsonReq('/monitors', { target: 'good.example', interval: 300 }))
    await app.fetch(jsonReq('/monitors', { target: 'good.example', interval: 600 }))
    const listed = await app.fetch(req('/monitors'))
    expect(((await listed.json()) as { monitors: unknown[] }).monitors).toHaveLength(1)
  })
})

describe('registration SSRF gate (the belt)', () => {
  it.each([
    'http://169.254.169.254', // cloud metadata
    '10.0.0.1',
    '127.0.0.1',
    'localhost',
    '192.168.1.10',
    'internal-svc.local',
  ])('refuses to register a private/metadata/IP-literal target: %s', async (target) => {
    const monitors = new MonitorStore(new MemoryKV())
    const app = createApp({}, { externalFetcher: siteFetcher(), externalDelayMs: 0, cache: new ReportCache(new MemoryKV(), 300), monitors, now: () => 0 })
    const res = await app.fetch(jsonReq('/monitors', { target, interval: 300 }))
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toMatch(/refusing|not a valid/)
    // Nothing was registered.
    const listed = await app.fetch(req('/monitors'))
    expect(((await listed.json()) as { monitors: unknown[] }).monitors).toHaveLength(0)
  })

  it('rejects a suiteDigest that is not in the suite registry', async () => {
    const monitors = new MonitorStore(new MemoryKV())
    const app = createApp({}, { externalFetcher: siteFetcher(), externalDelayMs: 0, cache: new ReportCache(new MemoryKV(), 300), monitors, now: () => 0 })
    const res = await app.fetch(jsonReq('/monitors', { target: 'apis.directory', suiteDigest: 'deadbeef', interval: 300 }))
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: string }).error).toMatch(/no stored suite/)
  })
})

describe('registration interval floor — sub-1s/fractional/below-floor intervals refused (MED fix)', () => {
  it.each([0.5, 0, -1, 30.7, 59])('refuses interval %s with 400, registers nothing', async (interval) => {
    const monitors = new MonitorStore(new MemoryKV())
    const app = createApp(
      {},
      { externalFetcher: siteFetcher(), externalDelayMs: 0, cache: new ReportCache(new MemoryKV(), 300), monitors, now: () => 0 },
    )
    const res = await app.fetch(jsonReq('/monitors', { target: 'good.example', interval }))
    expect(res.status).toBe(400)
    const listed = await app.fetch(req('/monitors'))
    expect(((await listed.json()) as { monitors: unknown[] }).monitors).toHaveLength(0)
  })

  it('accepts a valid integer interval at/above the 60s floor with 201', async () => {
    const monitors = new MonitorStore(new MemoryKV())
    const app = createApp(
      {},
      { externalFetcher: siteFetcher(), externalDelayMs: 0, cache: new ReportCache(new MemoryKV(), 300), monitors, now: () => 0 },
    )
    const res = await app.fetch(jsonReq('/monitors', { target: 'good.example', interval: 60 }))
    expect(res.status).toBe(201)
    const { monitor } = (await res.json()) as { monitor: { intervalSec: number } }
    expect(monitor.intervalSec).toBe(60)
  })
})

describe('MAX_MONITORS cap — bounds the open (unauthenticated) registry (LOW fix)', () => {
  it('refuses a new registration beyond the cap with 429, but still allows re-registering an existing monitor', async () => {
    const monitors = new MonitorStore(new MemoryKV())
    const app = createApp(
      { MAX_MONITORS: '2' },
      { externalFetcher: siteFetcher(), externalDelayMs: 0, cache: new ReportCache(new MemoryKV(), 300), monitors, now: () => 0 },
    )
    const a = await app.fetch(jsonReq('/monitors', { target: 'a.example', interval: 300 }))
    const b = await app.fetch(jsonReq('/monitors', { target: 'b.example', interval: 300 }))
    expect(a.status).toBe(201)
    expect(b.status).toBe(201)

    const c = await app.fetch(jsonReq('/monitors', { target: 'c.example', interval: 300 }))
    expect(c.status).toBe(429)
    expect(((await c.json()) as { error: string }).error).toMatch(/registry full/)

    // Re-registering an EXISTING (id-stable) monitor is idempotent — it does
    // not grow the count, so it's allowed even while the cap is at capacity.
    const again = await app.fetch(jsonReq('/monitors', { target: 'a.example', interval: 600 }))
    expect(again.status).toBe(201)

    const listed = await app.fetch(req('/monitors'))
    expect(((await listed.json()) as { monitors: unknown[] }).monitors).toHaveLength(2)
  })
})

describe('idle-eviction TTL — an expired monitor is not run/listed (LOW fix)', () => {
  it('excludes an expired monitor from GET /monitors, skips it on the tick, and evicts it from the store', async () => {
    const monitors = new MonitorStore(new MemoryKV())
    const app = createApp(
      {},
      { externalFetcher: siteFetcher(), externalDelayMs: 0, cache: new ReportCache(new MemoryKV(), 300), monitors, now: () => 0 },
    )
    const reg = await app.fetch(jsonReq('/monitors', { target: 'good.example', interval: 300 }))
    const { monitor } = (await reg.json()) as { monitor: { id: string; expiresAt: number } }
    expect(monitor.expiresAt).toBeGreaterThan(0) // TTL set at registration

    // Simulate the TTL having elapsed (no run, no re-registration since).
    const rec = await monitors.get(monitor.id)
    await monitors.update({ ...rec!, expiresAt: -1 })

    const listed = await app.fetch(req('/monitors'))
    expect(((await listed.json()) as { monitors: unknown[] }).monitors).toHaveLength(0)

    const summary = await app.scheduledTick(1000)
    expect(summary.due).toBe(0)
    expect(summary.ran).toBe(0)
    expect(await monitors.listRuns(monitor.id)).toHaveLength(0)

    // Evicted from the underlying store entirely by the tick's housekeeping.
    expect(await monitors.get(monitor.id)).toBeNull()
  })
})

describe('scheduled tick concurrency — no double-run under overlapping ticks (MED fix)', () => {
  it('two overlapping scheduledTick() calls for one due monitor produce exactly ONE run', async () => {
    const monitors = new MonitorStore(new MemoryKV())
    const app = createApp(
      {},
      { externalFetcher: siteFetcher(), externalDelayMs: 0, cache: new ReportCache(new MemoryKV(), 300), monitors, now: () => 0 },
    )
    const reg = await app.fetch(jsonReq('/monitors', { target: 'good.example', interval: 300 }))
    const { monitor } = (await reg.json()) as { monitor: { id: string } }

    // Cloudflare does NOT guarantee non-overlapping scheduled() invocations —
    // simulate two overlapping ticks racing the same due monitor.
    const [a, b] = await Promise.all([app.scheduledTick(1000), app.scheduledTick(1000)])
    expect(a.ran + b.ran).toBe(1) // exactly one of the two actually ran it
    expect(await monitors.listRuns(monitor.id)).toHaveLength(1)

    const rec = await monitors.get(monitor.id)
    expect(rec?.nextDueAt).toBe(1000 + 300_000) // advanced exactly once, not twice
  })

  it('a normal single tick still runs a genuinely-due monitor (no over-correction)', async () => {
    const monitors = new MonitorStore(new MemoryKV())
    const app = createApp(
      {},
      { externalFetcher: siteFetcher(), externalDelayMs: 0, cache: new ReportCache(new MemoryKV(), 300), monitors, now: () => 0 },
    )
    await app.fetch(jsonReq('/monitors', { target: 'good.example', interval: 300 }))
    const summary = await app.scheduledTick(1000)
    expect(summary.ran).toBe(1)
    expect(summary.runs).toHaveLength(1)
  })
})

describe('scheduled tick cross-isolate concurrency — singleton scheduler DO (MED fix)', () => {
  it('two isolates (separate app/MonitorStore instances over one shared KV) sharing ONE scheduler DO race scheduledTick() for one due monitor -> exactly ONE run record', async () => {
    // The realistic race this reproduces 100%: two Worker ISOLATES each
    // constructing their OWN MonitorStore (own private claimChain) over the
    // SAME KV namespace — without the scheduler DO, both can read
    // nextDueAt before either writes it and both claim+run.
    const sharedKV = new MemoryKV()
    const env: Env = { REPORTS: sharedKV }
    const schedulerNs = fakeSchedulerNamespace(env, { externalFetcher: siteFetcher(), externalDelayMs: 0 })

    const appA = createApp(env, { externalFetcher: siteFetcher(), externalDelayMs: 0, scheduler: schedulerNs, now: () => 0 })
    const appB = createApp(env, { externalFetcher: siteFetcher(), externalDelayMs: 0, scheduler: schedulerNs, now: () => 0 })
    // Sanity: these really are two distinct MonitorStore instances (the
    // pre-fix race condition), sharing only the underlying KV.
    expect(appA).not.toBe(appB)

    const reg = await appA.fetch(jsonReq('/monitors', { target: 'good.example', interval: 300 }))
    expect(reg.status).toBe(201)
    const { monitor } = (await reg.json()) as { monitor: { id: string } }

    // Race two overlapping ticks, one per "isolate" — both route through the
    // SAME scheduler DO stub, which is the single serialization point.
    const [a, b] = await Promise.all([appA.scheduledTick(1000), appB.scheduledTick(1000)])
    expect(a.ran + b.ran).toBe(1) // exactly one of the two actually ran it — was 2 pre-fix

    const monitors = new MonitorStore(sharedKV)
    expect(await monitors.listRuns(monitor.id)).toHaveLength(1)
    const rec = await monitors.get(monitor.id)
    expect(rec?.nextDueAt).toBe(1000 + 300_000) // advanced exactly once, not twice
  })

  it('without a scheduler DO configured, a normal single tick still runs a genuinely-due monitor (local fallback intact)', async () => {
    const sharedKV = new MemoryKV()
    const env: Env = { REPORTS: sharedKV }
    const app = createApp(env, { externalFetcher: siteFetcher(), externalDelayMs: 0, now: () => 0 })
    await app.fetch(jsonReq('/monitors', { target: 'good.example', interval: 300 }))
    const summary = await app.scheduledTick(1000)
    expect(summary.ran).toBe(1)
    expect(summary.runs).toHaveLength(1)
  })
})

describe('scheduled tick batch isolation — one throwing monitor does not abort the batch (LOW fix)', () => {
  it('a corrupted monitor (throws in verifyTarget) first in the batch does not prevent a second healthy due monitor from running the same tick', async () => {
    const monitors = new MonitorStore(new MemoryKV())
    const app = createApp(
      {},
      { externalFetcher: siteFetcher(), externalDelayMs: 0, cache: new ReportCache(new MemoryKV(), 300), monitors, now: () => 0 },
    )

    // Register two due monitors normally (through the SSRF-gated route).
    const bad = await app.fetch(jsonReq('/monitors', { target: 'a.example', interval: 300 }))
    const good = await app.fetch(jsonReq('/monitors', { target: 'b.example', interval: 300 }))
    const badId = ((await bad.json()) as { monitor: { id: string } }).monitor.id
    const goodId = ((await good.json()) as { monitor: { id: string } }).monitor.id

    // Corrupt the FIRST monitor's stored target directly in the store (e.g. a
    // bad migration/manual edit) so verifyTarget->normalizeTarget throws for
    // it specifically — nextDueAt unchanged, so it's still the earliest-due
    // (sorted first) of the two.
    const badRec = await monitors.get(badId)
    await monitors.update({ ...badRec!, target: '127.0.0.1' })

    const summary = await app.scheduledTick(1000)
    expect(summary.due).toBe(2)
    expect(summary.errored).toBe(1) // the corrupted monitor was isolated, not fatal
    expect(summary.ran).toBe(1) // the healthy second monitor still ran THIS tick
    expect(summary.runs).toHaveLength(1)
    expect(summary.runs[0]!.monitorId).toBe(goodId)

    // The healthy monitor recorded a real run.
    expect(await monitors.listRuns(goodId)).toHaveLength(1)
    // The corrupted monitor recorded NO run (it never produced an attested
    // report) but its schedule still advanced — not stuck, not retried every
    // tick forever.
    expect(await monitors.listRuns(badId)).toHaveLength(0)
    const badAfter = await monitors.get(badId)
    expect(badAfter?.nextDueAt).toBe(1000 + 300_000)
  })
})

describe('scheduled tick — AFK re-verification', () => {
  it('re-verifies a registered {target, suiteDigest, interval} on a simulated tick: grade + suite verdict, no human trigger', async () => {
    const cache = new ReportCache(new MemoryKV(), 300)
    const monitors = new MonitorStore(new MemoryKV())
    // Seed the suite into the registry (the .28.1 content-addressed registry).
    const suiteDigest = await sha256Hex(suiteText)
    await cache.putSuiteText(suiteDigest, suiteText)

    let clock = 0
    const app = createApp({}, { externalFetcher: apisDirectoryFetcher(), externalDelayMs: 0, cache, monitors, now: () => clock })

    const reg = await app.fetch(jsonReq('/monitors', { target: 'apis.directory', suiteDigest, environment: 'staging', interval: 300 }))
    expect(reg.status).toBe(201)
    const { monitor } = (await reg.json()) as { monitor: { id: string } }

    // Fire the tick DIRECTLY — no human, no HTTP request triggered it.
    const summary = await app.scheduledTick(1000)
    expect(summary.due).toBe(1)
    expect(summary.ran).toBe(1)
    expect(summary.runs).toHaveLength(1)
    const run = summary.runs[0]!
    expect(run.monitorId).toBe(monitor.id)
    expect(run.grade).toBe('A+') // attested grade, same as a fetch-triggered run
    expect(run.suiteVerdict).toBe(true) // the golden suite passed
    expect(run.digest).toMatch(/^[0-9a-f]{64}$/)

    // The schedule advanced.
    const rec = await monitors.get(monitor.id)
    expect(rec?.lastRunAt).toBe(1000)
    expect(rec?.nextDueAt).toBe(1000 + 300_000)
  })

  it('stores run-history records that are listable via GET /monitors/:id', async () => {
    const cache = new ReportCache(new MemoryKV(), 300)
    const monitors = new MonitorStore(new MemoryKV())
    let clock = 0
    const app = createApp({}, { externalFetcher: siteFetcher(), externalDelayMs: 0, cache, monitors, now: () => clock })
    const reg = await app.fetch(jsonReq('/monitors', { target: 'good.example', interval: 60 }))
    const { monitor } = (await reg.json()) as { monitor: { id: string } }

    await app.scheduledTick(1000)
    clock = 61_000
    await app.scheduledTick(61_000)

    const got = await app.fetch(req(`/monitors/${monitor.id}`))
    const { runs } = (await got.json()) as { runs: { at: number; grade: string }[] }
    expect(runs).toHaveLength(2)
    expect(runs.map((r) => r.at)).toEqual([1000, 61_000])
    expect(runs.every((r) => r.grade === 'A+')).toBe(true)
    // The store exposes the same history directly.
    expect(await monitors.listRuns(monitor.id)).toHaveLength(2)
  })

  it('nothing runs before a monitor is due (nextDueAt in the future)', async () => {
    const monitors = new MonitorStore(new MemoryKV())
    let clock = 0
    const app = createApp({}, { externalFetcher: siteFetcher(), externalDelayMs: 0, cache: new ReportCache(new MemoryKV(), 300), monitors, now: () => clock })
    await app.fetch(jsonReq('/monitors', { target: 'good.example', interval: 300 })) // nextDueAt = 0
    // Run once so nextDueAt jumps to 300s out.
    await app.scheduledTick(0)
    // A tick shortly after is NOT yet due.
    const summary = await app.scheduledTick(1000)
    expect(summary.due).toBe(0)
    expect(summary.ran).toBe(0)
  })
})

describe('per-domain cooldown is honored on the scheduled path', () => {
  it('skips a monitor whose domain is in cooldown this tick, and retries it next tick', async () => {
    const monitors = new MonitorStore(new MemoryKV())
    let clock = 0
    const cooldown = new MemoryCooldown(60_000, () => clock)
    const app = createApp({}, { externalFetcher: siteFetcher(), externalDelayMs: 0, cache: new ReportCache(new MemoryKV(), 300), monitors, cooldown, now: () => clock })

    const reg = await app.fetch(jsonReq('/monitors', { target: 'good.example', interval: 300 }))
    const { monitor } = (await reg.json()) as { monitor: { id: string } }

    // Someone already probed good.example (the fetch path, or a prior tick) —
    // the domain is in cooldown. Reserve it to simulate that.
    await cooldown.reserve('good.example')

    const skipped = await app.scheduledTick(0)
    expect(skipped.due).toBe(1)
    expect(skipped.ran).toBe(0)
    expect(skipped.skippedCooldown).toBe(1)
    // NOT forced: the monitor is still due, nothing recorded.
    expect((await monitors.get(monitor.id))?.lastRunAt).toBeNull()
    expect(await monitors.listRuns(monitor.id)).toHaveLength(0)

    // Next tick, past the cooldown window: it runs.
    clock = 60_000
    const ran = await app.scheduledTick(60_000)
    expect(ran.ran).toBe(1)
    expect(ran.skippedCooldown).toBe(0)
    expect((await monitors.get(monitor.id))?.lastRunAt).toBe(60_000)
    expect(await monitors.listRuns(monitor.id)).toHaveLength(1)
  })
})

describe('per-tick cap + carry-over', () => {
  it('runs at most maxPerTick due monitors, deferring the rest to a later tick', async () => {
    const monitors = new MonitorStore(new MemoryKV())
    let clock = 0
    // No cooldown here — isolate the cap behavior. Three distinct-domain monitors.
    const app = createApp({}, { externalFetcher: siteFetcher(), externalDelayMs: 0, cache: new ReportCache(new MemoryKV(), 300), monitors, maxPerTick: 2, now: () => clock })
    for (const host of ['a.example', 'b.example', 'c.example']) {
      await app.fetch(jsonReq('/monitors', { target: host, interval: 300 }))
    }

    const first = await app.scheduledTick(0)
    expect(first.due).toBe(3)
    expect(first.ran).toBe(2) // capped
    expect(first.deferredOverCap).toBe(1) // one carried over

    // The two that ran advanced; the third is still due.
    const second = await app.scheduledTick(1) // 1ms later
    expect(second.ran).toBe(1) // the carried-over one
    expect(second.deferredOverCap).toBe(0)

    // All three now have exactly one run recorded.
    const all = await monitors.list()
    for (const m of all) expect(await monitors.listRuns(m.id)).toHaveLength(1)
  })
})

describe('dogfood — api.qa monitors itself + apis.directory', () => {
  it('registers both and produces a run record for each on a single tick, no human trigger', async () => {
    const cache = new ReportCache(new MemoryKV(), 300)
    const monitors = new MonitorStore(new MemoryKV())
    const app = createApp({}, { externalFetcher: apisDirectoryFetcher(), externalDelayMs: 0, cache, monitors, now: () => 0 })

    const self = await app.fetch(jsonReq('/monitors', { target: 'api.qa', interval: 300 }))
    expect(self.status).toBe(201)
    const dir = await app.fetch(jsonReq('/monitors', { target: 'apis.directory', interval: 300 }))
    expect(dir.status).toBe(201)
    const selfId = ((await self.json()) as { monitor: { id: string } }).monitor.id
    const dirId = ((await dir.json()) as { monitor: { id: string } }).monitor.id
    expect(selfId).toBe(monitorId('https://api.qa'))
    expect(dirId).toBe(monitorId(APIS))

    const summary = await app.scheduledTick(1000)
    expect(summary.due).toBe(2)
    expect(summary.ran).toBe(2)

    // Each produced a run record with a real grade.
    const selfRuns = await monitors.listRuns(selfId)
    const dirRuns = await monitors.listRuns(dirId)
    expect(selfRuns).toHaveLength(1)
    expect(dirRuns).toHaveLength(1)
    expect(selfRuns[0]!.grade).toBe('A+') // api.qa's loopback self-grade
    expect(dirRuns[0]!.grade).toBe('A+')
    expect(dirRuns[0]!.digest).toMatch(/^[0-9a-f]{64}$/)
  })
})
