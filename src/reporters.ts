/**
 * CI reporters — make `npx autonomous-qa` a first-class CI citizen (Newman
 * parity). Three concerns live here, all PURE over an ALREADY-PRODUCED report:
 *
 *   1. exitCodeFor(report)  — the load-bearing CI property. A gate that exits 0
 *      on a failure is a SILENT GREEN, the worst defect. Every pinned/suite/
 *      data-driven run exits NON-ZERO iff any requirement / probe / iteration
 *      failed (or the run was refused). ADVISORY grade runs exit non-zero only
 *      on grade F (they are not pinned gates).
 *   2. junitXml(report)     — a valid JUnit XML (testsuites/testsuite/testcase
 *      with <failure>/<error>/<skipped>) that GitHub/GitLab can parse. Every
 *      requirement/probe — and every data-driven ITERATION × PROBE — is one
 *      <testcase>; failures/errors counts are exact; names + details are
 *      XML-escaped.
 *   3. jsonReport(report)   — a stable, structured JSON summary (target,
 *      verdict, per-probe pass/fail + detail + timing, digest).
 *
 * These reporters add NO fetch and NO new runner: they read the report the
 * reused verify/suite/data-driven runners already produced. No new SSRF
 * surface — this file never touches the network.
 */

import type { CheckResult, EvidenceBundle, VerificationReport, Verdict } from './types.js'
import type { PinnedReport, SuiteReport } from './pinned.js'
import type { DataDrivenReport } from './dataset.js'
import { VERIFIER_VERSION } from './verify.js'

/** Any report a CLI gate/advisory run can produce. Discriminated by `$type`. */
export type AnyRunReport = PinnedReport | SuiteReport | DataDrivenReport | VerificationReport

/** A testcase status. `error` = the iteration/probe could not run at all. */
export type CaseStatus = 'pass' | 'fail' | 'skip' | 'error'

export interface ReporterTestCase {
  /** Requirement/probe id — stable identifier for the case. */
  id: string
  /** Human name (title + id). */
  name: string
  /** Grouping name (JUnit `classname`). */
  classname: string
  status: CaseStatus
  /** Failure/skip/error detail; empty on pass. */
  detail: string
  timeMs: number
}

export interface ReporterTestSuite {
  name: string
  cases: ReporterTestCase[]
}

/** The normalized model every reporter renders from. */
export interface ReporterModel {
  kind: AnyRunReport['$type']
  name: string
  target: string
  mode: string
  verifiedAt: string
  seed: number
  /** Pinned spec / suite digest, when the run is pinned. */
  digest?: string
  passed: boolean
  verdict: 'PASSED' | 'FAILED'
  exitCode: number
  suites: ReporterTestSuite[]
  tests: number
  failures: number
  errors: number
  skipped: number
  timeMs: number
}

// ---------------------------------------------------------------------------
// Exit codes — the load-bearing CI property, uniform across gate modes.
// ---------------------------------------------------------------------------

/**
 * The process exit code for a run. NON-ZERO iff the gate should fail CI.
 *
 *   PinnedVerificationReport / SuiteVerificationReport / DataDrivenSuiteReport
 *     → `passed ? 0 : 1`. `passed` is already "every requirement/probe passed"
 *       (and, data-driven, "every iteration passed AND ran"), so ANY failing
 *       requirement/probe/iteration — or an iteration REFUSED before it ran
 *       (SSRF, unreachable) which lands as `passed: false` — exits non-zero.
 *   VerificationReport (advisory grade)
 *     → `grade === 'F' ? 1 : 0`. Advisory grading is not a pinned gate.
 *
 * A digest-pin mismatch or an unreachable/refused target throws BEFORE a report
 * exists; the CLI catch converts that throw to a non-zero exit. Both paths are
 * non-zero — a failure is never a silent green.
 */
export function exitCodeFor(report: AnyRunReport): number {
  switch (report.$type) {
    case 'PinnedVerificationReport':
    case 'SuiteVerificationReport':
    case 'DataDrivenSuiteReport':
      return report.passed ? 0 : 1
    case 'VerificationReport':
      return report.grade === 'F' ? 1 : 0
  }
}

