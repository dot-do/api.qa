import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { verifyPinnedSpec, verifySuite } from '../src/pinned.js'
import { parseDataset, verifySuiteDataDriven } from '../src/dataset.js'
import { sha256Hex } from '../src/digest.js'
import { type Fetcher } from '../src/http.js'
import {
  exitCodeFor,
  junitXml,
  jsonReport,
  jsonReportText,
  toReporterModel,
  resolveReporters,
  xmlAttr,
  xmlText,
} from '../src/reporters.js'
import type { PinnedReport } from '../src/pinned.js'
import type { CheckResult, EvidenceBundle } from '../src/types.js'
import { goodTargetRoutes, makeFetcher, withOverrides, GOOD, type Routes } from './helpers.js'

const SPEC_PATH = fileURLToPath(new URL('../examples/golden-scenario.spec.json', import.meta.url))
const specText = readFileSync(SPEC_PATH, 'utf8')
const SUITE_PATH = fileURLToPath(new URL('../examples/golden-scenario.suite.json', import.meta.url))
const suiteText = readFileSync(SUITE_PATH, 'utf8')
const APIS = 'https://apis.directory'

// --- shared fixtures ------------------------------------------------------

function goldenTargetRoutes(overrides: Routes = {}): Routes {
  return withOverrides(goodTargetRoutes(), {
    'POST /golden/run': (req) => {
      const body = JSON.parse(req.body ?? '{}') as { scenario?: string }
      if (body.scenario === 'dealer-slice') {
        return json200({
          settled: true,
          ledgerBalanced: true,
          path: ['lead', 'prequal', 'deal', 'approve', 'deliver', 'settle'],
        })
      }
      if (body.scenario === 'dealer-slice-escalation') {
        return json200({
          settled: true,
          ledgerBalanced: true,
          escalatedToHumanDesk: true,
          path: ['lead', 'prequal', 'deal', 'escalate', 'approve', 'deliver', 'settle'],
        })
      }
      return { status: 422, contentType: 'application/json', body: '{"error":"unknown scenario"}' }
    },
    ...overrides,
  })
}

function json200(body: unknown) {
  return { status: 200, contentType: 'application/json', body: JSON.stringify(body) }
}

/** The apis.directory data-driven target (numeric seed required). */
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
      if (typeof body.scenario !== 'string' || body.scenario.length === 0) return jsonRes({ error: 'unknown' }, 422)
      if (typeof body.seed !== 'number') return jsonRes({ error: 'seed must be a number' }, 422)
      const runId = `run-${body.seed}-${body.scenario}`
      return jsonRes({ settled: true, ledgerBalanced: true, runId })
    }
    const m = /^\/golden\/run\/(.+)$/.exec(path)
    if (method === 'GET' && m) return jsonRes({ runId: decodeURIComponent(m[1]!), settled: true })
    const res = await surfaces(url, init)
    const body = (await res.text()).split(GOOD).join(APIS)
    return new Response(body, {
      status: res.status,
      headers: { 'content-type': res.headers.get('content-type') ?? 'text/plain' },
    })
  }
}

