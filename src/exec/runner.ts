/**
 * The HOSTED `api.qa/vitest@1` runner — a Cloudflare Worker Loader isolate
 * per run — plus the typed "the capability is not provisioned here" runner.
 *
 * A.8.6.3's execution invariants, mapped onto the Worker Loader primitive:
 *
 *   FRESH, SINGLE-USE ISOLATE — the loader id is derived from (artifact
 *   digest, harness version): same bytes MAY warm-reuse a compiled isolate as
 *   a pure optimization (Cloudflare's own recommendation), different bytes
 *   get a new isolate by construction, and NO run state survives — the run's
 *   entire result crosses the boundary once, as the entry's Response body.
 *
 *   ZERO AMBIENT AUTHORITY — `env` is the EMPTY OBJECT, always. No
 *   SIGNING_KEY, no KV, no DO namespaces, no loader binding (no recursion),
 *   no vars. The run's inputs (origin, vars, seed, sandbox) travel as the
 *   generated `"suite:env"` MODULE — data compiled into the module map, not a
 *   binding. `buildWorkerCode` is exported so a unit test pins `env: {}`
 *   forever.
 *
 *   THE NETWORK FLOOR — `globalOutbound` is REQUIRED: every fetch the isolate
 *   makes is delivered to a parent-owned gateway that applies
 *   `isFloorBlockedHost` per request and per redirect hop (`gatewayFetch`,
 *   the same floor the local runner's gated fetch applies). A refusal is
 *   recorded OUT-OF-BAND in the parent's own violation sink
 *   (`createOutboundGateway`), drained by the runner after the isolate
 *   returns and folded into the verdict — so suite code that catches the
 *   refusal (or tampers with anything inside the isolate) still FAILS the
 *   run, identically to the local runner (A.8.6.3 fail-closed totality).
 *   Leaving `globalOutbound` unspecified would inherit the verifier's OWN
 *   network access — the one catastrophic misconfiguration — so a runner
 *   constructed without an outbound gateway REFUSES to execute (typed
 *   `runner-unavailable`), it never runs open.
 *
 *   METERED BREAKER — `limits.cpuMs` in the isolate (throws on breach), the
 *   wall-clock race in the parent; both recorded in the outcome. Trip ⇒ the
 *   whole run fails, never a partial verdict.
 *
 * FEATURE DETECTION. The Worker Loader binding is an open-beta, paid-plan
 * capability, ENABLED in `wrangler.jsonc` since the 2026-08-08 account
 * enrollment (SUITE_LOADER + the SuiteGateway loopback outbound) — but
 * `worker.ts` still wires this runner ONLY when `env.SUITE_LOADER` exists,
 * so a config rollback keeps every deploy valid.
 * Anywhere the binding — or the outbound gateway —
 * is absent, the runner is `unavailableExecRunner(...)`: a card that declares
 * `runner: "api.qa/vitest@1"` then FAILS with the reason named (the same
 * direction the ratified unknown-runner rule already gives an older
 * verifier), never a crash, never a silent pass.
 */

import {
  EXEC_CPU_MS,
  EXEC_WALL_MS,
  createGatedFetch,
  foldRunOutcome,
  suiteEnvSource,
  vitestShimSource,
  type ExecRunOutcome,
  type ExecRunRequest,
  type ExecSuiteRunner,
  type ExecTestResult,
  type GateViolation,
  validateDialectSource,
} from './dialect.js'
import { VITEST_SUBSET_SOURCE } from './vitest-subset-source.js'

/**
 * The harness revision folded into the isolate id: bump when the subset
 * harness bytes change semantics, so a warm isolate can never run a suite
 * against a stale harness.
 */
export const HARNESS_VERSION = 'vitest-subset@1'

/** The pinned runtime the isolate runs under — api.qa's constant, never the card's. */
export const EXEC_COMPATIBILITY_DATE = '2026-07-01'

/** The registry key the hosted module map uses (one run per isolate invocation). */
const HOSTED_RUN_ID = 'hosted'

// ---------------------------------------------------------------------------
// Structural types for the (beta) Worker Loader binding — kept local so the
// repo compiles without @cloudflare/workers-types for a beta surface.
// ---------------------------------------------------------------------------

export interface WorkerCodeLike {
  compatibilityDate: string
  mainModule: string
  modules: Record<string, { js: string }>
  env: Record<string, never>
  globalOutbound: unknown
  limits: { cpuMs: number }
}

