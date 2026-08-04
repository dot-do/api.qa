/**
 * The vitest matcher — run api.qa's conformance gate INSIDE a vitest suite,
 * in-process, against a Worker-style handler or a URL:
 *
 *   import 'autonomous-qa/vitest'            // registers the matchers (side-effect)
 *   import worker from '../src/worker.js'
 *   import spec from '../spec/pinned.json?raw'
 *
 *   it('conforms to the pinned contract', async () => {
 *     await expect(worker).toConform(spec)   // gradePinned() must pass
 *   })
 *   it('grades at least B', async () => {
 *     await expect(worker).toGradeAtLeast('B')
 *   })
 *
 * ⚠️  BOTH MATCHERS ARE ASYNC — YOU MUST `await` THE ASSERTION. ⚠️
 *
 *   await expect(worker).toConform(spec)        // correct
 *   await expect(worker).toGradeAtLeast('B')    // correct
 *   expect(worker).toConform(spec)              // WRONG — silently ignored!
 *
 * `expect(...).toConform(...)` / `.toGradeAtLeast(...)` each return a Promise.
 * If the test function does not `await` (or `return`) that promise, vitest
 * moves on immediately: the test is recorded as PASSED before the grading
 * even finishes, and a LATER rejection (the assertion actually failing) can
 * surface only as an unhandled-rejection warning — attributed to nothing, or
 * to the wrong test, and easy to miss in CI output. A forgotten `await` is
 * therefore a SILENT FALSE-GREEN: a real conformance failure reports as a
 * passing test. There is no way for the matcher itself to detect a missing
 * `await` (a synchronous matcher can throw immediately; an async one cannot
 * force the caller to wait on it) — the safe pattern is on YOU: always
 * `await` (or `return`) the `expect(...)` call, and prefer the `assertConforms`
 * / `assertGradeAtLeast` helpers below when you want a shape that makes a
 * missing `await` obvious (they return `Promise<void>` and are useless
 * un-awaited, rather than a fluent `expect(...)` chain that reads fine either
 * way).
 *
 * They dispatch every probe to the handler IN MEMORY (no socket), so the gate
 * the deployed api.qa runs against your PUBLIC origin also runs against your
 * worker pre-deploy.
 *
 * SSRF: these matchers grade a handler in-memory (`allowPrivate` stays false) or
 * a URL you explicitly pass with `{ allowPrivate: true }` for a local dev
 * server. A remote URL target is graded exactly as the deployed grader would —
 * private/metadata hosts stay blocked. See src/local.ts.
 */

import { expect } from 'vitest'
import { grade, gradePinned, type GradeTarget, type GradeOpts, type GradePinnedOpts } from './local.js'
import { gradeRank } from './grade.js'
import type { Grade } from './types.js'

/** A spec argument: the pinned-spec TEXT, or `{ spec, expectedDigest }`. */
export type ConformSpec = string | { spec: string; expectedDigest?: string }

interface MatcherResult {
  pass: boolean
  message: () => string
}

function specText(spec: ConformSpec): string {
  return typeof spec === 'string' ? spec : spec.spec
}

function specDigest(spec: ConformSpec): string | undefined {
  return typeof spec === 'string' ? undefined : spec.expectedDigest
}

/**
 * `expect(target).toConform(spec?)`.
 *   - WITH a pinned spec → gradePinned(); passes iff every requirement passed.
 *   - WITHOUT a spec     → grade(); passes iff no check actively FAILED (the
 *     surface never lies/violates). Use `toGradeAtLeast` for a threshold.
 */
