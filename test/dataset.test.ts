import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseDataset, verifySuiteDataDriven } from '../src/dataset.js'
import { sha256Hex } from '../src/digest.js'
import { type Fetcher } from '../src/http.js'
import { goodTargetRoutes, makeFetcher, GOOD } from './helpers.js'

const SUITE_PATH = fileURLToPath(new URL('../examples/golden-scenario.suite.json', import.meta.url))
const suiteText = readFileSync(SUITE_PATH, 'utf8')
const JSON_DATASET = fileURLToPath(new URL('../examples/golden-dataset.json', import.meta.url))
const CSV_DATASET = fileURLToPath(new URL('../examples/golden-dataset.csv', import.meta.url))

const APIS = 'https://apis.directory'

/**
 * Same mock apis.directory target the suite tests use: standard discovery
 * surfaces PLUS the golden completion-ladder endpoints. POST /golden/run
 * REQUIRES a numeric `seed` and echoes a runId derived from (seed, scenario).
 */
function apisDirectoryFetcher(): Fetcher {
  const surfaces = makeFetcher(goodTargetRoutes(), APIS)
  const jsonRes = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  return async (url, init) => {
    const u = new URL(url)
    const method = (init?.method ?? 'GET').toUpperCase()
    const path = u.pathname
    if (method === 'POST' && path === '/golden/run') {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
        scenario?: unknown
        seed?: unknown
      }
      if (typeof body.scenario !== 'string' || body.scenario.length === 0) {
        return jsonRes({ error: 'unknown scenario' }, 422)
      }
      if (typeof body.seed !== 'number') {
        return jsonRes({ error: `seed must be a number, got ${typeof body.seed}` }, 422)
      }
      const runId = `run-${body.seed}-${body.scenario}`
      return jsonRes({ settled: true, ledgerBalanced: true, runId })
    }
    const m = /^\/golden\/run\/(.+)$/.exec(path)
    if (method === 'GET' && m) {
      return jsonRes({ runId: decodeURIComponent(m[1]!), settled: true })
    }
    const res = await surfaces(url, init)
    const body = (await res.text()).split(GOOD).join(APIS)
    return new Response(body, {
      status: res.status,
      headers: { 'content-type': res.headers.get('content-type') ?? 'text/plain' },
    })
  }
}

describe('parseDataset — CSV (RFC 4180 minimal)', () => {
  it('parses a header + rows into row objects (CSV cells are strings)', () => {
    const rows = parseDataset('scenario,seed\ndealer,1\nfleet,2\n', { format: 'csv' })
    expect(rows).toEqual([
      { scenario: 'dealer', seed: '1' },
      { scenario: 'fleet', seed: '2' },
    ])
  })

  it('handles quoted fields containing commas', () => {
    const rows = parseDataset('a,b\n"x,y",z\n', { format: 'csv' })
    expect(rows).toEqual([{ a: 'x,y', b: 'z' }])
  })

  it('handles escaped double-quotes ("") inside a quoted field', () => {
    const rows = parseDataset('a\n"he said ""hi"""\n', { format: 'csv' })
    expect(rows).toEqual([{ a: 'he said "hi"' }])
  })

  it('handles newlines inside a quoted field', () => {
    const rows = parseDataset('a,b\n"line1\nline2",z\n', { format: 'csv' })
    expect(rows).toEqual([{ a: 'line1\nline2', b: 'z' }])
  })

  it('handles CRLF line endings and an absent trailing newline', () => {
    const rows = parseDataset('a,b\r\n1,2\r\n3,4', { format: 'csv' })
    expect(rows).toEqual([
      { a: '1', b: '2' },
      { a: '3', b: '4' },
    ])
  })

  it('rejects a data row whose field count does not match the header', () => {
    expect(() => parseDataset('a,b\n1\n', { format: 'csv' })).toThrow(/field/)
  })

  it('rejects an unterminated quoted field', () => {
    expect(() => parseDataset('a\n"oops\n', { format: 'csv' })).toThrow(/unterminated/)
  })
})

describe('parseDataset — JSON + auto-detect', () => {
  it('parses an array of row objects, preserving JSON types', () => {
    const rows = parseDataset('[{"scenario":"dealer","seed":1}]')
    expect(rows).toEqual([{ scenario: 'dealer', seed: 1 }])
    expect(typeof rows[0]!.seed).toBe('number')
  })

  it('auto-detects JSON by a leading bracket, else CSV', () => {
    expect(parseDataset('  [{"x":1}]')).toEqual([{ x: 1 }])
    expect(parseDataset('x\n1\n')).toEqual([{ x: '1' }])
  })

  it('rejects a non-array JSON dataset and non-object rows', () => {
    expect(() => parseDataset('{"x":1}', { format: 'json' })).toThrow(/ARRAY/)
    expect(() => parseDataset('[1,2]', { format: 'json' })).toThrow(/must be an object/)
  })
})