export interface WorkerStubLike {
  getEntrypoint(): { fetch(url: string, init?: RequestInit): Promise<Response> }
}

export interface WorkerLoaderLike {
  get(id: string, getCode: () => Promise<WorkerCodeLike> | WorkerCodeLike): WorkerStubLike
}

// ---------------------------------------------------------------------------
// The typed absent-capability runner
// ---------------------------------------------------------------------------

export const RUNNER_UNAVAILABLE_NO_BINDING =
  'runner-unavailable: the api.qa/vitest@1 execution capability is not provisioned on this deployment ' +
  '(no Worker Loader binding). The card declares an executable suite this verifier cannot run, which ' +
  'fails by the same rule an unknown runner does — never a crash, never a silent pass.'

export const RUNNER_UNAVAILABLE_NO_OUTBOUND =
  'runner-unavailable: the Worker Loader binding is present but no outbound egress gateway is bound — ' +
  'running would inherit the verifier\'s own network access, which the A.8.6.3 floor forbids. Refusing to run open.'

/** A runner that always reports the capability absent, by a fixed named reason. */
export function unavailableExecRunner(reason: string = RUNNER_UNAVAILABLE_NO_BINDING): ExecSuiteRunner {
  return {
    run(): Promise<ExecRunOutcome> {
      return Promise.resolve({ status: 'runner-unavailable', reason })
    },
  }
}

// ---------------------------------------------------------------------------
// The parent-side egress gateway — the floor, applied where the parent owns it
// ---------------------------------------------------------------------------

/**
 * Marker header stamped on every gateway-refused response: `"violation"` when
 * the floor/verb gate refused (a `GateViolation` was recorded), `"error"` when
 * the egress attempt failed for a non-gate reason (unroutable, too many
 * redirects). The value is a FLAG only — the reason travels in the JSON body,
 * because header values cannot carry the reasons' full character set. The
 * isolate entry's fetch wrapper reads this marker to re-throw with the reason
 * (local-parity throw semantics) and, on `"violation"`, to record the refusal
 * in the run's own violation list.
 */
export const GATEWAY_MARKER_HEADER = 'x-apiqa-gateway'

/**
 * Handle ONE outbound request delivered by the isolate's `globalOutbound`.
 * Reuses the SAME gated fetch the local runner uses (`createGatedFetch`), so
 * the floor and the manual per-hop redirect re-check cannot drift between
 * hosts. The eventual gateway entrypoint (deploy-time, beta account) is a
 * thin wrapper over this function; the floor logic lives HERE, unit-tested.
 *
 * What this function itself guarantees on a refusal: the request is NOT
 * forwarded, the refusal is recorded in the caller-owned `opts.violations`
 * sink (out-of-band — isolate code can never reach it), and the 403 handed
 * back to the isolate carries the `GATEWAY_MARKER_HEADER`. It does NOT, by
 * itself, fail the run: the run-level fail-closed verdict is enforced by
 * `workerLoaderExecRunner`, which drains the sink after the isolate returns
 * and folds it into the outcome — so a suite that catches the re-thrown
 * refusal (or absorbs the 403) still fails. Call this through
 * `createOutboundGateway` so the sink actually reaches the runner; with no
 * sink wired, the marker + the entry wrapper's in-isolate record are the only
 * channels, which is NOT sufficient for the attested path.
 */
export async function gatewayFetch(
  request: Request,
  realFetch: (url: string, init?: RequestInit) => Promise<Response> = (url, init) => fetch(url, init),
  opts: { sandbox?: boolean; violations?: GateViolation[] } = {},
): Promise<Response> {
  const violations = opts.violations ?? []
  const before = violations.length
  const gated = createGatedFetch({ realFetch, sandbox: opts.sandbox ?? true, violations })
  try {
    const headers: Record<string, string> = {}
    request.headers.forEach((v, k) => {
      headers[k] = v
    })
    return await gated(request.url, {
      method: request.method,
      headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.text(),
    })
  } catch (err) {
    return new Response(
      JSON.stringify({ type: 'BLOCKED', reason: err instanceof Error ? err.message : String(err) }),
      {
        status: 403,
        headers: {
          'content-type': 'application/json',
          [GATEWAY_MARKER_HEADER]: violations.length > before ? 'violation' : 'error',
        },
      },
    )
  }
}

