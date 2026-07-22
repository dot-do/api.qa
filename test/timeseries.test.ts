/**
 * Time-series store + query (bd ax-e6b.29.2) — the queryable HISTORY of every
 * scheduled run, per API (target) AND per endpoint.
 *
 * Two layers, mirroring the estate's "pure judge tested separately from the
 * network path" split:
 *   1. PURE store/query unit tests over hand-crafted samples — exact percentiles,
 *      uptime %, error-rate, grade history, window filter, per-endpoint breakdown,
 *      retention/rollup, and determinism (same stored data → same result).
 *   2. INTEGRATION: drive scheduledTick() over N ticks with a mock clock + a
 *      toggleable (up/down) in-memory fetcher, then read the series back through
 *      the GET /monitors/:id/series query endpoint — proving points are WRITTEN
 *      per target + per endpoint from the SSRF-gated verify path and the query is
 *      a pure read (no re-probe).
 */

import { describe, it, expect } from 'vitest'
import { createApp } from '../src/worker.js'
import { ReportCache, MemoryKV } from '../src/cache.js'
import { MonitorStore, monitorId } from '../src/monitors.js'
import { sha256Hex } from '../src/digest.js'
import {
  TimeseriesStore,
  percentile,
  seriesPointsFromReport,
  type SeriesPoint,
  type SeriesQueryResult,
} from '../src/timeseries.js'
import { goodTargetRoutes, makeFetcher, GOOD } from './helpers.js'
import type { Fetcher } from '../src/http.js'
import type { Evidence, VerificationReport } from '../src/types.js'

type Sample = Omit<SeriesPoint, 'freshness'>

const T = 'https://good.example'
/** A target-level sample (endpoint absent). */
function tp(at: number, over: Partial<Sample> = {}): Sample {
  return { at, target: T, up: true, latencyMs: 0, errorRate: 0, grade: 'A+', ...over }
}
/** An endpoint sample. */
function ep(at: number, endpoint: string, over: Partial<Sample> = {}): Sample {
  return { at, target: T, endpoint, up: true, latencyMs: 0, errorRate: 0, grade: 'A+', ...over }
}