async function toConform(
  received: GradeTarget,
  spec?: ConformSpec,
  opts: GradePinnedOpts = {},
): Promise<MatcherResult> {
  if (spec !== undefined) {
    const report = await gradePinned(received, specText(spec), {
      ...opts,
      expectedDigest: specDigest(spec) ?? opts.expectedDigest,
    })
    const failed = report.requirements.filter((r) => r.verdict === 'fail')
    return {
      pass: report.passed,
      message: () =>
        report.passed
          ? `expected target NOT to conform to pinned spec "${report.spec.name}@${report.spec.version}", but it did`
          : `expected target to conform to pinned spec "${report.spec.name}@${report.spec.version}", but ${failed.length} requirement(s) failed:\n` +
            failed.map((r) => `  ✗ ${r.id}: ${r.detail}`).join('\n'),
    }
  }
  const report = await grade(received, opts)
  const failed = report.checks.filter((c) => c.verdict === 'fail')
  return {
    pass: failed.length === 0,
    message: () =>
      failed.length === 0
        ? `expected target NOT to conform, but no check failed (grade ${report.grade}, ${report.axScore.points}/${report.axScore.max})`
        : `expected target to conform, but ${failed.length} check(s) failed (grade ${report.grade}):\n` +
          failed.map((c) => `  ✗ ${c.id}: ${c.detail}`).join('\n'),
  }
}

/** `expect(target).toGradeAtLeast('B')` — passes iff grade >= the given grade. */
async function toGradeAtLeast(
  received: GradeTarget,
  minimum: Grade,
  opts: GradeOpts = {},
): Promise<MatcherResult> {
  const report = await grade(received, opts)
  const got = gradeRank(report.grade)
  const want = gradeRank(minimum)
  const pass = got >= want
  return {
    pass,
    message: () =>
      pass
        ? `expected target NOT to grade at least ${minimum}, but it graded ${report.grade} (${report.axScore.points}/${report.axScore.max})`
        : `expected target to grade at least ${minimum}, but it graded ${report.grade} (${report.axScore.points}/${report.axScore.max})`,
  }
}

/**
 * `await assertConforms(target, spec?, opts?)` — an AWAIT-ONLY alternative to
 * `expect(target).toConform(spec)` for callers who want the missing-`await`
 * footgun documented above to be as hard as possible to trip over: this is a
 * plain async function that resolves to `void` and THROWS on a failing
 * conformance check (same failure detail as the matcher's message). It has no
 * other use un-awaited — there is no fluent chain to read past, no `pass`
 * value to accidentally ignore — so a reviewer (or the "floating promise"
 * lint many projects already run) has an obvious, single thing to check:
 * is this call awaited.
 *
 *   await assertConforms(worker, spec)   // throws with a detailed message on failure
 *
 * Runs the exact same gate as `toConform` (in fact, delegates to it).
 */
export async function assertConforms(
  received: GradeTarget,
  spec?: ConformSpec,
  opts: GradePinnedOpts = {},
): Promise<void> {
  const result = await toConform(received, spec, opts)
  if (!result.pass) throw new Error(result.message())
}

/**
 * `await assertGradeAtLeast(target, minimum, opts?)` — the `assertConforms`
 * counterpart for the grade-threshold check. See `assertConforms` for why this
 * shape exists alongside `expect(target).toGradeAtLeast(minimum)`.
 */
export async function assertGradeAtLeast(
  received: GradeTarget,
  minimum: Grade,
  opts: GradeOpts = {},
): Promise<void> {
  const result = await toGradeAtLeast(received, minimum, opts)
  if (!result.pass) throw new Error(result.message())
}

expect.extend({ toConform, toGradeAtLeast })

// --- TS augmentation so `.toConform` / `.toGradeAtLeast` type-check ----------
interface ApiQaMatchers<R = unknown> {
  toConform(spec?: ConformSpec, opts?: GradePinnedOpts): Promise<R>
  toGradeAtLeast(minimum: Grade, opts?: GradeOpts): Promise<R>
}

declare module 'vitest' {
  /* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-empty-object-type */
  interface Assertion<T = any> extends ApiQaMatchers<T> {}
  interface AsymmetricMatchersContaining extends ApiQaMatchers {}
  /* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-empty-object-type */
}

export {}