/**
 * A parent-owned egress gateway INSTANCE: `fetch` is the `globalOutbound`
 * delivery handler (the floor, per request and per redirect hop), and
 * `drainViolations` hands the out-of-band refusal record to the runner and
 * clears it. This pairing is the A.8.6.3 fail-closed spine of the hosted
 * path: the record lives in PARENT memory, so nothing suite code does inside
 * the isolate — catching, patching globals, forging the response body — can
 * erase it. Prefer one instance per run; a gateway shared across concurrent
 * runs can only over-attribute a violation, which errs in the CLOSED
 * direction (a run may be failed by a neighbour's refusal, never passed by
 * one). At deploy time this is exposed from a same-isolate loopback
 * entrypoint (`SuiteGateway`, src/exec/gateway.ts — the SUITE_OUTBOUND
 * service binding) so the runner can actually drain it.
 */
export function createOutboundGateway(
  realFetch?: (url: string, init?: RequestInit) => Promise<Response>,
  opts: { sandbox?: boolean } = {},
): OutboundGatewayLike {
  const violations: GateViolation[] = []
  return {
    fetch: (request: Request) => gatewayFetch(request, realFetch, { ...opts, violations }),
    drainViolations: () => violations.splice(0, violations.length),
  }
}

/** The gateway shape the runner can drain the out-of-band record from. */
export interface OutboundGatewayLike {
  fetch(request: Request): Promise<Response>
  drainViolations(): GateViolation[] | Promise<GateViolation[]>
}

// ---------------------------------------------------------------------------
// WorkerCode assembly
// ---------------------------------------------------------------------------

/**
 * The generated isolate ENTRY — orchestration only: create the one shared
 * harness, seed `Math.random` from the harness's own generator, wrap the
 * (already gateway-brokered) global fetch with the A.8.6.4 verb gate and the
 * gateway-marker re-throw (a floor refusal surfaces as the SAME throw the
 * local gated fetch gives, recorded in the run's violation list),
 * install the document-form globals, instantiate the pinned module(s), run,
 * and return the raw results as the Response body. The verdict is computed by
 * the PARENT (`foldRunOutcome`) — the isolate returns events, never "passed".
 */
export function entrySource(req: ExecRunRequest): string {
  const hasModule = req.artifactKind === 'document' && typeof req.moduleSource === 'string'
  return `import { createHarness, seededRandom, SUBSET_GLOBALS } from './harness.mjs'

const SEED = ${JSON.stringify(req.seed)}
const SANDBOX = ${JSON.stringify(req.sandbox)}
const DOCUMENT = ${JSON.stringify(req.artifactKind === 'document')}
const HAS_MODULE = ${JSON.stringify(hasModule)}
const EXPORT_NAME = ${JSON.stringify(req.exportName ?? null)}
const MARKER = ${JSON.stringify(GATEWAY_MARKER_HEADER)}

// Captured at entry evaluation — BEFORE any suite byte runs — so suite code
// patching Response/JSON cannot forge the body the parent folds. (The
// authoritative fail-closed record is the parent-side gateway sink anyway;
// this keeps the in-isolate channel honest too.)
const RESPOND = ((R, S) => (data) => new R(S(data), { headers: { 'content-type': 'application/json' } }))(Response, JSON.stringify)

export default {
  async fetch() {
    const violations = []
    const harness = createHarness()
    globalThis[${JSON.stringify('__APIQA_VITEST_RUNS__')}] = { [${JSON.stringify(HOSTED_RUN_ID)}]: { api: harness.api } }
    Math.random = seededRandom(SEED)
    const realFetch = globalThis.fetch.bind(globalThis)
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : String(input && input.url ? input.url : input)
      const method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase()
      if (method !== 'GET' && method !== 'HEAD' && !SANDBOX) {
        const reason = method + ' ' + url + ' refused: mutating verbs are permitted only against an environment the pinned suite itself declares "sandbox": true (A.8.6.4)'
        violations.push({ url, reason })
        throw new Error(reason)
      }
      const res = await realFetch(input, init)
      // Every egress rides globalOutbound = the parent gateway; a marked 403
      // is the gateway's refusal. Record it (violation ⇒ fails the run even
      // if caught) and THROW — the same shape the local gated fetch gives.
      if (res.status === 403) {
        const marker = res.headers.get(MARKER)
        if (marker !== null) {
          let reason = 'refused by the egress gateway'
          try {
            const body = await res.clone().json()
            if (body && typeof body.reason === 'string') reason = body.reason
          } catch {}
          if (marker === 'violation') violations.push({ url, reason })
          throw new Error(reason)
        }
      }
      return res
    }
    try {
      if (DOCUMENT) for (const n of SUBSET_GLOBALS) globalThis[n] = harness.api[n]
      if (HAS_MODULE) await import('./suite-module-impl.mjs')
      const ns = await import('./suite-tests.mjs')
      if (EXPORT_NAME !== null) {
        const fn = ns[EXPORT_NAME]
        if (typeof fn !== 'function') throw new Error('the card names export "' + EXPORT_NAME + '", but the pinned module has no such function export')
        await fn()
      }
      const { registered, results } = await harness.run()
      return RESPOND({ registered, results, violations })
    } catch (err) {
      return RESPOND({ error: err instanceof Error ? err.message : String(err), violations })
    }
  }
}
`
}

