import { describe, it, expect } from 'vitest'
import { createApp } from '../src/worker.js'
import { ReportCache, MemoryKV } from '../src/cache.js'
import { MemoryCooldown } from '../src/cooldown.js'
import { goodTargetRoutes, makeFetcher, GOOD } from './helpers.js'
import type { Fetcher } from '../src/http.js'

/** Wrap a fetcher to count how many times the target origin is actually hit. */
function counting(inner: Fetcher): { fetcher: Fetcher; count: () => number } {
  let n = 0
  const fetcher: Fetcher = (url, init) => {
    if (url.startsWith(GOOD)) n += 1
    return inner(url, init)
  }
  return { fetcher, count: () => n }
}

const req = (path: string, init?: RequestInit) => new Request(`https://api.qa${path}`, init)

describe('worker: KV report cache', () => {
  it('a fresh cache HIT serves the verdict without re-probing the target', async () => {
    const probe = counting(makeFetcher(goodTargetRoutes()))
    let clock = 0
    const app = createApp(
      {},
      {
        externalFetcher: probe.fetcher,
        externalDelayMs: 0,
        cache: new ReportCache(new MemoryKV(), 300),
        now: () => clock,
      },
    )

    const miss = await app.fetch(req('/good.example', { headers: { accept: 'application/json' } }))
    expect(miss.headers.get('x-cache')).toBe('MISS')
    const probesAfterMiss = probe.count()
    expect(probesAfterMiss).toBeGreaterThan(5)

    // Second request inside the TTL window: HIT, zero additional probes.
    clock = 1000
    const hit = await app.fetch(req('/good.example', { headers: { accept: 'application/json' } }))
    expect(hit.headers.get('x-cache')).toBe('HIT')
    expect(hit.headers.get('age')).toBe('1') // 1000ms → 1s
    expect(probe.count()).toBe(probesAfterMiss) // NOT re-probed
    const report = (await hit.json()) as { grade: string; attested: boolean }
    expect(report.grade).toBe('A+')
    expect(report.attested).toBe(true)
  })

  it('re-probes once the cached verdict is stale (TTL elapsed)', async () => {
    const probe = counting(makeFetcher(goodTargetRoutes()))
    let clock = 0
    const app = createApp(
      {},
      { externalFetcher: probe.fetcher, externalDelayMs: 0, cache: new ReportCache(new MemoryKV(), 60), now: () => clock },
    )
    await app.fetch(req('/good.example'))
    const afterFirst = probe.count()
    clock = 61_000 // past the 60s window
    const res = await app.fetch(req('/good.example'))
    expect(res.headers.get('x-cache')).toBe('MISS')
    expect(probe.count()).toBeGreaterThan(afterFirst) // re-probed
  })

  it('caches pinned-spec verdicts by domain+specDigest', async () => {
    const probe = counting(makeFetcher(goodTargetRoutes()))
    const app = createApp(
      {},
      { externalFetcher: probe.fetcher, externalDelayMs: 0, cache: new ReportCache(new MemoryKV(), 300), now: () => 0 },
    )
    const spec = {
      $type: 'PinnedSpec', name: 'mini', version: '1',
      requirements: [{ id: 'status-ok', kind: 'endpoint', method: 'GET', path: '/api/status', expect: { status: 200 } }],
    }
    const body = JSON.stringify({ target: GOOD, spec, seed: 1 })
    const post = () =>
      app.fetch(req('/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body }))

    const miss = await post()
    expect(miss.headers.get('x-cache')).toBe('MISS')
    const afterFirst = probe.count()
    const hit = await post()
    expect(hit.headers.get('x-cache')).toBe('HIT')
    expect(probe.count()).toBe(afterFirst) // served from cache, no re-probe
    expect(((await hit.json()) as { passed: boolean }).passed).toBe(true)
  })

  it('a different seed on POST /verify re-runs instead of serving the first seed\'s cached (now-stale) report', async () => {
    const probe = counting(makeFetcher(goodTargetRoutes()))
    const app = createApp(
      {},
      { externalFetcher: probe.fetcher, externalDelayMs: 0, cache: new ReportCache(new MemoryKV(), 300), now: () => 0 },
    )
    const spec = {
      $type: 'PinnedSpec', name: 'mini', version: '1',
      requirements: [{ id: 'status-ok', kind: 'endpoint', method: 'GET', path: '/api/status', expect: { status: 200 } }],
    }
    const post = (seed: number) =>
      app.fetch(req('/verify', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ target: GOOD, spec, seed }),
      }))

    const first = await post(1)
    expect(first.headers.get('x-cache')).toBe('MISS')
    const firstReport = (await first.json()) as { seed: number }
    expect(firstReport.seed).toBe(1)
    const afterFirst = probe.count()

    // Same target/spec digest, a DIFFERENT requested seed: must re-run (never
    // serve the seed=1 report — that would misreport the run's own seed).
    const second = await post(2)
    expect(second.headers.get('x-cache')).toBe('MISS')
    expect(probe.count()).toBeGreaterThan(afterFirst) // actually re-probed
    const secondReport = (await second.json()) as { seed: number }
    expect(secondReport.seed).toBe(2) // truthfully reports the seed it ran under

    // The ORIGINAL seed is still served from cache, unaffected.
    const afterSecond = probe.count()
    const replay = await post(1)
    expect(replay.headers.get('x-cache')).toBe('HIT')
    expect(probe.count()).toBe(afterSecond)
    expect(((await replay.json()) as { seed: number }).seed).toBe(1)
  })

  it('a wrong expectedDigest still 400s even with a cached pass present', async () => {
    const cache = new ReportCache(new MemoryKV(), 300)
    const app = createApp(
      {},
      { externalFetcher: makeFetcher(goodTargetRoutes()), externalDelayMs: 0, cache, now: () => 0 },
    )
    const spec = {
      $type: 'PinnedSpec', name: 'mini', version: '1',
      requirements: [{ id: 'status-ok', kind: 'endpoint', method: 'GET', path: '/api/status', expect: { status: 200 } }],
    }
    // Warm the cache with a legitimate pass.
    await app.fetch(req('/verify', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: GOOD, spec, seed: 1 }),
    }))
    // Same spec text (same digest) but a bogus pin must NOT be served from cache.
    const bad = await app.fetch(req('/verify', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: GOOD, spec, expectedDigest: 'deadbeef' }),
    }))
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as { error: string }).error).toMatch(/digest mismatch/)
  })

  it('attested POST /verify without an out-of-band pin REFUSES even with a warm cache present (ax-7x3)', async () => {
    const cache = new ReportCache(new MemoryKV(), 300)
    const app = createApp(
      {},
      { externalFetcher: makeFetcher(goodTargetRoutes()), externalDelayMs: 0, cache, now: () => 0 },
    )
    const spec = {
      $type: 'PinnedSpec', name: 'mini', version: '1',
      requirements: [{ id: 'status-ok', kind: 'endpoint', method: 'GET', path: '/api/status', expect: { status: 200 } }],
    }
    // Warm the cache with a legitimate (non-attested) pass so a cache HIT is
    // available for this target+specDigest+seed.
    const warm = await app.fetch(req('/verify', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: GOOD, spec, seed: 1 }),
    }))
    expect(warm.headers.get('x-cache')).toBe('MISS')
    // Attested admission with the pin OMITTED must fail closed BEFORE the cache
    // read — a warm cache must NOT let the guard be bypassed.
    const attestedNoPin = await app.fetch(req('/verify', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: GOOD, spec, seed: 1, attested: true }),
    }))
    expect(attestedNoPin.status).toBe(400)
    expect(((await attestedNoPin.json()) as { error: string }).error).toMatch(/externally-supplied expectedDigest/)
    expect(attestedNoPin.headers.get('x-cache')).not.toBe('HIT')
  })

  it('attested POST /suite without an out-of-band pin REFUSES even with a warm cache present (ax-7x3)', async () => {
    const cache = new ReportCache(new MemoryKV(), 300)
    const app = createApp(
      {},
      { externalFetcher: makeFetcher(goodTargetRoutes()), externalDelayMs: 0, cache, now: () => 0 },
    )
    const suite = {
      $type: 'Suite', name: 'mini-suite', version: '1',
      environments: { prod: { vars: { baseUrl: GOOD } } },
      requirements: [{ id: 'status-ok', kind: 'endpoint', method: 'GET', path: '/api/status', expect: { status: 200 } }],
    }
    // Warm the suite cache with a legitimate (non-attested) pass.
    const warm = await app.fetch(req('/suite', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: GOOD, suite, environment: 'prod', seed: 1 }),
    }))
    expect(warm.headers.get('x-cache')).toBe('MISS')
    const attestedNoPin = await app.fetch(req('/suite', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: GOOD, suite, environment: 'prod', seed: 1, attested: true }),
    }))
    expect(attestedNoPin.status).toBe(400)
    expect(((await attestedNoPin.json()) as { error: string }).error).toMatch(/externally-supplied expectedDigest/)
    expect(attestedNoPin.headers.get('x-cache')).not.toBe('HIT')
  })
})

