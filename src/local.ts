/**
 * The LOCAL runner — grade a surface PRE-DEPLOY, in-process or against a dev
 * URL, for the dev inner-loop and the CI gate.
 *
 * api.qa grades a black-box SURFACE over HTTP. Normally that surface is a
 * deployed origin. But the SAME engine can grade a surface that never left the
 * process: a Worker's `fetch` export, or a bare `(request) => Response` handler.
 * `grade()` accepts EITHER a URL string OR such an in-process handler:
 *
 *   - HANDLER target: we synthesize a stable, public-looking base origin
 *     (`https://local.test` by default) so every URL-relative probe resolves,
 *     build an injectable `fetcher` that dispatches each probe `Request` to the
 *     handler IN MEMORY (no socket, no DNS, no network), and route the whole
 *     fixed probe plan through it. The report is the SAME `VerificationReport`
 *     the deployed URL path produces.
 *
 *   - URL string target: passes straight through to `verifyTarget`, in `local`
 *     (advisory, never-attested) mode. A localhost / private dev URL is refused
 *     by default — the caller must OPT IN with `{ allowPrivate: true }`.
 *
 * SSRF INVARIANT (load-bearing — see http.ts): the private-host allowance is
 * OPT-IN and local-only. `grade()` NEVER infers `allowPrivate` from the target
 * — it is set ONLY when the caller of a URL target explicitly passes
 * `allowPrivate: true`. A handler target uses a public-looking synthetic origin
 * and dispatches in-memory, so it needs no allowance at all (`allowPrivate`
 * stays false). The deployed remote grader calls `verifyTarget` directly and is
 * entirely unaffected — a remote target string can never flip the allowance on.
 */

import { verifyTarget, type VerifyTargetOpts } from './verify.js'
import { verifyPinnedSpec, type PinnedReport, type VerifyPinnedOpts } from './pinned.js'
import type { Fetcher } from './http.js'
import type { VerificationReport } from './types.js'

/** A Worker-style ExecutionContext, or a bare fetch function. */
export type FetchHandlerFn = (request: Request, env?: unknown, ctx?: unknown) => Response | Promise<Response>

/** An in-process surface: a Worker module (`{ fetch }`) or a bare handler fn. */
export type FetchHandler = FetchHandlerFn | { fetch: FetchHandlerFn }

/** `grade()` accepts a deployed/dev URL string OR an in-process handler. */
export type GradeTarget = string | FetchHandler

export interface GradeOpts {
  /** Fresh per run by default; pass to replay a recorded run's probe plan. */
  seed?: number
  /** Max probe requests. Default 24 (48 in pinned mode). */
  budget?: number
  /** Delay between probes, ms. Defaults to 0 for local runs (hermetic, fast). */
  delayMs?: number
  /** Per-request timeout, ms. */
  timeoutMs?: number
  /** Max body bytes retained per probe. */
  maxBodyBytes?: number
  /**
   * Base origin synthesized for an in-process HANDLER target, so URL-relative
   * probes resolve. Default `https://local.test`. Must be a public-looking
   * origin (the handler is dispatched in-memory, so nothing is ever fetched
   * over the network — the origin is only a stable name for relative URLs).
   * Ignored for URL-string targets.
   */
  baseOrigin?: string
  /** Worker `env` passed as the 2nd arg to a Worker-style handler. */
  env?: unknown
  /** Worker `ctx` (ExecutionContext) passed as the 3rd arg. A stub is used when omitted. */
  ctx?: unknown
  /**
   * OPT-IN allowance for a localhost / private URL STRING target (a running dev
   * server, e.g. `http://localhost:8787`). Default false.
   *
   * SSRF INVARIANT: this is honored ONLY for a URL-string target the caller
   * explicitly opted in for, locally. It is NEVER inferred from the target, so a
   * remote target string can never turn it on, and the deployed remote grader
   * (which calls `verifyTarget` directly, not `grade`) never sets it. Ignored
   * for handler targets — they dispatch in-memory and never touch the network.
   */
  allowPrivate?: boolean
}

export interface GradePinnedOpts extends GradeOpts {
  /** The anti-Goodhart pin: spec text MUST hash to this or nothing runs. */
  expectedDigest?: string
  /** Bindings pre-seeded into the capture scope before the first requirement. */
  initialBindings?: Record<string, unknown>
}

/** Narrow a target to its underlying fetch function, or null if it is a URL string / invalid. */
function asFetchFn(target: GradeTarget): FetchHandlerFn | null {
  if (typeof target === 'function') return target
  if (target !== null && typeof target === 'object' && typeof (target as { fetch?: unknown }).fetch === 'function') {
    return (target as { fetch: FetchHandlerFn }).fetch.bind(target)
  }
  return null
}