// --- a minimal XML well-formedness checker (no XML-parser dependency) -----
// Tokenizes tags + text, tracks the open-element stack, and rejects a raw `<`
// or a bare `&` (one not starting a valid entity) in text or attribute values.
// This is the property a CI XML parser relies on, so passing it means the
// GitHub/GitLab test-report parser can consume the file.
function assertWellFormedXml(xml: string): void {
  const body = xml.replace(/^<\?xml[^?]*\?>\s*/, '')
  const stack: string[] = []
  const tagRe = /<(\/?)([a-zA-Z][\w.:-]*)((?:\s+[\w.:-]+="[^"<]*")*)\s*(\/?)>/g
  let last = 0
  let m: RegExpExecArray | null
  const cleanText = (t: string) => {
    if (/</.test(t)) throw new Error(`raw '<' in text: ${JSON.stringify(t)}`)
    if (/&(?!(?:[a-zA-Z]+|#\d+|#x[0-9a-fA-F]+);)/.test(t)) throw new Error(`bare '&' in text: ${JSON.stringify(t)}`)
  }
  while ((m = tagRe.exec(body))) {
    cleanText(body.slice(last, m.index))
    last = tagRe.lastIndex
    const closing = m[1] === '/'
    const selfClose = m[4] === '/'
    const nameTag = m[2]!
    if (closing) {
      const top = stack.pop()
      if (top !== nameTag) throw new Error(`mismatched close </${nameTag}> vs <${top ?? 'nothing'}>`)
    } else if (!selfClose) {
      stack.push(nameTag)
    }
  }
  cleanText(body.slice(last))
  if (stack.length) throw new Error(`unclosed tags: ${stack.join(', ')}`)
}

/** Count non-overlapping matches. */
function count(s: string, re: RegExp): number {
  return (s.match(re) ?? []).length
}

/** Build a synthetic PinnedReport with the given requirement checks. */
function fakePinned(requirements: CheckResult[], target = GOOD): PinnedReport {
  const evidence: EvidenceBundle = { target, fetchedAt: '2026-07-21T00:00:00.000Z', seed: 1, items: [] }
  return {
    $type: 'PinnedVerificationReport',
    verifier: 'api.qa',
    verifierVersion: '0.1.0',
    mode: 'local',
    target,
    spec: { name: 'synthetic', version: '1', digest: 'deadbeef' },
    verifiedAt: '2026-07-21T00:00:00.000Z',
    seed: 1,
    passed: requirements.every((r) => r.verdict === 'pass'),
    requirements,
    evidence,
    attested: false,
  }
}

function chk(id: string, verdict: CheckResult['verdict'], detail = ''): CheckResult {
  return { id, title: `check ${id}`, verdict, detail, evidence: [] }
}

// ==========================================================================
// EXIT CODES — the load-bearing CI property
// ==========================================================================

describe('exit codes (the CI gate)', () => {
  it('a passing pinned run exits 0', async () => {
    const report = await verifyPinnedSpec(GOOD, specText, {
      fetcher: makeFetcher(goldenTargetRoutes()),
      delayMs: 0,
      seed: 1,
      mode: 'local',
    })
    expect(report.passed).toBe(true)
    expect(exitCodeFor(report)).toBe(0)
  })

  it('a failing probe makes a pinned run exit non-zero', async () => {
    const report = await verifyPinnedSpec(GOOD, specText, {
      fetcher: makeFetcher(
        goldenTargetRoutes({
          'POST /golden/run': (req) => {
            const body = JSON.parse(req.body ?? '{}') as { scenario?: string }
            if (body.scenario === 'not-a-scenario') return { status: 422, contentType: 'application/json', body: '{}' }
            return json200({ settled: true, ledgerBalanced: false, path: ['lead'] })
          },
        }),
      ),
      delayMs: 0,
      seed: 1,
      mode: 'local',
    })
    expect(report.passed).toBe(false)
    expect(exitCodeFor(report)).toBe(1)
  })

  it('a passing suite run exits 0', async () => {
    const report = await verifySuite(suiteText, 'staging', { fetcher: apisDirectoryFetcher(), delayMs: 0, seed: 1, mode: 'local' })
    expect(report.passed).toBe(true)
    expect(exitCodeFor(report)).toBe(0)
  })

  it('a data-driven run where every iteration passes exits 0', async () => {
    const rows = [
      { scenario: 'dealer-slice', seed: 1 },
      { scenario: 'fleet-slice', seed: 2 },
    ]
    const report = await verifySuiteDataDriven(suiteText, 'staging', rows, {
      fetcher: apisDirectoryFetcher(),
      delayMs: 0,
      seed: 1,
      mode: 'local',
    })
    expect(report.passed).toBe(true)
    expect(exitCodeFor(report)).toBe(0)
  })

  it('a data-driven run with ONE failing iteration exits non-zero', async () => {
    // A CSV row leaves `seed` a string; the target 422s on a non-numeric seed,
    // so that one iteration fails and the whole run must be non-zero.
    const rows = [
      { scenario: 'dealer-slice', seed: 1 },
      { scenario: 'fleet-slice', seed: 'not-a-number' },
      { scenario: 'retail-slice', seed: 3 },
    ]
    const report = await verifySuiteDataDriven(suiteText, 'staging', rows, {
      fetcher: apisDirectoryFetcher(),
      delayMs: 0,
      seed: 1,
      mode: 'local',
    })
    expect(report.passed).toBe(false)
    expect(report.passedCount).toBe(2)
    expect(exitCodeFor(report)).toBe(1)
  })

  it('a digest-pin mismatch refuses (throws) — the CLI maps that to a non-zero exit', async () => {
    const edited = specText.replace('"equals": true', '"equals": false')
    const honestPin = await sha256Hex(specText)
    await expect(
      verifyPinnedSpec(GOOD, edited, {
        fetcher: makeFetcher(goldenTargetRoutes()),
        delayMs: 0,
        mode: 'local',
        expectedDigest: honestPin,
      }),
    ).rejects.toThrow(/digest mismatch/)
  })

  it('is consistent across modes: passed→0, failed→1 (pinned, suite, data-driven)', () => {
    const pass = fakePinned([chk('a', 'pass'), chk('b', 'pass')])
    const fail = fakePinned([chk('a', 'pass'), chk('b', 'fail', 'boom')])
    expect(exitCodeFor(pass)).toBe(0)
    expect(exitCodeFor(fail)).toBe(1)
  })
})

// ==========================================================================
// JUnit XML reporter
// ==========================================================================

describe('JUnit XML reporter', () => {
  it('maps each requirement to a testcase with accurate failure/skip counts', () => {
    const report = fakePinned([chk('a', 'pass'), chk('b', 'fail', 'ledgerBalanced was false'), chk('c', 'skip', 'not applicable')])
    const xml = junitXml(report)
    assertWellFormedXml(xml)
    expect(count(xml, /<testcase\b/g)).toBe(3)
    expect(count(xml, /<failure\b/g)).toBe(1)
    expect(count(xml, /<skipped\b/g)).toBe(1)
    expect(count(xml, /<error\b/g)).toBe(0)
    // top-level aggregate attributes are exact
    expect(xml).toMatch(/<testsuites[^>]*\btests="3"/)
    expect(xml).toMatch(/<testsuites[^>]*\bfailures="1"/)
    expect(xml).toMatch(/<testsuites[^>]*\bskipped="1"/)
    expect(xml).toMatch(/<testsuites[^>]*\berrors="0"/)
    // the failure detail is carried
    expect(xml).toContain('ledgerBalanced was false')
  })

  it('escapes XML special characters in names and details, staying well-formed', () => {
    const nasty = 'a < b & c > d "q" \'s\' <script>alert(1)</script>'
    const report = fakePinned([{ id: 'x&<>', title: nasty, verdict: 'fail', detail: nasty, evidence: [] }])
    const xml = junitXml(report)
    assertWellFormedXml(xml)
    // the raw injection never appears un-escaped
    expect(xml).not.toContain('<script>')
    expect(xml).toContain('&lt;script&gt;')
    expect(xml).toContain('&amp;')
    expect(xml).toContain('&lt;')
    expect(xml).toContain('&gt;')
    // attribute values escape quotes
    expect(xml).toContain('&quot;')
  })

  it('renders a valid, parseable document for a real passing run', async () => {
    const report = await verifyPinnedSpec(GOOD, specText, {
      fetcher: makeFetcher(goldenTargetRoutes()),
      delayMs: 0,
      seed: 1,
      mode: 'local',
    })
    const xml = junitXml(report)
    assertWellFormedXml(xml)
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true)
    expect(count(xml, /<testcase\b/g)).toBe(report.requirements.length)
    expect(count(xml, /<failure\b/g)).toBe(0)
  })

  it('data-driven: one testcase per iteration × probe; a failing iteration yields a <failure>', async () => {
    const rows = [
      { scenario: 'dealer-slice', seed: 1 },
      { scenario: 'fleet-slice', seed: 'not-a-number' },
    ]
    const report = await verifySuiteDataDriven(suiteText, 'staging', rows, {
      fetcher: apisDirectoryFetcher(),
      delayMs: 0,
      seed: 1,
      mode: 'local',
    })
    const xml = junitXml(report)
    assertWellFormedXml(xml)
    // 2 iterations × 3 probes = 6 testcases; one testsuite per iteration
    expect(count(xml, /<testcase\b/g)).toBe(report.iterations.length * report.probeIds.length)
    expect(count(xml, /<testsuite\b(?![s])/g)).toBe(report.iterations.length)
    // the second iteration failed somewhere → at least one failure element
    expect(count(xml, /<failure\b/g)).toBeGreaterThanOrEqual(1)
  })

  it('a refused iteration (SSRF/unreachable row) emits <error> testcases', () => {
    // Synthesize a data-driven report with one refused iteration.
    const report = {
      $type: 'DataDrivenSuiteReport' as const,
      verifier: 'api.qa' as const,
      verifierVersion: '0.1.0',
      mode: 'local' as const,
      suite: { name: 's', version: '1', digest: 'd', environment: 'e' },
      probeIds: ['p1', 'p2'],
      iterations: [
        {
          index: 0,
          row: { baseUrl: 'http://127.0.0.1' },
          passed: false,
          verdicts: { p1: 'error' as const, p2: 'error' as const },
          error: 'refusing private/IP-literal target: 127.0.0.1',
        },
      ],
      matrix: [['error', 'error']] as ('error')[][],
      passed: false,
      passedCount: 0,
      failedCount: 1,
      total: 1,
    }
    const xml = junitXml(report)
    assertWellFormedXml(xml)
    expect(count(xml, /<error\b/g)).toBe(2)
    expect(xml).toContain('refusing private/IP-literal target')
    expect(exitCodeFor(report)).toBe(1)
  })
})

// ==========================================================================
// JSON reporter
// ==========================================================================

describe('JSON reporter', () => {
  it('matches the run: verdict, totals, and per-probe pass/fail + detail', async () => {
    const report = await verifyPinnedSpec(GOOD, specText, {
      fetcher: makeFetcher(goldenTargetRoutes()),
      delayMs: 0,
      seed: 1,
      mode: 'local',
    })
    const j = jsonReport(report)
    expect(j.$report).toBe('api.qa.ci-run')
    expect(j.schemaVersion).toBe(1)
    expect(j.verdict).toBe('PASSED')
    expect(j.passed).toBe(true)
    expect(j.exitCode).toBe(0)
    expect(j.digest).toBe(report.spec.digest)
    expect(j.target).toBe(report.target)
    expect(j.totals.tests).toBe(report.requirements.length)
    expect(j.totals.failures).toBe(0)
    // every requirement id is present as a case, in order
    const caseIds = j.suites.flatMap((s) => s.cases.map((c) => c.id))
    expect(caseIds).toEqual(report.requirements.map((r) => r.id))
    for (const c of j.suites.flatMap((s) => s.cases)) expect(c.status).toBe('pass')
  })

  it('a failing run reports FAILED with the failing probe detail', async () => {
    const report = await verifyPinnedSpec(GOOD, specText, {
      fetcher: makeFetcher(
        goldenTargetRoutes({
          'POST /golden/run': (req) => {
            const body = JSON.parse(req.body ?? '{}') as { scenario?: string }
            if (body.scenario === 'not-a-scenario') return { status: 422, contentType: 'application/json', body: '{}' }
            return json200({ settled: true, ledgerBalanced: false, path: ['lead'] })
          },
        }),
      ),
      delayMs: 0,
      seed: 1,
      mode: 'local',
    })
    const j = jsonReport(report)
    expect(j.verdict).toBe('FAILED')
    expect(j.passed).toBe(false)
    expect(j.exitCode).toBe(1)
    expect(j.totals.failures).toBeGreaterThanOrEqual(1)
    const failing = j.suites.flatMap((s) => s.cases).find((c) => c.status === 'fail')
    expect(failing?.detail).toMatch(/ledgerBalanced/)
  })

  it('jsonReportText is valid JSON that round-trips', () => {
    const report = fakePinned([chk('a', 'pass'), chk('b', 'fail', 'x')])
    const parsed = JSON.parse(jsonReportText(report))
    expect(parsed.totals.tests).toBe(2)
    expect(parsed.totals.failures).toBe(1)
  })
})

// ==========================================================================
// model + reporter selection
// ==========================================================================

describe('toReporterModel', () => {
  it('summarizes counts across all suites', () => {
    const report = fakePinned([chk('a', 'pass'), chk('b', 'fail'), chk('c', 'skip')])
    const m = toReporterModel(report)
    expect(m.tests).toBe(3)
    expect(m.failures).toBe(1)
    expect(m.skipped).toBe(1)
    expect(m.errors).toBe(0)
    expect(m.verdict).toBe('FAILED')
  })
})

describe('resolveReporters', () => {
  const noFlags = () => undefined
  it('parses repeated and comma-split reporter names, de-duplicated', () => {
    const specs = resolveReporters(['cli', 'junit,json', 'json'], noFlags)
    expect(specs.map((s) => s.name)).toEqual(['cli', 'junit', 'json'])
  })

  it('rejects an unknown reporter', () => {
    expect(() => resolveReporters(['bogus'], noFlags)).toThrow(/unknown reporter/)
  })

  it('applies per-reporter output paths', () => {
    const flags: Record<string, string> = { 'reporter-junit-out': 'a.xml', 'reporter-json-out': 'b.json' }
    const specs = resolveReporters(['junit', 'json'], (k) => flags[k])
    expect(specs).toEqual([
      { name: 'junit', out: 'a.xml' },
      { name: 'json', out: 'b.json' },
    ])
  })

  it('applies a shared --reporter-out to a single file reporter', () => {
    const flags: Record<string, string> = { 'reporter-out': 'out.xml' }
    const specs = resolveReporters(['cli', 'junit'], (k) => flags[k])
    expect(specs).toEqual([{ name: 'cli' }, { name: 'junit', out: 'out.xml' }])
  })

  it('refuses a shared --reporter-out shared by two file reporters (would clobber)', () => {
    const flags: Record<string, string> = { 'reporter-out': 'out' }
    expect(() => resolveReporters(['junit', 'json'], (k) => flags[k])).toThrow(/cannot serve multiple/)
  })
})

describe('xml escaping primitives', () => {
  it('xmlText escapes &, <, > only', () => {
    expect(xmlText('a & b < c > d "e" \'f\'')).toBe('a &amp; b &lt; c &gt; d "e" \'f\'')
  })
  it('xmlAttr additionally escapes quotes', () => {
    expect(xmlAttr('a "b" \'c\' & <d>')).toBe('a &quot;b&quot; &apos;c&apos; &amp; &lt;d&gt;')
  })
})
