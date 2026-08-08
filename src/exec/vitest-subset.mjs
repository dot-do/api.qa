/**
 * THE `api.qa/vitest@1` SUBSET HARNESS — the one shared implementation.
 *
 * AXP A.8.6.2 (apis-ax-axp@2.4.0, spec digest dd3e5941…) is normative here:
 * "the hosted verifier's harness and the local CLI runner MUST share ONE
 * implementation of the subset — one module, never a reimplementation." This
 * file IS that module. It is deliberately:
 *
 *   - SELF-CONTAINED — zero imports, so its exact bytes can be injected
 *     verbatim into a Cloudflare Worker Loader isolate's module map (the
 *     hosted runner) AND instantiated from the identical bytes via a
 *     `data:text/javascript` import (the local CLI runner and the tests).
 *     `src/exec/vitest-subset-source.ts` carries these bytes as a generated
 *     string constant (node scripts/gen-vitest-subset.mjs); a pinning test
 *     fails the build if the two ever drift by a byte.
 *   - PLAIN .mjs, not TypeScript — the artifact both hosts execute is the
 *     artifact in the repo; there is no compile step between what is reviewed
 *     and what runs inside the isolate.
 *
 * WHAT IT IMPLEMENTS — the guaranteed subset, and only that:
 *   describe / it (async-aware, ES2022) / expect with the core matchers
 *   (equality, comparison, truthiness, containment, shape, rejects/resolves,
 *   and `.not` over all of them). `test` is an alias of `it`, as in vitest.
 *
 * WHAT FAILS BY NAME — the constructs A.8.6.2 places outside the subset must
 * fail "by a named reason, never by silently diverging":
 *   - snapshot matchers (`toMatchSnapshot`, `toMatchInlineSnapshot`) throw
 *     naming the matcher — a snapshot is state outside the pinned document;
 *   - the whole `vi` surface (mocking, fake timers) is a poisoned proxy: ANY
 *     property access throws naming `vi.<symbol>`;
 *   - an unknown matcher is an ordinary TypeError naming the property, which
 *     is the same named failure an unmodified local vitest produces for a
 *     typo'd matcher.
 * Import-specifier closure, `eval`/`new Function`/dynamic-`import()` refusal,
 * the network floor, and seeded `Math.random` are the INSTANTIATOR's duties
 * (src/exec/dialect.ts locally; the isolate entry + gateway hosted) — they
 * gate what surrounds the module, not what the subset API itself does.
 *
 * The verdict is never computed here: `run()` returns raw per-test results
 * (name, pass/fail, duration, named reason, in REGISTRATION order — A.8.6.4
 * sequential politeness) and the caller judges. The suite cannot vote on its
 * own outcome through any export of this module.
 */

/** The dialect this harness implements. */
export const SUBSET_RUNNER = 'api.qa/vitest@1'

/** Names installed as globals in the document form (A.8.6.2). */
export const SUBSET_GLOBALS = ['describe', 'it', 'test', 'expect', 'vi']

/**
 * Deterministic PRNG (mulberry32) — the A.8.6.4 seeded `Math.random`
 * replacement. It lives IN the shared harness module so the hosted isolate
 * entry and the local runner derive randomness from the same bytes: a replay
 * under the recorded seed and the recorded digest is the same run, in either
 * host. (Same algorithm the verifier's own probe sampling uses.)
 */
export function seededRandom(seed) {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// --------------------------------------------------------------------------
// Deep equality (toEqual / toStrictEqual / toContainEqual / toMatchObject)
// --------------------------------------------------------------------------

function isPlainObjectLike(v) {
  return v !== null && typeof v === 'object'
}

function deepEqual(a, b) {
  if (Object.is(a, b)) return true
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime()
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false
    return true
  }
  if (!isPlainObjectLike(a) || !isPlainObjectLike(b)) return false
  const ka = Object.keys(a).filter((k) => a[k] !== undefined)
  const kb = Object.keys(b).filter((k) => b[k] !== undefined)
  if (ka.length !== kb.length) return false
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false
    if (!deepEqual(a[k], b[k])) return false
  }
  return true
}

/** Subset-shape match: every key in `shape` must deep-match in `actual`. */
function matchesShape(actual, shape) {
  if (!isPlainObjectLike(actual) || !isPlainObjectLike(shape)) return deepEqual(actual, shape)
  if (Array.isArray(shape)) {
    if (!Array.isArray(actual) || actual.length !== shape.length) return false
    for (let i = 0; i < shape.length; i++) if (!matchesShape(actual[i], shape[i])) return false
    return true
  }
  for (const k of Object.keys(shape)) {
    if (!(k in actual)) return false
    if (!matchesShape(actual[k], shape[k])) return false
  }
  return true
}

function show(v) {
  if (typeof v === 'string') return JSON.stringify(v)
  if (typeof v === 'function') return '[function]'
  if (typeof v === 'bigint') return `${v}n`
  try {
    const s = JSON.stringify(v)
    return s === undefined ? String(v) : s.length > 200 ? s.slice(0, 200) + '…' : s
  } catch {
    return String(v)
  }
}