// ---------------------------------------------------------------------------
// Normalize any report → ReporterModel
// ---------------------------------------------------------------------------

function roleTimes(bundle: EvidenceBundle | undefined): Map<string, number> {
  const m = new Map<string, number>()
  if (!bundle) return m
  for (const e of bundle.items) m.set(e.role, (m.get(e.role) ?? 0) + (e.elapsedMs || 0))
  return m
}

function checkTime(check: CheckResult, times: Map<string, number>): number {
  let t = 0
  for (const role of check.evidence ?? []) t += times.get(role) ?? 0
  return t
}

function caseFromCheck(c: CheckResult, classname: string, times: Map<string, number>): ReporterTestCase {
  return {
    id: c.id,
    name: `${c.title} [${c.id}]`,
    classname,
    status: c.verdict as CaseStatus,
    detail: c.verdict === 'pass' ? '' : c.detail,
    timeMs: checkTime(c, times),
  }
}

export function toReporterModel(report: AnyRunReport): ReporterModel {
  const suites: ReporterTestSuite[] = []
  let name = ''
  let target = ''
  let digest: string | undefined
  let verifiedAt = ''
  let seed = 0

  if (report.$type === 'PinnedVerificationReport') {
    const times = roleTimes(report.evidence)
    name = `${report.spec.name}@${report.spec.version}`
    target = report.target
    digest = report.spec.digest
    verifiedAt = report.verifiedAt
    seed = report.seed
    suites.push({ name: report.spec.name, cases: report.requirements.map((c) => caseFromCheck(c, report.spec.name, times)) })
  } else if (report.$type === 'SuiteVerificationReport') {
    const times = roleTimes(report.evidence)
    const cls = `${report.suite.name}.${report.suite.environment}`
    name = `${report.suite.name}@${report.suite.version} (${report.suite.environment})`
    target = report.target
    digest = report.suite.digest
    verifiedAt = report.verifiedAt
    seed = report.seed
    suites.push({ name: cls, cases: report.requirements.map((c) => caseFromCheck(c, cls, times)) })
  } else if (report.$type === 'DataDrivenSuiteReport') {
    name = `${report.suite.name}@${report.suite.version} (${report.suite.environment})`
    const firstRan = report.iterations.find((it) => it.report)?.report
    target = firstRan?.target ?? report.suite.name
    digest = report.suite.digest
    verifiedAt = firstRan?.verifiedAt ?? ''
    seed = firstRan?.seed ?? 0
    for (const it of report.iterations) {
      const suiteName = `${report.suite.name} · iteration ${it.index}`
      const times = roleTimes(it.report?.evidence)
      const cases: ReporterTestCase[] = report.probeIds.map((pid) => {
        const req = it.report?.requirements.find((r) => r.id === pid)
        if (it.error) {
          // Iteration refused before it ran (SSRF/unreachable): every probe errors.
          return { id: pid, name: pid, classname: suiteName, status: 'error', detail: it.error, timeMs: 0 }
        }
        const cell = (it.verdicts[pid] ?? 'error') as CaseStatus
        return {
          id: pid,
          name: `${req?.title ?? pid} [${pid}]`,
          classname: suiteName,
          status: cell,
          detail: cell === 'pass' ? '' : req?.detail ?? `probe ${pid} did not produce a verdict`,
          timeMs: req ? checkTime(req, times) : 0,
        }
      })
      suites.push({ name: suiteName, cases })
    }
  } else {
    // VerificationReport — advisory grade run.
    const times = roleTimes(report.evidence)
    name = `${report.target} (grade ${report.grade})`
    target = report.target
    digest = report.pinnedSpecDigest
    verifiedAt = report.verifiedAt
    seed = report.seed
    suites.push({ name: report.target, cases: report.checks.map((c) => caseFromCheck(c, report.target, times)) })
  }

  let tests = 0
  let failures = 0
  let errors = 0
  let skipped = 0
  let timeMs = 0
  for (const s of suites) {
    for (const c of s.cases) {
      tests++
      timeMs += c.timeMs
      if (c.status === 'fail') failures++
      else if (c.status === 'error') errors++
      else if (c.status === 'skip') skipped++
    }
  }

  const exitCode = exitCodeFor(report)
  const passed = exitCode === 0
  return {
    kind: report.$type,
    name,
    target,
    mode: report.mode,
    verifiedAt,
    seed,
    digest,
    passed,
    verdict: passed ? 'PASSED' : 'FAILED',
    exitCode,
    suites,
    tests,
    failures,
    errors,
    skipped,
    timeMs,
  }
}