/**
 * Assemble the isolate's module map + posture. Exported so tests pin the
 * invariants without a loader: `env` is EMPTY, `globalOutbound` is set, the
 * harness bytes are `VITEST_SUBSET_SOURCE` verbatim, the compat date is the
 * verifier's pinned constant.
 */
export function buildWorkerCode(req: ExecRunRequest, outbound: unknown): WorkerCodeLike {
  const hasModule = req.artifactKind === 'document' && typeof req.moduleSource === 'string'
  const modules: Record<string, { js: string }> = {
    'entry.mjs': { js: entrySource(req) },
    './harness.mjs': { js: VITEST_SUBSET_SOURCE },
    // The closed specifiers resolve NATIVELY in the isolate's module map — no
    // rewriting of the pinned bytes, ever.
    vitest: { js: vitestShimSource(HOSTED_RUN_ID) },
    'suite:env': { js: suiteEnvSource(req) },
    './suite-tests.mjs': { js: req.testsSource },
  }
  if (hasModule) {
    modules['./suite-module-impl.mjs'] = { js: req.moduleSource! }
    modules['suite:module'] = { js: `export * from './suite-module-impl.mjs'\n` }
  }
  return {
    compatibilityDate: EXEC_COMPATIBILITY_DATE,
    mainModule: 'entry.mjs',
    modules,
    env: {},
    globalOutbound: outbound,
    limits: { cpuMs: req.limits?.cpuMs ?? EXEC_CPU_MS },
  }
}

// ---------------------------------------------------------------------------
// The hosted runner
// ---------------------------------------------------------------------------

export interface WorkerLoaderRunnerOpts {
  /**
   * The service stub / entrypoint every isolate fetch is delivered to
   * (`globalOutbound`). REQUIRED to execute: absent ⇒ typed
   * `runner-unavailable`, because an unspecified outbound would inherit the
   * verifier's own network access.
   */
  outbound?: unknown
  /**
   * Drain the PARENT-SIDE violation record after the isolate returns — the
   * out-of-band half of A.8.6.3 fail-closed totality: a floor refusal
   * recorded here fails the run no matter what the suite caught, forged, or
   * suppressed inside the isolate. Defaults to `outbound.drainViolations`
   * when the outbound is an `OutboundGatewayLike`. When a drain exists but
   * THROWS, the run fails closed (the record could not be consulted).
   */
  drainViolations?: () => GateViolation[] | Promise<GateViolation[]>
}

/** The named fail-closed reason when the parent-side record cannot be read. */
export const GATEWAY_RECORD_UNREADABLE =
  "the egress gateway's out-of-band violation record could not be read after the run — failing closed: " +
  'without the record, a floor refusal could have been swallowed inside the isolate (A.8.6.3)'

function hasDrain(x: unknown): x is OutboundGatewayLike {
  return (
    typeof x === 'object' && x !== null && typeof (x as Record<string, unknown>).drainViolations === 'function'
  )
}