// --------------------------------------------------------------------------
// expect
// --------------------------------------------------------------------------

function readPath(obj, path) {
  const segs = Array.isArray(path) ? path : String(path).split('.')
  let cur = obj
  for (const s of segs) {
    if (cur === null || cur === undefined) return { found: false }
    if (!(typeof cur === 'object' && (s in cur))) return { found: false }
    cur = cur[s]
  }
  return { found: true, value: cur }
}

function makeExpect() {
  /** name → (actual, args) → { pass, message } */
  const matchers = {
    toBe: (a, [e]) => ({
      pass: Object.is(a, e),
      message: `expected ${show(a)} to be ${show(e)} (Object.is)`,
    }),
    toEqual: (a, [e]) => ({
      pass: deepEqual(a, e),
      message: `expected ${show(a)} to deeply equal ${show(e)}`,
    }),
    toStrictEqual: (a, [e]) => ({
      pass: deepEqual(a, e),
      message: `expected ${show(a)} to strictly equal ${show(e)}`,
    }),
    toMatchObject: (a, [shape]) => ({
      pass: matchesShape(a, shape),
      message: `expected ${show(a)} to match object ${show(shape)}`,
    }),
    toBeTruthy: (a) => ({ pass: !!a, message: `expected ${show(a)} to be truthy` }),
    toBeFalsy: (a) => ({ pass: !a, message: `expected ${show(a)} to be falsy` }),
    toBeNull: (a) => ({ pass: a === null, message: `expected ${show(a)} to be null` }),
    toBeUndefined: (a) => ({ pass: a === undefined, message: `expected ${show(a)} to be undefined` }),
    toBeDefined: (a) => ({ pass: a !== undefined, message: `expected value to be defined` }),
    toBeNaN: (a) => ({ pass: Number.isNaN(a), message: `expected ${show(a)} to be NaN` }),
    toBeInstanceOf: (a, [c]) => ({
      pass: a instanceof c,
      message: `expected value to be an instance of ${c && c.name ? c.name : show(c)}`,
    }),
    toContain: (a, [e]) => ({
      pass:
        typeof a === 'string'
          ? a.includes(e)
          : Array.isArray(a)
            ? a.some((x) => Object.is(x, e))
            : false,
      message: `expected ${show(a)} to contain ${show(e)}`,
    }),
    toContainEqual: (a, [e]) => ({
      pass: Array.isArray(a) && a.some((x) => deepEqual(x, e)),
      message: `expected ${show(a)} to contain an item deeply equal to ${show(e)}`,
    }),
    toHaveLength: (a, [n]) => ({
      pass: a != null && a.length === n,
      message: `expected length ${a == null ? '(none)' : show(a.length)} to be ${show(n)}`,
    }),
    toHaveProperty: (a, [path, ...rest]) => {
      const r = readPath(a, path)
      const pass = r.found && (rest.length === 0 || deepEqual(r.value, rest[0]))
      return {
        pass,
        message:
          rest.length === 0
            ? `expected ${show(a)} to have property ${show(path)}`
            : `expected property ${show(path)} (${r.found ? show(r.value) : 'absent'}) to equal ${show(rest[0])}`,
      }
    },
    toMatch: (a, [e]) => ({
      pass: typeof a === 'string' && (e instanceof RegExp ? e.test(a) : a.includes(String(e))),
      message: `expected ${show(a)} to match ${e instanceof RegExp ? String(e) : show(e)}`,
    }),
    toBeGreaterThan: (a, [e]) => ({ pass: a > e, message: `expected ${show(a)} > ${show(e)}` }),
    toBeGreaterThanOrEqual: (a, [e]) => ({ pass: a >= e, message: `expected ${show(a)} >= ${show(e)}` }),
    toBeLessThan: (a, [e]) => ({ pass: a < e, message: `expected ${show(a)} < ${show(e)}` }),
    toBeLessThanOrEqual: (a, [e]) => ({ pass: a <= e, message: `expected ${show(a)} <= ${show(e)}` }),
    toBeCloseTo: (a, [e, digits]) => {
      const d = digits === undefined ? 2 : digits
      return {
        pass: Math.abs(a - e) < Math.pow(10, -d) / 2,
        message: `expected ${show(a)} to be close to ${show(e)} (${d} digits)`,
      }
    },
    toThrow: (a, [e]) => {
      // `a` is the thrown error when reached via .rejects, else a function.
      let threw = false
      let err
      if (typeof a === 'function') {
        try {
          a()
        } catch (thrown) {
          threw = true
          err = thrown
        }
      } else {
        threw = true
        err = a
      }
      if (!threw) return { pass: false, message: 'expected function to throw, but it did not' }
      const msg = err instanceof Error ? err.message : String(err)
      const pass =
        e === undefined
          ? true
          : e instanceof RegExp
            ? e.test(msg)
            : typeof e === 'string'
              ? msg.includes(e)
              : typeof e === 'function'
                ? err instanceof e
                : false
      return { pass, message: `expected thrown ${show(msg)} to match ${e instanceof RegExp ? String(e) : show(e)}` }
    },
  }

  // Snapshot matchers are OUTSIDE the subset (A.8.6.2): a snapshot is state
  // outside the pinned document. They fail with the matcher NAMED — in the
  // hosted isolate and under the local runner alike.
  for (const name of ['toMatchSnapshot', 'toMatchInlineSnapshot', 'toMatchFileSnapshot']) {
    matchers[name] = () => {
      throw new Error(
        `${name} is outside the api.qa/vitest@1 subset — snapshot state cannot live inside a digest-pinned suite`,
      )
    }
  }

  function applyMatcher(name, actual, args, negated) {
    const m = matchers[name]
    const { pass, message } = m(actual, args)
    if (negated ? pass : !pass) {
      throw new Error(negated ? `${name}: NOT expected — ${message}` : `${name}: ${message}`)
    }
  }

  function chain(actual, negated) {
    const target = {}
    for (const name of Object.keys(matchers)) {
      target[name] = (...args) => applyMatcher(name, actual, args, negated)
    }
    Object.defineProperty(target, 'not', { get: () => chain(actual, !negated) })
    // Async assertion chains (A.8.6.2 rejects/resolves): every matcher becomes
    // a Promise-returning form the test MUST await.
    Object.defineProperty(target, 'resolves', {
      get: () => asyncChain(Promise.resolve(actual), false, negated),
    })
    Object.defineProperty(target, 'rejects', {
      get: () => asyncChain(Promise.resolve(actual), true, negated),
    })
    return target
  }

  function asyncChain(promise, expectRejection, negated) {
    const target = {}
    for (const name of Object.keys(matchers)) {
      target[name] = async (...args) => {
        let settled
        let rejected = false
        try {
          settled = await promise
        } catch (err) {
          rejected = true
          settled = err
        }
        if (expectRejection && !rejected) {
          throw new Error(`rejects.${name}: expected promise to reject, but it resolved with ${show(settled)}`)
        }
        if (!expectRejection && rejected) {
          const msg = settled instanceof Error ? settled.message : String(settled)
          throw new Error(`resolves.${name}: expected promise to resolve, but it rejected with ${show(msg)}`)
        }
        applyMatcher(name, settled, args, negated)
      }
    }
    Object.defineProperty(target, 'not', { get: () => asyncChain(promise, expectRejection, !negated) })
    return target
  }

  return (actual) => chain(actual, false)
}