// ---------------------------------------------------------------------------
// JUnit XML reporter
// ---------------------------------------------------------------------------

/** Escape for XML TEXT content (`&`, `<`, `>`). */
export function xmlText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Escape for an XML ATTRIBUTE value (adds `"` and `'` to the text set). */
export function xmlAttr(s: string): string {
  return xmlText(s).replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

/** First line of a detail, whitespace-collapsed and length-capped, for the
 * `message` attribute of <failure>/<error>. Never carries a raw newline. */
function messageOf(detail: string): string {
  const oneLine = detail.split(/\r?\n/, 1)[0]!.replace(/\s+/g, ' ').trim()
  return oneLine.length > 300 ? oneLine.slice(0, 297) + '…' : oneLine
}

function secs(ms: number): string {
  return (ms / 1000).toFixed(3)
}

export function junitXml(report: AnyRunReport): string {
  const m = toReporterModel(report)
  const out: string[] = ['<?xml version="1.0" encoding="UTF-8"?>']
  out.push(
    `<testsuites name="${xmlAttr(m.name)}" tests="${m.tests}" failures="${m.failures}" ` +
      `errors="${m.errors}" skipped="${m.skipped}" time="${secs(m.timeMs)}">`,
  )
  for (const s of m.suites) {
    let sf = 0
    let se = 0
    let ss = 0
    let st = 0
    for (const c of s.cases) {
      st += c.timeMs
      if (c.status === 'fail') sf++
      else if (c.status === 'error') se++
      else if (c.status === 'skip') ss++
    }
    out.push(
      `  <testsuite name="${xmlAttr(s.name)}" tests="${s.cases.length}" failures="${sf}" ` +
        `errors="${se}" skipped="${ss}" time="${secs(st)}">`,
    )
    for (const c of s.cases) {
      const attrs = `name="${xmlAttr(c.name)}" classname="${xmlAttr(c.classname)}" time="${secs(c.timeMs)}"`
      if (c.status === 'pass') {
        out.push(`    <testcase ${attrs}/>`)
      } else if (c.status === 'skip') {
        out.push(`    <testcase ${attrs}><skipped/></testcase>`)
      } else {
        const tag = c.status === 'error' ? 'error' : 'failure'
        out.push(
          `    <testcase ${attrs}><${tag} message="${xmlAttr(messageOf(c.detail))}">` +
            `${xmlText(c.detail)}</${tag}></testcase>`,
        )
      }
    }
    out.push('  </testsuite>')
  }
  out.push('</testsuites>')
  return out.join('\n') + '\n'
}

// ---------------------------------------------------------------------------
// JSON reporter — stable schema
// ---------------------------------------------------------------------------

export interface JsonReport {
  $report: 'api.qa.ci-run'
  schemaVersion: 1
  verifier: 'api.qa'
  verifierVersion: string
  kind: AnyRunReport['$type']
  name: string
  target: string
  mode: string
  verifiedAt: string
  seed: number
  digest?: string
  verdict: 'PASSED' | 'FAILED'
  passed: boolean
  exitCode: number
  totals: { tests: number; passed: number; failures: number; errors: number; skipped: number; timeMs: number }
  suites: Array<{
    name: string
    tests: number
    failures: number
    errors: number
    skipped: number
    timeMs: number
    cases: Array<{ id: string; name: string; status: CaseStatus; detail: string; timeMs: number }>
  }>
}

export function jsonReport(report: AnyRunReport): JsonReport {
  const m = toReporterModel(report)
  return {
    $report: 'api.qa.ci-run',
    schemaVersion: 1,
    verifier: 'api.qa',
    verifierVersion: VERIFIER_VERSION,
    kind: m.kind,
    name: m.name,
    target: m.target,
    mode: m.mode,
    verifiedAt: m.verifiedAt,
    seed: m.seed,
    ...(m.digest ? { digest: m.digest } : {}),
    verdict: m.verdict,
    passed: m.passed,
    exitCode: m.exitCode,
    totals: {
      tests: m.tests,
      passed: m.tests - m.failures - m.errors - m.skipped,
      failures: m.failures,
      errors: m.errors,
      skipped: m.skipped,
      timeMs: m.timeMs,
    },
    suites: m.suites.map((s) => {
      let sf = 0
      let se = 0
      let ss = 0
      let st = 0
      for (const c of s.cases) {
        st += c.timeMs
        if (c.status === 'fail') sf++
        else if (c.status === 'error') se++
        else if (c.status === 'skip') ss++
      }
      return {
        name: s.name,
        tests: s.cases.length,
        failures: sf,
        errors: se,
        skipped: ss,
        timeMs: st,
        cases: s.cases.map((c) => ({ id: c.id, name: c.name, status: c.status, detail: c.detail, timeMs: c.timeMs })),
      }
    }),
  }
}

export function jsonReportText(report: AnyRunReport): string {
  return JSON.stringify(jsonReport(report), null, 2) + '\n'
}

// ---------------------------------------------------------------------------
// Reporter selection (CLI glue, kept pure/testable here)
// ---------------------------------------------------------------------------

export type ReporterName = 'cli' | 'junit' | 'json'

export interface ReporterSpec {
  name: ReporterName
  /** Output path, or undefined to write to stdout. */
  out?: string
}

const KNOWN_REPORTERS: ReporterName[] = ['cli', 'junit', 'json']

/**
 * Resolve the requested reporters from CLI flags. `--reporter` is repeatable and
 * comma-splittable (Newman style). Output paths come from `--reporter-<name>-out`
 * (per reporter) or a single shared `--reporter-out` fallback. `cli` writes the
 * human/markdown output. Returns the ordered, de-duplicated reporter list.
 *
 * Throws on an unknown reporter name, or when a shared `--reporter-out` is used
 * with more than one FILE reporter (that would clobber one file with the other).
 */
export function resolveReporters(
  requested: string[],
  getFlag: (k: string) => string | undefined,
): ReporterSpec[] {
  const names: ReporterName[] = []
  for (const raw of requested) {
    for (const part of raw.split(',')) {
      const n = part.trim().toLowerCase()
      if (!n) continue
      if (!KNOWN_REPORTERS.includes(n as ReporterName)) {
        throw new Error(`unknown reporter "${n}" — choose from ${KNOWN_REPORTERS.join(', ')}`)
      }
      if (!names.includes(n as ReporterName)) names.push(n as ReporterName)
    }
  }
  const sharedOut = getFlag('reporter-out')
  const fileReporters = names.filter((n) => n !== 'cli')
  if (sharedOut && sharedOut !== 'true' && fileReporters.filter((n) => !getFlag(`reporter-${n}-out`)).length > 1) {
    throw new Error(
      'a single --reporter-out cannot serve multiple file reporters (they would clobber each other) — ' +
        'use per-reporter --reporter-junit-out / --reporter-json-out instead',
    )
  }
  return names.map((name) => {
    const perOut = getFlag(`reporter-${name}-out`)
    const out = perOut && perOut !== 'true' ? perOut : name !== 'cli' && sharedOut && sharedOut !== 'true' ? sharedOut : undefined
    return out ? { name, out } : { name }
  })
}
