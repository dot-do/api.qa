/**
 * The vitest integration — run api.qa's conformance gate INSIDE a vitest
 * suite, in-process, against a Worker-style handler or a URL.
 *
 *   import 'autonomous-qa/vitest'            // registers the matchers (side-effect)
 *   import worker from '../src/worker.js'
 *   import spec from '../spec/pinned.json?raw'
 *
 *   it('conforms to the pinned contract', async () => {
 *     await expect(worker).toConform(spec)   // gradePinned() must pass
 *   })
 *
 * Or expand every pinned requirement into its own test case:
 *
 *   describeConformance({ target: worker, spec, expectedDigest })
 *
 * ⚠️  THE MATCHERS ARE ASYNC — ALWAYS `await` THE ASSERTION. ⚠️  An un-awaited
 * `expect(worker).toConform(spec)` is a silent false-green: vitest records the
 * test as passed before grading finishes. Prefer `assertConforms` (from
 * `autonomous-qa/assert`, re-exported here) when you want the missing-`await`
 * footgun to be visible: it resolves to void and is useless un-awaited.
 *
 * ## Where this module loads
 *
 * This module has NO top-level import of 'vitest'. That is deliberate:
 * @cloudflare/vitest-pool-workers runs test files inside workerd and
 * externalizes node_modules, so a package that does
 * `import { expect } from 'vitest'` fails to link there
 * ("The requested module 'vitest' does not provide an export named 'expect'").
 * The matchers and `describeConformance` instead take the vitest API from,
 * in order:
 *   1. an explicit argument — `registerConformanceMatchers(expect)`,
 *      `describeConformance(opts, { describe, it, expect, beforeAll })`;
 *   2. vitest globals (`test.globals: true`) on `globalThis`;
 *   3. for matcher registration only, a lazy `import('vitest')` at module
 *      load — works in Node, is caught and ignored where it cannot resolve.
 *
 * So `import 'autonomous-qa/vitest'` keeps registering the matchers in a Node
 * vitest project, and in the Workers pool you either enable globals or pass
 * the API explicitly. `assertConforms` needs none of this.
 *
 * SSRF: these matchers grade a handler in-memory (`allowPrivate` stays false) or
 * a URL you explicitly pass with `{ allowPrivate: true }` for a local dev
 * server. A remote URL target is graded exactly as the deployed grader would —
 * private/metadata hosts stay blocked. See src/local.ts.
 */
import type { ExpectStatic } from 'vitest'
import type { GradeTarget, GradeOpts, GradePinnedOpts } from './local.js'
import { gradePinned } from './local.js'
import { parsePinnedSpec } from './pinned.js'
import type { Grade } from './types.js'
import {
  conformance,
  gradeAtLeast,
  specDigest,
  specText,
  type ConformSpec,
  type ConformanceOutcome,
} from './assert.js'

export { assertConforms, assertGradeAtLeast, conformance, gradeAtLeast } from './assert.js'
export type { ConformSpec, ConformanceOutcome } from './assert.js'

interface MatcherResult {
  pass: boolean
  message: () => string
}

const asMatcher = (o: ConformanceOutcome): MatcherResult => ({ pass: o.pass, message: o.message })

/** `expect(target).toConform(spec?)` — see `conformance()` for the rule. */
async function toConform(
  received: GradeTarget,
  spec?: ConformSpec,
  opts: GradePinnedOpts = {},
): Promise<MatcherResult> {
  return asMatcher(await conformance(received, spec, opts))
}

/** `expect(target).toGradeAtLeast('B')` — passes iff grade >= the given grade. */
async function toGradeAtLeast(
  received: GradeTarget,
  minimum: Grade,
  opts: GradeOpts = {},
): Promise<MatcherResult> {
  return asMatcher(await gradeAtLeast(received, minimum, opts))
}

/** The matcher implementations, for hosts that register them themselves. */
export const conformanceMatchers = { toConform, toGradeAtLeast }

type ExpectLike = Pick<ExpectStatic, 'extend'>

const REGISTERED = Symbol.for('autonomous-qa.matchers')

const globalExpect = (): ExpectLike | undefined => {
  const e = (globalThis as { expect?: unknown }).expect
  return e && typeof (e as ExpectLike).extend === 'function' ? (e as ExpectLike) : undefined
}

/**
 * Register `toConform` / `toGradeAtLeast` on a vitest `expect`. Idempotent.
 * Pass `expect` explicitly inside the Cloudflare Workers pool (or enable
 * `test.globals`); in Node the module-load side effect below already did it.
 * Returns true when registration happened (now or earlier), false when no
 * `expect` was available.
 */
export function registerConformanceMatchers(expect?: ExpectLike): boolean {
  const target = expect ?? globalExpect()
  if (!target) return false
  const marked = target as ExpectLike & { [REGISTERED]?: true }
  if (marked[REGISTERED]) return true
  target.extend(conformanceMatchers)
  marked[REGISTERED] = true
  return true
}