const req = (path: string, init?: RequestInit) => new Request(`https://api.qa${path}`, init)
const jsonReq = (path: string, body: unknown) =>
  req(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

/** One observed same-origin probe, for hand-built seriesPointsFromReport fixtures. */
function probe(method: string, path: string, elapsedMs: number, status = 200): Evidence {
  return {
    role: 'probe:test',
    url: `${T}${path}`,
    method,
    status,
    contentType: 'application/json',
    headers: {},
    body: null,
    elapsedMs,
  }
}

/** Minimal VerificationReport fixture: only the fields seriesPointsFromReport reads. */
function fakeReport(items: Evidence[], grade = 'A+'): VerificationReport {
  return {
    target: T,
    grade,
    evidence: { target: T, fetchedAt: new Date(0).toISOString(), seed: 1, items },
  } as unknown as VerificationReport
}

describe('percentile (pure, nearest-rank)', () => {
  it('computes nearest-rank p50/p95/p99 deterministically', () => {
    const xs = Array.from({ length: 100 }, (_, i) => i + 1) // 1..100 ascending
    expect(percentile(xs, 50)).toBe(50)
    expect(percentile(xs, 95)).toBe(95)
    expect(percentile(xs, 99)).toBe(99)
    expect(percentile(xs, 100)).toBe(100)
    expect(percentile([], 50)).toBe(0)
    expect(percentile([42], 99)).toBe(42)
  })
})

describe('TimeseriesStore.query — latency percentiles', () => {
  it('computes p50/p95/p99 from the raw points in the window', async () => {
    const store = new TimeseriesStore(new MemoryKV())
    const id = 'series-a'
    // 100 target-level samples with latencies 1..100 at distinct times.
    await store.record(id, Array.from({ length: 100 }, (_, i) => tp(i * 1000, { latencyMs: i + 1 })))

    const res = await store.query(id, { nowMs: 200_000 })
    expect(res.latencyMs.count).toBe(100)
    expect(res.latencyMs.p50).toBe(50)
    expect(res.latencyMs.p95).toBe(95)
    expect(res.latencyMs.p99).toBe(99)
  })
})

describe('TimeseriesStore.query — uptime %, error-rate, grade history', () => {
  it('uptime % reflects up/down samples; error-rate is the mean; grade history + histogram present', async () => {
    const store = new TimeseriesStore(new MemoryKV())
    const id = 'series-b'
    // 7 up, 3 down = 70% uptime.
    const samples: Sample[] = []
    for (let i = 0; i < 7; i++) samples.push(tp(i * 1000, { up: true, errorRate: 0, grade: 'A+' }))
    for (let i = 7; i < 10; i++) samples.push(tp(i * 1000, { up: false, errorRate: 1, grade: 'F' }))
    await store.record(id, samples)

    const res = await store.query(id, { nowMs: 100_000 })
    expect(res.count).toBe(10)
    expect(res.uptimePct).toBe(70)
    expect(res.errorRate).toBeCloseTo(0.3, 10)
    expect(res.grades).toEqual({ 'A+': 7, F: 3 })
    expect(res.gradeHistory).toHaveLength(10)
    expect(res.gradeHistory[0]).toEqual({ at: 0, grade: 'A+' })
    expect(res.gradeHistory[9]).toEqual({ at: 9000, grade: 'F' })
  })
})

describe('TimeseriesStore.query — window filter', () => {
  it('returns only samples within [from, to]', async () => {
    const store = new TimeseriesStore(new MemoryKV())
    const id = 'series-c'
    await store.record(id, [0, 100, 200, 300, 400].map((at) => tp(at, { latencyMs: at })))

    const res = await store.query(id, { fromMs: 150, toMs: 350 })
    expect(res.count).toBe(2) // 200 and 300
    expect(res.points.map((p) => p.at)).toEqual([200, 300])
    expect(res.window).toEqual({ fromMs: 150, toMs: 350 })
  })

  it('a relative window is applied by the caller via fromMs = now - span', async () => {
    const store = new TimeseriesStore(new MemoryKV())
    const id = 'series-c2'
    await store.record(id, [0, 1000, 2000, 3000].map((at) => tp(at)))
    // Last 1500ms ending at 3000.
    const res = await store.query(id, { fromMs: 1500, toMs: 3000 })
    expect(res.points.map((p) => p.at)).toEqual([2000, 3000])
  })
})

describe('TimeseriesStore.query — per-endpoint breakdown', () => {
  it('keeps target-level and per-endpoint series distinct and breaks them down', async () => {
    const store = new TimeseriesStore(new MemoryKV())
    const id = 'series-d'
    // One run: target-level + two endpoints, endpoint A down, endpoint B up.
    await store.record(id, [
      tp(1000, { up: true, errorRate: 0.5 }),
      ep(1000, 'GET /a', { up: false, errorRate: 1, latencyMs: 10 }),
      ep(1000, 'GET /b', { up: true, errorRate: 0, latencyMs: 20 }),
    ])
    // A second run, both endpoints up.
    await store.record(id, [
      tp(2000, { up: true, errorRate: 0 }),
      ep(2000, 'GET /a', { up: true, errorRate: 0, latencyMs: 12 }),
      ep(2000, 'GET /b', { up: true, errorRate: 0, latencyMs: 22 }),
    ])

    // Target-level: only the two target samples.
    const overall = await store.query(id, { nowMs: 3000, breakdown: true })
    expect(overall.count).toBe(2)
    expect(overall.uptimePct).toBe(100)
    expect(overall.perEndpoint).toBeDefined()
    expect(overall.perEndpoint!.map((e) => e.endpoint)).toEqual(['GET /a', 'GET /b'])

    const a = overall.perEndpoint!.find((e) => e.endpoint === 'GET /a')!
    expect(a.count).toBe(2)
    expect(a.uptimePct).toBe(50) // down then up
    const b = overall.perEndpoint!.find((e) => e.endpoint === 'GET /b')!
    expect(b.uptimePct).toBe(100)

    // Direct endpoint query matches the breakdown entry.
    const aDirect = await store.query(id, { endpoint: 'GET /a', nowMs: 3000 })
    expect(aDirect.uptimePct).toBe(50)
    expect(aDirect.latencyMs.p50).toBe(10) // nearest-rank p50 of [10,12] = 10
    expect(aDirect.latencyMs.p99).toBe(12)
  })
})

describe('seriesPointsFromReport — target latency is probe-weighted (LOW fix)', () => {
  it('endpoint A: 1 probe@100ms, endpoint B: 3 probes@0ms → target latency = 25ms (probe-weighted), not 50ms (endpoint-mean)', () => {
    const report = fakeReport([
      probe('GET', '/a', 100),
      probe('GET', '/b', 0),
      probe('GET', '/b', 0),
      probe('GET', '/b', 0),
    ])
    const points = seriesPointsFromReport(report, 1000)
    const target = points.find((p) => p.endpoint === undefined)!
    expect(target.latencyMs).toBe(25) // (100+0+0+0)/4, NOT (100+0)/2 = 50

    // Per-endpoint breakdown is unchanged: each endpoint's own mean.
    const a = points.find((p) => p.endpoint === 'GET /a')!
    const b = points.find((p) => p.endpoint === 'GET /b')!
    expect(a.latencyMs).toBe(100)
    expect(b.latencyMs).toBe(0)
  })
})

describe('TimeseriesStore — freshness', () => {
  it('records the gap since the previous sample of the same series (0 for the first)', async () => {
    const store = new TimeseriesStore(new MemoryKV())
    const id = 'series-fresh'
    await store.record(id, [tp(1000)])
    await store.record(id, [tp(4000)])
    const res = await store.query(id, { nowMs: 5000 })
    expect(res.points.map((p) => p.freshness)).toEqual([0, 3000])
  })
})

describe('TimeseriesStore — retention: raw ring + hourly rollup of evicted points', () => {
  it('bounds the raw ring and folds overflow into rollup buckets; a full-window query still counts evicted history', async () => {
    const store = new TimeseriesStore(new MemoryKV(), { rawCap: 5, rollupCap: 100 })
    const id = 'series-ret'
    // 8 target-level samples, one per hour, 6 up + 2 down.
    const HOUR = 3_600_000
    const samples: Sample[] = []
    for (let i = 0; i < 8; i++) samples.push(tp(i * HOUR, { up: i < 6, errorRate: i < 6 ? 0 : 1, latencyMs: 10 }))
    for (const s of samples) await store.record(id, [s]) // one at a time to exercise incremental eviction

    // Full-window query still sees all 8 (5 raw + 3 rolled up).
    const res = await store.query(id, { fromMs: 0, toMs: 8 * HOUR })
    expect(res.count).toBe(8)
    expect(res.uptimePct).toBe(75) // 6/8
    // Only the 5 most-recent raw points remain full-resolution (percentile source).
    expect(res.latencyMs.count).toBe(5)
    // Grade histogram spans evicted + raw.
    const totalGrades = Object.values(res.grades).reduce((a, b) => a + b, 0)
    expect(totalGrades).toBe(8)
  })
})

describe('TimeseriesStore.query — determinism', () => {
  it('same stored data → identical query result', async () => {
    const store = new TimeseriesStore(new MemoryKV())
    const id = 'series-det'
    await store.record(id, [0, 1000, 2000].map((at) => tp(at, { latencyMs: at / 100 })))
    const a = await store.query(id, { nowMs: 3000, breakdown: true })
    const b = await store.query(id, { nowMs: 3000, breakdown: true })
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('store.query(id, {}) — omitting nowMs/toMs entirely — is still clock-independent: identical results over identical stored data', async () => {
    const store = new TimeseriesStore(new MemoryKV())
    const id = 'series-det-noargs'
    await store.record(id, [0, 1000, 2000].map((at) => tp(at, { latencyMs: at / 100 })))
    const a = await store.query(id, {})
    const b = await store.query(id, {})
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    // The default window end is DATA-DRIVEN (the latest stored point), not
    // wall-clock — so it deterministically includes every stored point, and
    // the resolved window.toMs is pinned to that stored point, not "now".
    expect(a.count).toBe(3)
    expect(a.points.map((p) => p.at)).toEqual([0, 1000, 2000])
    expect(a.window.toMs).toBe(2000)
  })
})

describe('TimeseriesStore.query — rollup window boundary (HIGH fix)', () => {
  it('a window entirely INSIDE hour0 does not fold in a rollup bucket that STARTS after the window end', async () => {
    // rawCap=1 forces immediate eviction-to-rollup as each new point arrives,
    // exactly reproducing the reported scenario.
    const store = new TimeseriesStore(new MemoryKV(), { rawCap: 1 })
    const id = 'series-bound'
    const HOUR = 3_600_000
    // hour0: UP. hour1: DOWN/F. hour2: UP. Recorded one at a time so hour0
    // and hour1 both get evicted to rollup buckets, leaving hour2 as the
    // sole raw point.
    await store.record(id, [tp(0, { up: true, grade: 'A+' })])
    await store.record(id, [tp(HOUR, { up: false, grade: 'F', errorRate: 1 })])
    await store.record(id, [tp(2 * HOUR, { up: true, grade: 'A+' })])

    // Window is entirely inside hour0 — must NOT see hour1's DOWN bucket
    // (hourStart = HOUR), which starts a full hour after the window end.
    const res = await store.query(id, { fromMs: 0, toMs: 1 })
    expect(res.count).toBe(1)
    expect(res.uptimePct).toBe(100)
  })

  it('companion: a window that GENUINELY spans hour0 and hour1 still counts both buckets', async () => {
    const store = new TimeseriesStore(new MemoryKV(), { rawCap: 1 })
    const id = 'series-bound-span'
    const HOUR = 3_600_000
    await store.record(id, [tp(0, { up: true, grade: 'A+' })])
    await store.record(id, [tp(HOUR, { up: false, grade: 'F', errorRate: 1 })])
    await store.record(id, [tp(2 * HOUR, { up: true, grade: 'A+' })])

    // Window runs from hour0 into the middle of hour1 (well short of hour2's
    // raw point at 2*HOUR) — a genuine two-bucket span.
    const res = await store.query(id, { fromMs: 0, toMs: HOUR + HOUR / 2 })
    expect(res.count).toBe(2)
    expect(res.uptimePct).toBe(50)
  })
})

// ---------------------------------------------------------------------------
// Integration: scheduledTick writes the series; the query endpoint reads it.
// ---------------------------------------------------------------------------

/** A good.example fetcher that can be toggled to a total 5xx outage. */
function toggleableFetcher(): { fetcher: Fetcher; setDown: (d: boolean) => void } {
  const base = makeFetcher(goodTargetRoutes())
  let down = false
  const fetcher: Fetcher = async (url, init) => {
    if (down)
      return new Response(JSON.stringify({ error: 'outage' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      })
    return base(url, init)
  }
  return { fetcher, setDown: (d) => { down = d } }
}

describe('integration — scheduledTick writes a per-target + per-endpoint series, /series reads it', () => {
  it('N ticks (some up, some down) yield a queryable series: uptime %, percentiles, error-rate, grade history, per-endpoint, window filter', async () => {
    const cache = new ReportCache(new MemoryKV(), 300)
    const monitors = new MonitorStore(new MemoryKV())
    const timeseries = new TimeseriesStore(new MemoryKV())
    const { fetcher, setDown } = toggleableFetcher()
    let clock = 0
    const app = createApp(
      {},
      { externalFetcher: fetcher, externalDelayMs: 0, cache, monitors, timeseries, now: () => clock },
    )

    const reg = await app.fetch(jsonReq('/monitors', { target: 'good.example', interval: 60 }))
    expect(reg.status).toBe(201)
    const { monitor } = (await reg.json()) as { monitor: { id: string } }
    expect(monitor.id).toBe(monitorId(GOOD))

    // 5 ticks: down on ticks index 1 and 3 → 3 up, 2 down = 60% uptime.
    const tickTimes: number[] = []
    for (let i = 0; i < 5; i++) {
      clock = i * 61_000
      setDown(i === 1 || i === 3)
      const summary = await app.scheduledTick(clock)
      expect(summary.ran).toBe(1)
      tickTimes.push(clock)
    }

    // Read the series back through the PURE query endpoint (no re-probe).
    const got = await app.fetch(req(`/monitors/${monitor.id}/series?breakdown=1`))
    expect(got.status).toBe(200)
    const { series } = (await got.json()) as { series: SeriesQueryResult }

    // Target-level: one sample per tick.
    expect(series.count).toBe(5)
    expect(series.uptimePct).toBe(60)
    expect(series.gradeHistory).toHaveLength(5)
    // Down ticks graded F; up ticks a real grade.
    const downGrades = series.gradeHistory.filter((g) => g.grade === 'F')
    expect(downGrades).toHaveLength(2)
    // Percentiles present and ordered.
    expect(series.latencyMs.count).toBe(5)
    expect(series.latencyMs.p50).toBeLessThanOrEqual(series.latencyMs.p95)
    expect(series.latencyMs.p95).toBeLessThanOrEqual(series.latencyMs.p99)
    // Error-rate is a real fraction between the healthy and outage extremes.
    expect(series.errorRate).toBeGreaterThan(0)
    expect(series.errorRate).toBeLessThanOrEqual(1)

    // Per-endpoint breakdown: good.example exposes several same-origin surfaces.
    expect(series.perEndpoint).toBeDefined()
    expect(series.perEndpoint!.length).toBeGreaterThan(1)
    // /llms.txt is fetched on every run — present as an endpoint series.
    const llms = series.perEndpoint!.find((e) => e.endpoint === 'GET /llms.txt')
    expect(llms).toBeDefined()
    expect(llms!.count).toBe(5)

    // Window filter: restrict to the last two ticks only.
    const windowed = await app.fetch(
      req(`/monitors/${monitor.id}/series?from=${tickTimes[3]}&to=${tickTimes[4]}`),
    )
    const { series: sub } = (await windowed.json()) as { series: SeriesQueryResult }
    expect(sub.count).toBe(2)
    expect(sub.points.map((p) => p.at)).toEqual([tickTimes[3], tickTimes[4]])
  })

  it('GET /series?target= resolves the same series by target, and is a pure read (no fetch at query time)', async () => {
    const cache = new ReportCache(new MemoryKV(), 300)
    const monitors = new MonitorStore(new MemoryKV())
    const timeseries = new TimeseriesStore(new MemoryKV())
    const base = makeFetcher(goodTargetRoutes())
    let fetches = 0
    const counting: Fetcher = (url, init) => { fetches++; return base(url, init) }
    let clock = 0
    const app = createApp(
      {},
      { externalFetcher: counting, externalDelayMs: 0, cache, monitors, timeseries, now: () => clock },
    )
    await app.fetch(jsonReq('/monitors', { target: 'good.example', interval: 60 }))
    clock = 1000
    await app.scheduledTick(1000)
    const afterTick = fetches
    expect(afterTick).toBeGreaterThan(0)

    const got = await app.fetch(req('/series?target=good.example'))
    expect(got.status).toBe(200)
    const { series } = (await got.json()) as { series: SeriesQueryResult }
    expect(series.target).toBe(GOOD)
    expect(series.count).toBe(1)
    // The query performed NO additional fetches — pure read over stored data.
    expect(fetches).toBe(afterTick)
  })

  it('GET /series?target=&suiteDigest= (no environment) resolves the SAME id registration defaulted to (MED fix)', async () => {
    const cache = new ReportCache(new MemoryKV(), 300)
    const monitors = new MonitorStore(new MemoryKV())
    const timeseries = new TimeseriesStore(new MemoryKV())
    let clock = 0
    const app = createApp(
      {},
      { externalFetcher: makeFetcher(goodTargetRoutes()), externalDelayMs: 0, cache, monitors, timeseries, now: () => clock },
    )

    // A single-environment suite, so registration WITHOUT an explicit
    // `environment` defaults it to that one env (worker.ts ~628).
    const suite = {
      $type: 'Suite',
      name: 'single-env',
      version: '1',
      environments: { only: { vars: { baseUrl: GOOD } } },
      requirements: [
        { id: 'llms', kind: 'endpoint', method: 'GET', path: '/llms.txt', expect: { status: 200 } },
      ],
    }
    const suiteText = JSON.stringify(suite)
    const suiteDigest = await sha256Hex(suiteText)
    await cache.putSuiteText(suiteDigest, suiteText)

    // Register WITHOUT an environment — the write path defaults it.
    const reg = await app.fetch(jsonReq('/monitors', { target: 'good.example', suiteDigest, interval: 60 }))
    expect(reg.status).toBe(201)
    const { monitor } = (await reg.json()) as { monitor: { id: string; environment?: string } }
    expect(monitor.environment).toBe('only')

    clock = 1000
    const summary = await app.scheduledTick(1000)
    expect(summary.ran).toBe(1)

    // Read back WITHOUT an environment param — before the fix this computed
    // monitorId(origin, suiteDigest, undefined), a DIFFERENT id than the
    // registration's defaulted-environment id, and returned an empty series.
    const got = await app.fetch(req(`/series?target=good.example&suiteDigest=${suiteDigest}`))
    expect(got.status).toBe(200)
    const { series } = (await got.json()) as { series: SeriesQueryResult }
    expect(series.count).toBe(1)
    expect(series.points).toHaveLength(1)

    // And it resolves to the SAME id /monitors/:id/series would use directly.
    const direct = await app.fetch(req(`/monitors/${monitor.id}/series`))
    const { series: directSeries } = (await direct.json()) as { series: SeriesQueryResult }
    expect(directSeries.count).toBe(series.count)
  })

  it('refuses a private/IP-literal target on /series (same SSRF-consistent gate as the registry)', async () => {
    const app = createApp(
      {},
      { externalFetcher: makeFetcher(goodTargetRoutes()), externalDelayMs: 0, cache: new ReportCache(new MemoryKV(), 300), monitors: new MonitorStore(new MemoryKV()), timeseries: new TimeseriesStore(new MemoryKV()), now: () => 0 },
    )
    const res = await app.fetch(req('/series?target=127.0.0.1'))
    expect(res.status).toBe(400)
  })
})