/** A minimal ExecutionContext stub for handlers that call ctx.waitUntil / passThroughOnException. */
function defaultCtx(): unknown {
  return {
    waitUntil(_promise: Promise<unknown>): void {
      /* no-op: the local runner does not defer work past the response */
    },
    passThroughOnException(): void {
      /* no-op */
    },
  }
}

/**
 * Build the injectable `fetcher` that dispatches every probe `Request` to an
 * in-process handler — the whole point of the local runner. No socket is ever
 * opened: the observer's URL+init is turned into a `Request`, handed to the
 * handler, and the handler's `Response` is returned verbatim. All of api.qa's
 * SSRF backstops still run underneath (the observer re-validates every URL),
 * they simply never bite because the synthetic origin is public-looking.
 */
function handlerToFetcher(fetchFn: FetchHandlerFn, env: unknown, ctx: unknown): Fetcher {
  const executionCtx = ctx ?? defaultCtx()
  return async (url, init) => {
    const request = new Request(url, init as RequestInit)
    const res = await fetchFn(request, env, executionCtx)
    if (!(res instanceof Response)) {
      throw new Error(
        `in-process fetch handler returned ${res === undefined ? 'undefined' : typeof res}, expected a Response ` +
          '(a Worker-style { fetch(request, env, ctx) } or a (request) => Response)',
      )
    }
    return res
  }
}

function normalizeBaseOrigin(input: string | undefined): string {
  const raw = input ?? 'https://local.test'
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new Error(`grade(): baseOrigin ${JSON.stringify(raw)} is not a valid URL`)
  }
  return u.origin
}

interface ResolvedTarget {
  url: string
  observerOpts: VerifyTargetOpts
}

/**
 * Resolve a `GradeTarget` to the concrete `(url, observerOpts)` pair the core
 * verifier consumes. This is the SINGLE place `allowPrivateTargets` is decided
 * for the local runner, and it is ALWAYS set explicitly (never left to default
 * to `mode === 'local'`), so the SSRF invariant holds by construction:
 *
 *   - handler target  → in-memory fetcher, allowPrivateTargets: FALSE
 *   - URL string      → allowPrivateTargets = (caller explicitly opted in)
 *
 * A remote URL string with no opt-in therefore keeps the private-host block,
 * exactly as the deployed grader does.
 */
function resolveTarget(target: GradeTarget, opts: GradeOpts): ResolvedTarget {
  const base: VerifyTargetOpts = {
    mode: 'local',
    seed: opts.seed,
    budget: opts.budget,
    timeoutMs: opts.timeoutMs,
    maxBodyBytes: opts.maxBodyBytes,
  }

  if (typeof target === 'string') {
    // OPT-IN ONLY. Never inferred from the target — a remote target string can
    // never flip this on (the SSRF invariant). Explicitly set so the
    // `mode === 'local'` default in verifyTarget can never widen it silently.
    const allowPrivate = opts.allowPrivate === true
    return {
      url: target,
      observerOpts: {
        ...base,
        allowPrivateTargets: allowPrivate,
        delayMs: opts.delayMs ?? (allowPrivate ? 0 : 150),
      },
    }
  }

  const fetchFn = asFetchFn(target)
  if (!fetchFn) {
    throw new Error(
      'grade(): target must be a URL string, a (request) => Response handler, or a Worker-style { fetch } object',
    )
  }
  const origin = normalizeBaseOrigin(opts.baseOrigin)
  return {
    url: origin,
    observerOpts: {
      ...base,
      // In-memory dispatch to a public-looking synthetic origin: no allowance
      // needed, and none granted. The SSRF backstop is fully intact.
      allowPrivateTargets: false,
      fetcher: handlerToFetcher(fetchFn, opts.env, opts.ctx),
      delayMs: opts.delayMs ?? 0,
    },
  }
}

/**
 * Grade a surface — a deployed/dev URL string OR an in-process fetch handler —
 * and return the same advisory `VerificationReport` the deployed URL path
 * produces (local mode: deterministic, replayable, never attested).
 */
export async function grade(target: GradeTarget, opts: GradeOpts = {}): Promise<VerificationReport> {
  const { url, observerOpts } = resolveTarget(target, opts)
  return verifyTarget(url, observerOpts)
}

/**
 * Grade a surface against a PINNED spec, in-process or against a dev URL — the
 * spec-gate mode, run locally. Returns the same `PinnedReport` the deployed URL
 * path produces. `passed === false` is the CI-gate failure signal.
 */
export async function gradePinned(
  target: GradeTarget,
  specText: string,
  opts: GradePinnedOpts = {},
): Promise<PinnedReport> {
  const { url, observerOpts } = resolveTarget(target, opts)
  const pinnedOpts: VerifyPinnedOpts = {
    ...observerOpts,
    expectedDigest: opts.expectedDigest,
    initialBindings: opts.initialBindings,
  }
  return verifyPinnedSpec(url, specText, pinnedOpts)
}