/**
 * Resolves once the module-load registration attempt has settled. Await it in
 * a `beforeAll` if a test could conceivably run before the lazy import lands
 * (in practice vitest collects every file before running any test).
 */
export const matchersReady: Promise<boolean> = (async () => {
  if (registerConformanceMatchers()) return true
  try {
    // Dynamic so the specifier is never linked at module load: in Node vitest
    // this resolves the running vitest; in workerd it rejects and we fall
    // through to explicit registration or globals.
    const mod = (await import('vitest')) as { expect?: ExpectLike }
    return registerConformanceMatchers(mod.expect)
  } catch {
    return false
  }
})()

// --- describeConformance -----------------------------------------------------

/** The slice of the vitest API `describeConformance` needs. */
export interface VitestApi {
  describe: (name: string, fn: () => void) => unknown
  it: (name: string, fn: () => unknown | Promise<unknown>, timeout?: number) => unknown
  beforeAll: (fn: () => unknown | Promise<unknown>, timeout?: number) => unknown
  expect: ExpectLike & ((actual: unknown) => { toBe(expected: unknown): unknown })
}

export interface DescribeConformanceOpts extends GradePinnedOpts {
  /** A Worker module / handler (graded in memory) or a URL (with `allowPrivate` for dev). */
  target: GradeTarget
  /** Pinned-spec text, or `{ spec, expectedDigest }`. */
  spec: ConformSpec
  /** Suite title. Default: `AXP conformance — <name>@<version>`. */
  name?: string
  /** Timeout for the single grading pass, ms. Default 60_000. */
  timeout?: number
}

const globalApi = (): VitestApi | undefined => {
  const g = globalThis as Partial<VitestApi>
  return g.describe && g.it && g.beforeAll && g.expect
    ? ({ describe: g.describe, it: g.it, beforeAll: g.beforeAll, expect: g.expect } as VitestApi)
    : undefined
}

/**
 * Expand every requirement of a pinned spec into its own vitest case:
 *
 *   describeConformance({ target: worker, spec, expectedDigest })
 *
 * One grading pass runs in `beforeAll` (the digest is checked BEFORE any probe
 * fires — a drifted spec fails the whole block); then one `it` per pinned
 * requirement reports pass / fail / not-applicable individually, plus a final
 * `it` asserting the report as a whole passed. Requirement ids are stable
 * across the digest pin, so a CI history reads per requirement.
 *
 * The vitest API comes from the explicit `api` argument, else from vitest
 * globals; without either this throws immediately with the fix.
 */
export function describeConformance(opts: DescribeConformanceOpts, api?: VitestApi): void {
  const vt = api ?? globalApi()
  if (!vt) {
    throw new Error(
      "describeConformance: no vitest API available — pass { describe, it, beforeAll, expect } from 'vitest' as the second argument, or enable test.globals",
    )
  }
  const { target, spec, name, timeout = 60_000, ...gradeOpts } = opts
  const text = specText(spec)
  const pinned = parsePinnedSpec(text) // sync, so requirement ids are known at collection time
  const expectedDigest = specDigest(spec) ?? gradeOpts.expectedDigest
  const title = name ?? `AXP conformance — ${pinned.name}@${pinned.version}`

  vt.describe(title, () => {
    let report: Awaited<ReturnType<typeof gradePinned>> | undefined
    let failure: unknown
    vt.beforeAll(async () => {
      try {
        report = await gradePinned(target, text, { ...gradeOpts, expectedDigest })
      } catch (err) {
        failure = err
      }
    }, timeout)

    const ready = () => {
      if (failure) throw failure instanceof Error ? failure : new Error(String(failure))
      if (!report) throw new Error('describeConformance: grading did not run')
      return report
    }

    if (expectedDigest) {
      vt.it(`spec digest is pinned at ${expectedDigest.slice(0, 12)}…`, () => {
        vt.expect(ready().spec.digest).toBe(expectedDigest)
      })
    }

    for (const req of pinned.requirements) {
      const label = req.kind === 'check' ? `${req.id} (${req.check})` : req.kind === 'surface' ? `${req.id} (${req.surface})` : req.id
      vt.it(label, () => {
        const r = ready().requirements.find((x) => x.id === req.id)
        if (!r) throw new Error(`requirement ${req.id} produced no verdict`)
        if (r.verdict === 'fail') throw new Error(`${r.id}: ${r.detail}`)
      })
    }

    vt.it('every pinned requirement passes', () => {
      const r = ready()
      const failed = r.requirements.filter((x) => x.verdict === 'fail').map((x) => `${x.id}: ${x.detail}`)
      vt.expect(failed).toBe(failed.length === 0 ? failed : `no failures, got:\n${failed.join('\n')}`)
      vt.expect(r.passed).toBe(true)
    })
  })
}

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