export function workerLoaderExecRunner(
  loader: WorkerLoaderLike,
  opts: WorkerLoaderRunnerOpts = {},
): ExecSuiteRunner {
  return {
    async run(req: ExecRunRequest): Promise<ExecRunOutcome> {
      if (opts.outbound === undefined || opts.outbound === null) {
        return { status: 'runner-unavailable', reason: RUNNER_UNAVAILABLE_NO_OUTBOUND }
      }

      // The out-of-band record's drain seam: explicit, or the gateway's own.
      const drainFn =
        opts.drainViolations ?? (hasDrain(opts.outbound) ? () => (opts.outbound as OutboundGatewayLike).drainViolations() : undefined)
      const drainParentViolations = async (): Promise<GateViolation[] | 'unreadable'> => {
        if (drainFn === undefined) return []
        try {
          return await drainFn()
        } catch {
          return 'unreadable'
        }
      }

      // The SAME shared validation the local runner runs — a subset violation
      // is refused before an isolate exists (and identically in both hosts).
      const hasModule = req.artifactKind === 'document' && typeof req.moduleSource === 'string'
      if (hasModule) {
        const v = validateDialectSource(req.moduleSource!, {
          allowSuiteModule: false,
          what: 'the suite document `module` member',
        })
        if (!v.ok) return { status: 'failed', reason: v.problem }
      }
      const tv = validateDialectSource(req.testsSource, {
        allowSuiteModule: hasModule,
        what: req.artifactKind === 'document' ? 'the suite document `tests` member' : 'the pinned module artifact',
      })
      if (!tv.ok) return { status: 'failed', reason: tv.problem }

      const wallMs = req.limits?.wallMs ?? EXEC_WALL_MS
      const cpuMs = req.limits?.cpuMs ?? EXEC_CPU_MS
      const appliedLimits = { wallMs, cpuMs }
      const started = Date.now()

      try {
        // Content-hash id (Cloudflare's own recommendation): same digest +
        // harness ⇒ same id (warm reuse is a pure optimization), different
        // bytes ⇒ a different isolate by construction.
        const id = `vitest1:${req.digest ?? 'inline'}:${HARNESS_VERSION}`
        const stub = loader.get(id, () => buildWorkerCode(req, opts.outbound))

        let timer: ReturnType<typeof setTimeout> | undefined
        const breaker = new Promise<'breaker'>((resolve) => {
          timer = setTimeout(() => resolve('breaker'), wallMs)
        })
        const raced = await Promise.race([
          stub.getEntrypoint().fetch('https://run/'),
          breaker,
        ]).finally(() => clearTimeout(timer))
        if (raced === 'breaker') {
          // Drain (and discard) so a shared gateway cannot carry this run's
          // refusals into a later run's record; the trip already fails this one.
          await drainParentViolations()
          return {
            status: 'failed',
            reason:
              `circuit breaker tripped: the run exceeded ${wallMs} ms wall-clock (applied limits ` +
              `${wallMs} ms wall / ${cpuMs} ms CPU) — a tripped breaker fails the run, never a partial verdict (A.8.6.3)`,
          }
        }
        const body = (await raced.json()) as {
          registered?: number
          results?: ExecTestResult[]
          violations?: GateViolation[]
          error?: string
        }
        // The PARENT-SIDE record outranks anything the isolate reported: it is
        // the record suite code can never reach. Unreadable ⇒ fail closed.
        const parentViolations = await drainParentViolations()
        if (parentViolations === 'unreadable') {
          return { status: 'failed', reason: GATEWAY_RECORD_UNREADABLE }
        }
        if (typeof body.error === 'string') {
          const floored = parentViolations[0] ?? body.violations?.[0]
          return {
            status: 'failed',
            reason: floored !== undefined ? floored.reason : `the suite failed to instantiate or register: ${body.error}`,
          }
        }
        return foldRunOutcome(
          {
            registered: body.registered ?? 0,
            results: body.results ?? [],
            violations: [...parentViolations, ...(body.violations ?? [])],
          },
          req,
          appliedLimits,
          Date.now() - started,
          null, // consumed CPU: surfaced by the platform's limits API when enrolled; recorded null until then
        )
      } catch (err) {
        // Even a crashed exchange consults the out-of-band record first: a
        // floor refusal that crashed the run still surfaces BY NAME.
        const parentViolations = await drainParentViolations()
        if (parentViolations !== 'unreadable' && parentViolations[0] !== undefined) {
          return { status: 'failed', reason: parentViolations[0].reason }
        }
        return {
          status: 'failed',
          reason: `the Worker Loader run failed: ${err instanceof Error ? err.message : String(err)}`,
        }
      }
    },
  }
}
