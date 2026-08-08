/**
 * The `api.qa/vitest@1` DIALECT LAYER — everything that surrounds the shared
 * subset harness (src/exec/vitest-subset.mjs) when a pinned suite's code
 * actually runs: source validation, the network floor, the gated fetch, and
 * the LOCAL instantiation path.
 *
 * AXP A.8.6 (apis-ax-axp@2.4.0, spec digest dd3e5941…) is the contract:
 *
 *   - IMPORTS ARE CLOSED (A.8.6.2) to exactly `"vitest"` (the shared subset),
 *     `"suite:env"` ({origin, vars, seed, sandbox}), and `"suite:module"`
 *     (document form with a `module` member only). Everything else — `node:`
 *     built-ins, bare package specifiers, dynamic `import()`, `eval`,
 *     `new Function` — MUST fail by a NAMED reason, identically under the
 *     hosted runner and the local CLI. `validateDialectSource` is that shared
 *     refusal: one function, both hosts, so the two cannot diverge.
 *
 *   - THE NETWORK FLOOR (A.8.6.3) refuses cloud-metadata, link-local,
 *     loopback, RFC 1918, CGNAT, ULA, and estate-internal destinations —
 *     re-checked per redirect hop — and permits EVERY other publicly-routable
 *     destination. Full external egress is a FEATURE of the dialect
 *     (cross-estate composition); the rejected graded-origin-only draft is
 *     exactly what this module must not reintroduce.
 *
 *   - MUTATING VERBS are environment-gated (A.8.6.4): permitted only when the
 *     selected environment declares `"sandbox": true` in the pinned document;
 *     a module artifact carries only the implicit non-sandbox `"public"`.
 *
 *   - SEEDED DETERMINISM (A.8.6.4): `Math.random` is replaced by a generator
 *     derived from the run seed, and the same seed is exported by
 *     `"suite:env"`.
 *
 *   - FAIL-CLOSED TOTALITY (A.8.6.3): a floor refusal, a verb refusal, a
 *     breaker trip, or a cap breach fails the RUN by a named reason — even if
 *     the suite caught the thrown refusal — never a pass over the remainder.
 *
 * The local instantiation executes THE SAME BYTES the hosted isolate would:
 * the harness from `VITEST_SUBSET_SOURCE`, the suite from the digest-matched
 * buffer, both loaded as real ES modules via `data:` imports with the closed
 * specifiers rewritten to generated shim modules. There is no transpile and
 * no reimplementation — local==hosted by construction.
 */

import { isPrivateHost } from '../http.js'
import { VITEST_SUBSET_SOURCE } from './vitest-subset-source.js'

/** The executable suite dialect (A.8.6). */
export const VITEST_RUNNER = 'api.qa/vitest@1'

// ---------------------------------------------------------------------------
// The abuse circuit-breakers (A.8.6.1 / A.8.6.3) — NEVER rations. The paid
// tier is the gate on the capability; each number is sized so no legitimate
// suite meets it, and what bounds a legitimate run is the billed breaker.
// ---------------------------------------------------------------------------

/** Metered circuit-breaker defaults: 5 minutes wall, 1 minute CPU (account-raisable). */
export const EXEC_WALL_MS = 300_000
export const EXEC_CPU_MS = 60_000
/** Declarative rows + registered tests COMBINED (A.8.6.1). */
export const EXEC_MAX_COMBINED = 1000
/** The served suite DOCUMENT (A.8.6.1). */
export const EXEC_MAX_DOC_BYTES = 1_048_576
/** A pinned MODULE artifact (an SDK entry is a bundle) (A.8.6.3). */
export const EXEC_MAX_MODULE_BYTES = 4_194_304
/** Captured output — results, messages, logs (A.8.6.3). */
export const EXEC_MAX_OUTPUT_BYTES = 4_194_304
/** Redirect hops the gated fetch will follow, each re-floored. */
export const EXEC_MAX_REDIRECTS = 5

// ---------------------------------------------------------------------------
// Source validation — the closed import surface, shared by both hosts
// ---------------------------------------------------------------------------