describe('worker: per-domain cooldown', () => {
  it('serves a stale cached verdict during cooldown instead of re-probing', async () => {
    const probe = counting(makeFetcher(goodTargetRoutes()))
    let clock = 0
    const cache = new ReportCache(new MemoryKV(), 30) // 30s freshness
    const cooldown = new MemoryCooldown(60_000, () => clock) // 60s politeness
    const app = createApp({}, { externalFetcher: probe.fetcher, externalDelayMs: 0, cache, cooldown, now: () => clock })

    await app.fetch(req('/good.example')) // MISS: probes + reserves cooldown
    const afterFirst = probe.count()

    // 45s later: cache is stale (>30s) but cooldown (60s) is still active.
    clock = 45_000
    const res = await app.fetch(req('/good.example', { headers: { accept: 'application/json' } }))
    expect(res.headers.get('x-cache')).toBe('STALE')
    expect(res.headers.get('retry-after')).toBe('15') // 60-45 = 15s
    expect(probe.count()).toBe(afterFirst) // did NOT re-probe the third party
  })

  it('429s a cold domain that is in cooldown with no cached fallback', async () => {
    let clock = 0
    const cooldown = new MemoryCooldown(60_000, () => clock)
    // No cache: prove the cooldown gate alone stops a probe-cannon.
    const probe = counting(makeFetcher(goodTargetRoutes()))
    const app = createApp({}, { externalFetcher: probe.fetcher, externalDelayMs: 0, cooldown, now: () => clock })

    const first = await app.fetch(req('/good.example')) // allowed, reserves
    expect(first.status).toBe(200)
    const afterFirst = probe.count()

    clock = 10_000
    const blocked = await app.fetch(req('/good.example', { headers: { accept: 'application/json' } }))
    expect(blocked.status).toBe(429)
    expect(blocked.headers.get('retry-after')).toBe('50')
    expect(((await blocked.json()) as { error: string }).error).toMatch(/cooldown/)
    expect(probe.count()).toBe(afterFirst) // probe-cannon blocked
  })

  it('self-verification bypasses cache and cooldown (loopback stays pure)', async () => {
    let clock = 0
    const app = createApp(
      {},
      {
        externalFetcher: makeFetcher(goodTargetRoutes()),
        externalDelayMs: 0,
        cache: new ReportCache(new MemoryKV(), 300),
        cooldown: new MemoryCooldown(60_000, () => clock),
        now: () => clock,
      },
    )
    const a = await app.fetch(req('/self', { headers: { accept: 'application/json' } }))
    expect(a.status).toBe(200)
    expect(a.headers.get('x-cache')).toBeNull()
    // A second /self is never cooldown-blocked.
    clock = 100
    const b = await app.fetch(req('/self', { headers: { accept: 'application/json' } }))
    expect(b.status).toBe(200)
    expect(((await b.json()) as { grade: string }).grade).toBe('A+')
  })
})