// --------------------------------------------------------------------------
// The vi poison — the whole mocking/timers surface fails by name (A.8.6.2)
// --------------------------------------------------------------------------

function makeViPoison() {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        throw new Error(
          `vi.${String(prop)} is outside the api.qa/vitest@1 subset — module mocking and fake timers ` +
            'have no meaning against a digest-pinned suite run over the network',
        )
      },
    },
  )
}

// --------------------------------------------------------------------------
// The harness — registration + sequential run
// --------------------------------------------------------------------------

/**
 * Create one harness instance for one run. `api` carries the subset surface
 * (`describe`, `it`, `test`, `expect`, plus the poisoned `vi`); `run()`
 * executes every registered test SEQUENTIALLY in registration order (A.8.6.4)
 * and resolves to raw results the CALLER judges.
 */
export function createHarness() {
  const tests = [] // { name, fn } in registration order
  const path = [] // current describe nesting
  let running = false

  function describe(name, fn) {
    if (running) throw new Error('describe() called while the run is already executing')
    path.push(String(name))
    try {
      const r = fn()
      if (r && typeof r.then === 'function') {
        throw new Error('an async describe body is outside the api.qa/vitest@1 subset — register tests synchronously')
      }
    } finally {
      path.pop()
    }
  }

  function it(name, fn) {
    if (running) throw new Error('it() called while the run is already executing')
    if (typeof fn !== 'function') {
      throw new Error(`it(${show(name)}) registered without a test function`)
    }
    tests.push({ name: [...path, String(name)].join(' > '), fn })
  }

  const api = {
    describe,
    it,
    test: it,
    expect: makeExpect(),
    vi: makeViPoison(),
  }

  async function run() {
    running = true
    const results = []
    for (const t of tests) {
      const started = Date.now()
      try {
        await t.fn()
        results.push({ name: t.name, status: 'pass', durationMs: Date.now() - started })
      } catch (err) {
        results.push({
          name: t.name,
          status: 'fail',
          durationMs: Date.now() - started,
          reason: err instanceof Error ? err.message : String(err),
        })
      }
    }
    return { registered: tests.length, results }
  }

  return {
    api,
    run,
    get registered() {
      return tests.length
    },
  }
}