/** Static import/re-export specifier scan: `from '<spec>'` and `import '<spec>'`. */
const SPECIFIER_RE = /(\bfrom\s*|\bimport\s*)(["'])([^"']*)\2/g

const FORBIDDEN_CONSTRUCTS: Array<[RegExp, string]> = [
  // Dynamic import() resolves at run time, outside the pinned module map.
  [/\bimport\s*\(/, 'dynamic import()'],
  // Runtime code generation: the only code that runs is code the digest covers.
  [/\beval\s*\(/, 'eval'],
  [/\bnew\s+Function\b/, 'new Function'],
]

export type SourceValidation = { ok: true; specifiers: string[] } | { ok: false; problem: string }

/**
 * Validate a dialect module source against the closed surface of A.8.6.2.
 * PURELY textual and deliberately conservative: a forbidden token inside a
 * string literal is refused too — the refusal is identical under both hosts
 * (this one function), and the fail direction is closed, never open.
 *
 * `allowSuiteModule` — `"suite:module"` exists only in the document form when
 * the document carries a `module` member; anywhere else the specifier is
 * refused by name.
 */
export function validateDialectSource(
  source: string,
  opts: { allowSuiteModule: boolean; what: string },
): SourceValidation {
  for (const [re, name] of FORBIDDEN_CONSTRUCTS) {
    if (re.test(source)) {
      return {
        ok: false,
        problem:
          `${opts.what} uses ${name}, which is outside the api.qa/vitest@1 subset — the isolate disables ` +
          'runtime code generation; the only code that runs is code the digest covers (A.8.6.2)',
      }
    }
  }
  const allowed = new Set(['vitest', 'suite:env', ...(opts.allowSuiteModule ? ['suite:module'] : [])])
  const specifiers: string[] = []
  for (const m of source.matchAll(SPECIFIER_RE)) {
    const spec = m[3]!
    specifiers.push(spec)
    if (!allowed.has(spec)) {
      const why = spec.startsWith('node:')
        ? 'node: built-ins do not exist in the isolate'
        : spec === 'suite:module'
          ? 'the "suite:module" specifier exists only in a document that carries a `module` member'
          : /^[./]/.test(spec)
            ? 'relative/path imports cannot resolve inside a single pinned artifact'
            : 'bare package specifiers cannot resolve inside the isolate — bundle your dependencies into the pinned artifact'
      return {
        ok: false,
        problem:
          `${opts.what} imports ${JSON.stringify(spec)}, which is outside the api.qa/vitest@1 subset ` +
          `(${why}). Imports are closed to exactly "vitest", "suite:env"${opts.allowSuiteModule ? ', "suite:module"' : ''} (A.8.6.2).`,
      }
    }
  }
  return { ok: true, specifiers }
}

// ---------------------------------------------------------------------------
// The network floor (A.8.6.3) — and NOTHING above it
// ---------------------------------------------------------------------------

/**
 * True when the floor bars this hostname. Reuses `isPrivateHost` — the same
 * refusal set the whole verifier stands on (metadata 169.254.169.254 incl.
 * decimal/hex/octal encodings, link-local v4/v6, loopback, RFC 1918, ULA,
 * `*.internal` / `*.local` / `localhost`, and EVERY raw IP-literal host,
 * v4 or bracketed v6 — a public service is reached by NAME, and a literal is
 * exactly the shape every encoding bypass arrives in; over-broad only in the
 * closed direction) — plus
 * the floor's own additions: CGNAT 100.64.0.0/10 and every single-label
 * hostname (estate-internal service names are single-label; no public DNS
 * name is).
 *
 * Everything else is PERMITTED: the floor is the ONLY network restriction on
 * executable tests. No same-origin scoping — that drafted posture is recorded
 * in-spec as REJECTED.
 */
export function isFloorBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '')
  if (h.length === 0) return true
  if (isPrivateHost(h)) return true
  // CGNAT 100.64.0.0/10 (RFC 6598) — not in the verifier's private set, barred
  // by the floor explicitly.
  const cgnat = /^100\.(\d{1,3})\./.exec(h)
  if (cgnat !== null) {
    const second = Number(cgnat[1])
    if (second >= 64 && second <= 127) return true
  }
  // A single-label hostname is never a public DNS name; it is exactly the
  // shape of an estate-internal service hostname.
  if (!h.includes('.')) return true
  return false
}

/** A floor/verb refusal recorded at the fetch boundary. Fails the RUN. */
export interface GateViolation {
  url: string
  reason: string
}

export type GatedFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/**
 * Wrap a real fetch in the A.8.6.3 floor + the A.8.6.4 verb gate.
 *
 * Every request — and every redirect hop, followed MANUALLY so a hop can
 * never slip under the floor — is checked against `isFloorBlockedHost`.
 * A refusal is recorded in `violations` AND thrown: the throw fails the
 * calling test immediately, and the recording fails the RUN even if the suite
 * caught the throw (fail-closed totality — a suite cannot swallow a floor
 * refusal into a pass).
 *
 * Mutating verbs are permitted only when `sandbox` is true — the suite's own
 * pinned consent (A.8.6.4). A mutating request is never redirect-followed.
 */
export function createGatedFetch(opts: {
  realFetch: (url: string, init?: RequestInit) => Promise<Response>
  sandbox: boolean
  violations: GateViolation[]
}): GatedFetch {
  return async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const method = (
      init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')
    ).toUpperCase()

    const refuse = (reason: string): never => {
      opts.violations.push({ url, reason })
      throw new Error(reason)
    }

    if (method !== 'GET' && method !== 'HEAD' && !opts.sandbox) {
      refuse(
        `${method} ${url} refused: mutating verbs are permitted only against an environment the pinned ` +
          'suite itself declares "sandbox": true — this run\'s environment does not (A.8.6.4)',
      )
    }

    let current = url
    for (let hop = 0; ; hop++) {
      let host: string
      try {
        host = new URL(current).hostname
      } catch {
        refuse(`fetch refused: ${JSON.stringify(current)} is not a parseable absolute URL`)
        throw new Error('unreachable')
      }
      if (isFloorBlockedHost(host)) {
        refuse(
          `fetch toward ${current} refused by the network floor: metadata, link-local, loopback, ` +
            'private-range, CGNAT, ULA and estate-internal destinations are barred (A.8.6.3). ' +
            'Every other publicly-routable destination is permitted.',
        )
      }
      const res = await opts.realFetch(current, {
        method,
        headers: init?.headers as Record<string, string> | undefined,
        body: hop === 0 ? (init?.body as BodyInit | undefined) : undefined,
        redirect: 'manual',
      })
      const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null
      if (location === null) return res
      // A mutating redirect is returned verbatim: following it would re-issue
      // the write somewhere the suite never named.
      if (method !== 'GET' && method !== 'HEAD') return res
      if (hop >= EXEC_MAX_REDIRECTS) {
        throw new Error(`too many redirects (> ${EXEC_MAX_REDIRECTS}) from ${url}`)
      }
      try {
        current = new URL(location, current).toString()
      } catch {
        refuse(`fetch refused: unparseable redirect Location from ${current}`)
      }
      // Loop: the next hop's host is re-floored before any byte is fetched.
    }
  }
}

// ---------------------------------------------------------------------------
// Local instantiation — the same bytes the hosted isolate executes
// ---------------------------------------------------------------------------

/** One executed test's outcome, in registration order (A.8.6.5). */
export interface ExecTestResult {
  name: string
  status: 'pass' | 'fail'
  durationMs: number
  reason?: string
}

/** What the runner is asked to execute — already digest-matched by the caller. */
export interface ExecRunRequest {
  /** Discriminated by the CARD (A.8.5), never by sniffing. */
  artifactKind: 'document' | 'module'
  /** The tests source: the document's `tests` member, or the module bytes. */
  testsSource: string
  /** The document's optional `module` member (importable as "suite:module"). */
  moduleSource?: string
  /** Module artifact: named nullary export the harness calls to register. */
  exportName?: string
  /** The graded origin, exported by "suite:env". */
  origin: string
  /** Selected environment's vars (module artifact: {}). */
  vars: Record<string, unknown>
  environment: string
  sandbox: boolean
  seed: number
  /** Declarative row count, for the COMBINED cap (A.8.6.1). */
  declarativeRows: number
  /**
   * The card pin the executed bytes matched (`sha256:<64 hex>`). The caller
   * verified it BEFORE building this request (hash-then-instantiate — there
   * is no execute-then-check ordering); the hosted runner folds it into the
   * content-hash isolate id.
   */
  digest?: string
  limits?: { wallMs?: number; cpuMs?: number }
}

/** The typed outcome the judge reads. NEVER a thrown crash, NEVER a silent pass. */
export type ExecRunOutcome =
  | {
      status: 'ran'
      registered: number
      results: ExecTestResult[]
      appliedLimits: { wallMs: number; cpuMs: number }
      elapsedWallMs: number
      /** Milliseconds of CPU actually consumed; null where the host cannot meter it. */
      consumedCpuMs: number | null
    }
  | {
      /** The execution capability is not provisioned on this deployment. */
      status: 'runner-unavailable'
      reason: string
    }
  | {
      /** Refused before instantiation (subset violation, cap breach) or failed
       *  as a whole run (floor/verb refusal, breaker trip, uncaught error,
       *  vacuity, combined cap). Always a NAMED reason. */
      status: 'failed'
      reason: string
    }

/** Transport handed to a runner by its caller (the observe side). */
export interface ExecRunIo {
  /**
   * The fetch the run's egress rides — the observe side passes the SAME
   * transport the evidence bundle was recorded over, so an in-memory fixture
   * target and the deployed Worker's real fetch apply to the suite run
   * identically. The HOSTED runner ignores it (the isolate's egress is the
   * parent-owned gateway); the LOCAL runner wraps it in the gated fetch.
   */
  fetch?: (url: string, init?: RequestInit) => Promise<Response>
}

/** The runner seam: hosted (Worker Loader) and local share this interface. */
export interface ExecSuiteRunner {
  run(req: ExecRunRequest, io?: ExecRunIo): Promise<ExecRunOutcome>
}

interface RunRegistryEntry {
  api: Record<string, unknown>
  moduleNs?: Record<string, unknown>
}

/** Cross-module handoff for the generated `data:` shims (local path only). */
const RUN_REGISTRY_KEY = '__APIQA_VITEST_RUNS__'

function registry(): Record<string, RunRegistryEntry> {
  const g = globalThis as Record<string, unknown>
  if (g[RUN_REGISTRY_KEY] === undefined) g[RUN_REGISTRY_KEY] = {}
  return g[RUN_REGISTRY_KEY] as Record<string, RunRegistryEntry>
}

/** `data:` module URL for a source (utf-8, no base64 — unicode-safe). */
function dataModuleUrl(source: string): string {
  return `data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`
}

/** Rewrite the closed specifiers to concrete module URLs (local path). */
function rewriteSpecifiers(source: string, map: Record<string, string>): string {
  return source.replace(SPECIFIER_RE, (whole, lead: string, quote: string, spec: string) => {
    const target = map[spec]
    return target === undefined ? whole : `${lead}${quote}${target}${quote}`
  })
}

const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/**
 * The generated "vitest" shim — re-exports the ONE harness instance out of the
 * run registry. Orchestration glue, not a reimplementation: every exported
 * name is the shared harness's own member. Used verbatim by BOTH the local
 * `data:` module graph and the hosted isolate's module map.
 */
export function vitestShimSource(runId: string): string {
  return (
    `const h = globalThis[${JSON.stringify(RUN_REGISTRY_KEY)}][${JSON.stringify(runId)}].api\n` +
    `export const describe = h.describe\nexport const it = h.it\nexport const test = h.test\n` +
    `export const expect = h.expect\nexport const vi = h.vi\nexport default h\n`
  )
}

/** The generated "suite:env" module — pure data (A.8.6.2). Shared by both hosts. */
export function suiteEnvSource(req: ExecRunRequest): string {
  return (
    `export const origin = ${JSON.stringify(req.origin)}\n` +
    `export const vars = ${JSON.stringify(req.vars)}\n` +
    `export const seed = ${JSON.stringify(req.seed)}\n` +
    `export const sandbox = ${JSON.stringify(req.sandbox)}\n`
  )
}

/** The generated "suite:module" module — re-exports the instantiated `module` member's namespace. */
function suiteModuleShimSource(runId: string, exportNames: string[]): string {
  const head = `const ns = globalThis[${JSON.stringify(RUN_REGISTRY_KEY)}][${JSON.stringify(runId)}].moduleNs\n`
  const lines = exportNames
    .filter((n) => n !== 'default' && IDENTIFIER_RE.test(n))
    .map((n) => `export const ${n} = ns[${JSON.stringify(n)}]\n`)
  const dflt = exportNames.includes('default') ? 'export default ns.default\n' : ''
  return head + lines.join('') + dflt
}

interface HarnessModule {
  createHarness: () => HarnessInstance
  seededRandom: (seed: number) => () => number
}

let harnessModulePromise: Promise<HarnessModule> | undefined

interface HarnessInstance {
  api: Record<string, unknown> & { describe: unknown; it: unknown; test: unknown; expect: unknown; vi: unknown }
  run: () => Promise<{ registered: number; results: ExecTestResult[] }>
  readonly registered: number
}

/**
 * Import the shared harness FROM ITS CANONICAL BYTES (`VITEST_SUBSET_SOURCE`)
 * — not from a locally compiled sibling — so the local runner executes the
 * byte-identical module the hosted isolate's module map carries. Memoized:
 * `createHarness` is per-run state, the module itself is pure.
 */
export function loadHarnessModule(): Promise<HarnessModule> {
  harnessModulePromise ??= import(
    /* @vite-ignore */ dataModuleUrl(VITEST_SUBSET_SOURCE)
  ) as Promise<HarnessModule>
  return harnessModulePromise
}

/**
 * The FAIL-CLOSED TOTALITY fold (A.8.6.3), shared by the local runner and the
 * hosted Worker Loader runner so the two judge a raw run identically: a floor
 * or verb refusal fails the run even when the suite caught the throw; the
 * combined count cap and the output cap fail, never truncate; an all-of-
 * nothing is refused (non-vacuity over the union, A.8.6.1).
 */
export function foldRunOutcome(
  raw: { registered: number; results: ExecTestResult[]; violations: GateViolation[] },
  req: ExecRunRequest,
  appliedLimits: { wallMs: number; cpuMs: number },
  elapsedWallMs: number,
  consumedCpuMs: number | null,
): ExecRunOutcome {
  if (raw.violations.length > 0) {
    return { status: 'failed', reason: raw.violations[0]!.reason }
  }
  const combined = raw.registered + req.declarativeRows
  if (combined > EXEC_MAX_COMBINED) {
    return {
      status: 'failed',
      reason:
        `${req.declarativeRows} declarative row(s) + ${raw.registered} registered test(s) = ${combined}, over the ` +
        `${EXEC_MAX_COMBINED} combined abuse circuit-breaker (A.8.6.1) — failed, never truncated`,
    }
  }
  if (combined === 0) {
    return {
      status: 'failed',
      reason:
        'the suite registered no tests and declares no declarative rows — an all-of-nothing is refused ' +
        '(non-vacuity over the union, A.8.6.1)',
    }
  }
  const outputBytes = new TextEncoder().encode(JSON.stringify(raw.results)).byteLength
  if (outputBytes > EXEC_MAX_OUTPUT_BYTES) {
    return {
      status: 'failed',
      reason: `captured output is ${outputBytes} bytes, over the ${EXEC_MAX_OUTPUT_BYTES}-byte cap (A.8.6.3) — failed, never truncated`,
    }
  }
  return {
    status: 'ran',
    registered: raw.registered,
    results: raw.results,
    appliedLimits,
    elapsedWallMs,
    consumedCpuMs,
  }
}

let localRunCounter = 0

/**
 * The LOCAL `api.qa/vitest@1` runner — the CLI verb and the tests run through
 * this; it is also the parity reference for the hosted isolate. Same shared
 * harness bytes, same `validateDialectSource`, same `createGatedFetch`, same
 * seeded `Math.random`, same sequential run — "green locally, red hosted" is
 * expressible only as a difference in the TARGET's behavior (A.8.6.2).
 *
 * `realFetch` is injectable so an in-memory fixture target works; it defaults
 * to global fetch. During instantiation AND the run, `globalThis.fetch` and
 * `Math.random` are swapped (gated fetch; seeded PRNG) and — in the document
 * form — the subset names are installed as globals (A.8.6.2); everything is
 * restored in a finally.
 */
export function localExecRunner(opts: { fetch?: (url: string, init?: RequestInit) => Promise<Response> } = {}): ExecSuiteRunner {
  return {
    async run(req: ExecRunRequest, io: ExecRunIo = {}): Promise<ExecRunOutcome> {
      const wallMs = req.limits?.wallMs ?? EXEC_WALL_MS
      const cpuMs = req.limits?.cpuMs ?? EXEC_CPU_MS
      const appliedLimits = { wallMs, cpuMs }

      // ── Subset validation, before a single expression evaluates ──────────
      const hasModule = req.artifactKind === 'document' && typeof req.moduleSource === 'string'
      if (req.artifactKind === 'document' && req.moduleSource !== undefined) {
        const v = validateDialectSource(req.moduleSource, {
          allowSuiteModule: false,
          what: 'the suite document `module` member',
        })
        if (!v.ok) return { status: 'failed', reason: v.problem }
      }
      const testsValidation = validateDialectSource(req.testsSource, {
        allowSuiteModule: hasModule,
        what: req.artifactKind === 'document' ? 'the suite document `tests` member' : 'the pinned module artifact',
      })
      if (!testsValidation.ok) return { status: 'failed', reason: testsValidation.problem }

      const runId = `local:${++localRunCounter}:${req.seed}`
      const violations: GateViolation[] = []
      // Capture the AMBIENT fetch BEFORE the run swaps `globalThis.fetch` to
      // the gated fetch: a late-bound `fetch(url)` default would resolve to
      // the gated fetch itself once the swap lands — every egress recursing
      // gate→global→gate until the stack blows. The CLI verb (which injects
      // no io.fetch) rides this default.
      const ambientFetch = fetch.bind(globalThis) as (url: string, init?: RequestInit) => Promise<Response>
      const gatedFetch = createGatedFetch({
        realFetch: io.fetch ?? opts.fetch ?? ambientFetch,
        sandbox: req.sandbox,
        violations,
      })

      const g = globalThis as Record<string, unknown>
      const saved: Record<string, unknown> = {}
      const installedGlobals: string[] = []
      const savedFetch = g.fetch
      const savedRandom = Math.random

      const started = Date.now()
      try {
        const { createHarness, seededRandom } = await loadHarnessModule()
        const harness = createHarness()
        registry()[runId] = { api: harness.api }

        // The run's ambient surface: gated fetch, seeded randomness (from the
        // SHARED harness bytes — the same generator the hosted isolate seeds),
        // and (in the document form) the subset globals.
        g.fetch = gatedFetch
        Math.random = seededRandom(req.seed)
        if (req.artifactKind === 'document') {
          for (const name of ['describe', 'it', 'test', 'expect', 'vi']) {
            saved[name] = g[name]
            g[name] = harness.api[name]
            installedGlobals.push(name)
          }
        }

        const specMap: Record<string, string> = {
          vitest: dataModuleUrl(vitestShimSource(runId)),
          'suite:env': dataModuleUrl(suiteEnvSource(req)),
        }

        const importFresh = (source: string, map: Record<string, string>, tag: string) =>
          // The trailing comment makes every run's URL unique: ES module
          // instances are cached BY URL, and a re-run of the same bytes must
          // re-register its tests, not reuse a spent registration.
          import(/* @vite-ignore */ dataModuleUrl(`${rewriteSpecifiers(source, map)}\n//# ${runId}:${tag}`))

        const execute = async (): Promise<{ registered: number; results: ExecTestResult[] }> => {
          if (hasModule) {
            const moduleNs = (await importFresh(req.moduleSource!, specMap, 'module')) as Record<string, unknown>
            registry()[runId]!.moduleNs = moduleNs
            specMap['suite:module'] = dataModuleUrl(suiteModuleShimSource(runId, Object.keys(moduleNs)))
          }
          const testsNs = (await importFresh(req.testsSource, specMap, 'tests')) as Record<string, unknown>
          if (req.exportName !== undefined) {
            const fn = testsNs[req.exportName]
            if (typeof fn !== 'function') {
              throw new Error(
                `the card names export ${JSON.stringify(req.exportName)}, but the pinned module has no such function export`,
              )
            }
            await (fn as () => unknown | Promise<unknown>)()
          }
          return harness.run()
        }

        // ── The metered circuit-breaker (wall clock; local CPU is unmetered).
        // A trip fails the WHOLE run — never a partial verdict (A.8.6.3).
        let timer: ReturnType<typeof setTimeout> | undefined
        const breaker = new Promise<'breaker'>((resolve) => {
          timer = setTimeout(() => resolve('breaker'), wallMs)
        })
        const raced = await Promise.race([execute(), breaker]).finally(() => clearTimeout(timer))
        if (raced === 'breaker') {
          return {
            status: 'failed',
            reason:
              `circuit breaker tripped: the run exceeded ${wallMs} ms wall-clock (applied limits ` +
              `${wallMs} ms wall / ${cpuMs} ms CPU) — a tripped breaker fails the run, never a partial verdict (A.8.6.3)`,
          }
        }
        const { registered, results } = raced

        // Fail-closed totality — the SAME fold the hosted runner applies.
        return foldRunOutcome(
          { registered, results, violations },
          req,
          appliedLimits,
          Date.now() - started,
          null, // local CPU is unmetered; the hosted runner records consumed CPU
        )
      } catch (err) {
        // Instantiation-time throw (syntax error, top-level throw, export
        // registration throw, a floor refusal at module top level).
        const floored = violations[0]
        return {
          status: 'failed',
          reason: floored !== undefined ? floored.reason : `the suite failed to instantiate or register: ${err instanceof Error ? err.message : String(err)}`,
        }
      } finally {
        g.fetch = savedFetch
        Math.random = savedRandom
        for (const name of installedGlobals) {
          if (saved[name] === undefined) delete g[name]
          else g[name] = saved[name]
        }
        delete registry()[runId]
      }
    },
  }
}