describe('data-driven suite runs (Newman --iteration-data parity)', () => {
  it('runs the golden suite once per JSON-dataset ROW, each row bound into the env, producing an N×probe matrix + overall verdict', async () => {
    const rows = parseDataset(readFileSync(JSON_DATASET, 'utf8'), { format: 'json' })
    const report = await verifySuiteDataDriven(suiteText, 'staging', rows, {
      fetcher: apisDirectoryFetcher(),
      delayMs: 0,
      mode: 'local',
    })

    expect(report.total).toBe(3)
    expect(report.iterations).toHaveLength(3)
    expect(report.probeIds).toEqual(['openapi-published', 'golden-run-settles', 'run-receipt-fetchable'])

    // Per-iteration × per-probe matrix: every cell passes.
    expect(report.matrix).toEqual([
      ['pass', 'pass', 'pass'],
      ['pass', 'pass', 'pass'],
      ['pass', 'pass', 'pass'],
    ])

    // Overall verdict = all iterations pass.
    expect(report.passed).toBe(true)
    expect(report.passedCount).toBe(3)
    expect(report.failedCount).toBe(0)

    // Each row's fields (scenario string + numeric seed) interpolated into the
    // POST body and produced that row's own runId — proof the row was bound.
    expect(report.iterations[0]!.report!.evidence.bindings?.runId).toBe('run-1-dealer-slice')
    expect(report.iterations[1]!.report!.evidence.bindings?.runId).toBe('run-2-fleet-slice')
    expect(report.iterations[2]!.report!.evidence.bindings?.runId).toBe('run-3-retail-slice')
  })

  it('runs the golden suite once per CSV-dataset ROW (quoted comma field), seed inherited from the env', async () => {
    const rows = parseDataset(readFileSync(CSV_DATASET, 'utf8'), { format: 'csv' })
    expect(rows).toEqual([
      { scenario: 'dealer-slice' },
      { scenario: 'fleet, slice' },
      { scenario: 'retail-slice' },
    ])
    const report = await verifySuiteDataDriven(suiteText, 'staging', rows, {
      fetcher: apisDirectoryFetcher(),
      delayMs: 0,
      mode: 'local',
    })
    expect(report.passed).toBe(true)
    expect(report.matrix.every((row) => row.every((c) => c === 'pass'))).toBe(true)
    // seed=1 comes from the staging env; scenario is the row field (the quoted
    // "fleet, slice" survived CSV parsing and reached the POST body).
    expect(report.iterations[0]!.report!.evidence.bindings?.runId).toBe('run-1-dealer-slice')
    expect(report.iterations[1]!.report!.evidence.bindings?.runId).toBe('run-1-fleet, slice')
    expect(report.iterations[2]!.report!.evidence.bindings?.runId).toBe('run-1-retail-slice')
  })

  it('iterations are INDEPENDENT — a capture in iteration i does not leak into i+1', async () => {
    // Two rows with different scenarios. The golden suite captures runId in
    // probe 2 and chains it into probe 3. If the capture bled across iterations,
    // a later iteration would show an earlier iteration's runId. Each iteration
    // shows ONLY its own row's runId, and its input row is not mutated.
    const rows = [
      { scenario: 'alpha', seed: 10 },
      { scenario: 'beta', seed: 20 },
    ]
    const report = await verifySuiteDataDriven(suiteText, 'staging', rows, {
      fetcher: apisDirectoryFetcher(),
      delayMs: 0,
      mode: 'local',
    })
    expect(report.passed).toBe(true)
    expect(report.iterations[0]!.report!.evidence.bindings?.runId).toBe('run-10-alpha')
    expect(report.iterations[1]!.report!.evidence.bindings?.runId).toBe('run-20-beta')
    // The rows array is not mutated by binding/capture.
    expect(rows).toEqual([
      { scenario: 'alpha', seed: 10 },
      { scenario: 'beta', seed: 20 },
    ])
  })

  it('overall verdict FAILS with a count when any single iteration fails', async () => {
    // Row 1 sets an EMPTY scenario → the mock 422s POST /golden/run → that
    // iteration fails while the others pass.
    const rows = [
      { scenario: 'dealer-slice', seed: 1 },
      { scenario: '', seed: 2 },
      { scenario: 'retail-slice', seed: 3 },
    ]
    const report = await verifySuiteDataDriven(suiteText, 'staging', rows, {
      fetcher: apisDirectoryFetcher(),
      delayMs: 0,
      mode: 'local',
    })
    expect(report.passed).toBe(false)
    expect(report.passedCount).toBe(2)
    expect(report.failedCount).toBe(1)
    expect(report.iterations[0]!.passed).toBe(true)
    expect(report.iterations[1]!.passed).toBe(false)
    expect(report.iterations[2]!.passed).toBe(true)
    // The failing iteration's matrix row shows the failing probe.
    expect(report.matrix[1]![1]).toBe('fail')
  })

  it('the SUITE digest pin gates BEFORE any iteration (wrong pin → refuse, nothing fetched)', async () => {
    let fetched = 0
    const counting: Fetcher = () => {
      fetched++
      return Promise.reject(new Error('should never fetch when the pin mismatches'))
    }
    await expect(
      verifySuiteDataDriven(suiteText, 'staging', [{ scenario: 'x', seed: 1 }], {
        fetcher: counting,
        delayMs: 0,
        mode: 'local',
        expectedDigest: 'deadbeef',
      }),
    ).rejects.toThrow(/suite digest mismatch/)
    expect(fetched).toBe(0)

    // The honest pin runs every iteration.
    const ok = await verifySuiteDataDriven(suiteText, 'staging', [{ scenario: 'x', seed: 1 }], {
      fetcher: apisDirectoryFetcher(),
      delayMs: 0,
      mode: 'local',
      expectedDigest: await sha256Hex(suiteText),
    })
    expect(ok.passed).toBe(true)
  })

  it('unknown environment fails closed before any iteration', async () => {
    let fetched = 0
    const counting: Fetcher = () => {
      fetched++
      return Promise.reject(new Error('should never fetch'))
    }
    await expect(
      verifySuiteDataDriven(suiteText, 'does-not-exist', [{ scenario: 'x', seed: 1 }], {
        fetcher: counting,
        delayMs: 0,
        mode: 'local',
      }),
    ).rejects.toThrow(/unknown environment "does-not-exist"/)
    expect(fetched).toBe(0)
  })

  describe('SSRF gates are REUSED per iteration, not weakened for "just a dataset"', () => {
    it('a private-baseUrl row is refused for that iteration; other rows run; hostile URL never requested', async () => {
      const suite = JSON.stringify({
        $type: 'Suite',
        name: 'row-baseurl',
        version: '1',
        environments: { e: { vars: { baseUrl: GOOD } } },
        requirements: [
          { id: 'status', kind: 'endpoint', method: 'GET', path: '/api/status', expect: { status: 200 } },
        ],
      })
      const requested: string[] = []
      const base = makeFetcher(goodTargetRoutes())
      const spy: Fetcher = (url, init) => {
        requested.push(String(url))
        return base(url, init)
      }
      const rows = [
        { baseUrl: GOOD },
        { baseUrl: 'http://169.254.169.254' },
        { baseUrl: GOOD },
      ]
      const report = await verifySuiteDataDriven(suite, 'e', rows, {
        fetcher: spy,
        delayMs: 0,
        mode: 'remote',
      })

      // Overall fails because one iteration was refused.
      expect(report.passed).toBe(false)
      expect(report.passedCount).toBe(2)
      expect(report.failedCount).toBe(1)

      // The benign iterations ran and passed.
      expect(report.iterations[0]!.passed).toBe(true)
      expect(report.iterations[2]!.passed).toBe(true)

      // The hostile iteration failed closed with an SSRF reason, all cells error.
      const hostile = report.iterations[1]!
      expect(hostile.passed).toBe(false)
      expect(hostile.error).toMatch(/refusing private\/IP-literal target/)
      expect(hostile.verdicts).toEqual({ status: 'error' })
      expect(report.matrix[1]).toEqual(['error'])

      // The metadata endpoint was NEVER fetched — real fetch-spy proof.
      expect(requested.some((u) => u.includes('169.254'))).toBe(false)
      // The benign origin WAS fetched (the other rows genuinely ran).
      expect(requested.some((u) => u.startsWith(GOOD))).toBe(true)
    })

    it('a row that steers an interpolated probe URL off-origin fails that probe (never fetched) while a same-origin row passes', async () => {
      const suite = JSON.stringify({
        $type: 'Suite',
        name: 'row-interp',
        version: '1',
        environments: { e: { vars: { baseUrl: GOOD } } },
        requirements: [
          { id: 'go', kind: 'endpoint', method: 'GET', path: '{{dest}}', expect: { status: 200 } },
        ],
      })
      const rows = [
        { dest: '/api/status' }, // same-origin → passes
        { dest: 'https://evil.example/pwn' }, // off-origin → refused, fail closed
      ]
      const report = await verifySuiteDataDriven(suite, 'e', rows, {
        fetcher: makeFetcher(goodTargetRoutes()),
        delayMs: 0,
        mode: 'local',
      })
      expect(report.iterations[0]!.passed).toBe(true)
      expect(report.iterations[1]!.passed).toBe(false)
      const bad = report.iterations[1]!.report!.requirements.find((r) => r.id === 'go')!
      expect(bad.verdict).toBe('fail')
      expect(bad.detail).toMatch(/off-origin\/private/)
      // evil.example was never fetched by the off-origin iteration.
      expect(report.iterations[1]!.report!.evidence.items.some((e) => /evil\.example/.test(e.url))).toBe(false)
    })
  })
})
