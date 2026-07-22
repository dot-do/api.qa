import { describe, it, expect } from 'vitest'
import { ReportCache, MemoryKV, hostKey } from '../src/cache.js'
import { verifyTarget } from '../src/verify.js'
import { verifyPinnedSpec } from '../src/pinned.js'
import { sha256Hex } from '../src/digest.js'
import { goodTargetRoutes, makeFetcher, GOOD } from './helpers.js'

async function sampleReport(seed = 7) {
  return verifyTarget(GOOD, { fetcher: makeFetcher(goodTargetRoutes()), delayMs: 0, seed })
}

describe('hostKey', () => {
  it('collapses scheme, port, and path to a bare lowercase host', () => {
    expect(hostKey('https://Good.Example/x/y')).toBe('good.example')
    expect(hostKey('good.example')).toBe('good.example')
    expect(hostKey('http://good.example:8787')).toBe('good.example')
  })
})

describe('ReportCache — domain mode', () => {
  it('stores a verdict under domain+digest and serves it back fresh', async () => {
    const kv = new MemoryKV()
    const cache = new ReportCache(kv, 300)
    const report = await sampleReport()

    expect(await cache.getDomain(GOOD, 1000)).toBeNull() // cold
    await cache.putDomain(GOOD, report, 1000)

    const hit = await cache.getDomain(GOOD, 1000)
    expect(hit).not.toBeNull()
    expect(hit!.fresh).toBe(true)
    expect(hit!.ageMs).toBe(0)
    expect(hit!.report.grade).toBe(report.grade)
    // content-addressed replay index: report:{host}:{evidenceDigest}
    expect(kv.keys()).toContain(`report:good.example:${report.discovery.evidenceDigest}`)
    expect(kv.keys()).toContain('head:good.example')
  })

  it('marks a verdict stale once the TTL window has elapsed', async () => {
    const cache = new ReportCache(new MemoryKV(), 60) // 60s window
    const report = await sampleReport()
    await cache.putDomain(GOOD, report, 0)

    expect((await cache.getDomain(GOOD, 59_000))!.fresh).toBe(true)
    const stale = await cache.getDomain(GOOD, 61_000)
    expect(stale!.fresh).toBe(false)
    expect(stale!.ageMs).toBe(61_000)
    expect(stale!.report.grade).toBe(report.grade) // still retrievable as fallback
  })

  it('a re-probe with new evidence advances the head pointer', async () => {
    const kv = new MemoryKV()
    const cache = new ReportCache(kv, 300)
    const first = await sampleReport(1)
    await cache.putDomain(GOOD, first, 1000)
    const second = await sampleReport(2)
    await cache.putDomain(GOOD, second, 2000)

    const hit = await cache.getDomain(GOOD, 2000)
    expect(hit!.report.seed).toBe(second.seed)
    // both content-addressed entries survive for replay lookup by digest
    expect(await cache.getByDigest(GOOD, first.discovery.evidenceDigest)).not.toBeNull()
    expect(await cache.getByDigest(GOOD, second.discovery.evidenceDigest)).not.toBeNull()
  })
})

describe('ReportCache — pinned mode', () => {
  it('keys pinned verdicts by domain+specDigest', async () => {
    const cache = new ReportCache(new MemoryKV(), 300)
    const specText = JSON.stringify({
      $type: 'PinnedSpec', name: 'mini', version: '1',
      requirements: [{ id: 'status-ok', kind: 'endpoint', method: 'GET', path: '/api/status', expect: { status: 200 } }],
    })
    const specDigest = await sha256Hex(specText)
    const report = await verifyPinnedSpec(GOOD, specText, { fetcher: makeFetcher(goodTargetRoutes()), delayMs: 0, seed: 1 })

    expect(await cache.getPinned(GOOD, specDigest, 1, 0)).toBeNull()
    await cache.putPinned(GOOD, specDigest, 1, report, 0)
    const hit = await cache.getPinned(GOOD, specDigest, 1, 0)
    expect(hit!.fresh).toBe(true)
    expect(hit!.report.passed).toBe(report.passed)
    // a different spec digest is a cache miss (no cross-spec bleed)
    expect(await cache.getPinned(GOOD, 'deadbeef', 1, 0)).toBeNull()
  })

  it('keys pinned verdicts on the normalized ORIGIN — same host, different port/scheme is a MISS (no cross-serve, ax-4c4)', async () => {
    const cache = new ReportCache(new MemoryKV(), 300)
    const specText = JSON.stringify({
      $type: 'PinnedSpec', name: 'mini', version: '1',
      requirements: [{ id: 'status-ok', kind: 'endpoint', method: 'GET', path: '/api/status', expect: { status: 200 } }],
    })
    const specDigest = await sha256Hex(specText)
    const report = await verifyPinnedSpec(GOOD, specText, { fetcher: makeFetcher(goodTargetRoutes()), delayMs: 0, seed: 1 })

    await cache.putPinned('https://good.example:8787', specDigest, 1, report, 0)
    // Same origin → HIT.
    expect(await cache.getPinned('https://good.example:8787', specDigest, 1, 0)).not.toBeNull()
    // Same host, DIFFERENT PORT → MISS (a different service; hostKey would have collided).
    expect(await cache.getPinned('https://good.example:9999', specDigest, 1, 0)).toBeNull()
    // Same host+port, DIFFERENT SCHEME → MISS.
    expect(await cache.getPinned('http://good.example:8787', specDigest, 1, 0)).toBeNull()
  })

  it('keys pinned verdicts by seed too — a different seed is a cache miss (never serves a stale seed field)', async () => {
    const cache = new ReportCache(new MemoryKV(), 300)
    const specText = JSON.stringify({
      $type: 'PinnedSpec', name: 'mini', version: '1',
      requirements: [{ id: 'status-ok', kind: 'endpoint', method: 'GET', path: '/api/status', expect: { status: 200 } }],
    })
    const specDigest = await sha256Hex(specText)
    const report = await verifyPinnedSpec(GOOD, specText, { fetcher: makeFetcher(goodTargetRoutes()), delayMs: 0, seed: 1 })
    await cache.putPinned(GOOD, specDigest, 1, report, 0)

    expect(await cache.getPinned(GOOD, specDigest, 1, 0)).not.toBeNull() // same seed → HIT
    expect(await cache.getPinned(GOOD, specDigest, 2, 0)).toBeNull() // different seed → MISS
    expect(await cache.getPinned(GOOD, specDigest, undefined, 0)).toBeNull() // unseeded request → MISS
  })
})
