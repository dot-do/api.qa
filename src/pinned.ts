/**
 * Pinned-spec mode — the X1 harness.
 *
 * A PinnedSpec is a contract document held OUTSIDE the implementing fleet's
 * write access (in the vault, in a gist, wherever — what matters is the
 * hash). The caller supplies the spec TEXT plus the digest they expect; if
 * the text doesn't hash to the pin, verification refuses before a single
 * probe fires. A fleet can therefore edit its local copy of the spec all it
 * wants — the verdict is bound to the pinned digest, and the acceptance
 * command names the digest, not the file.
 *
 * How the weekend build points its hill-climb here (local mode):
 *
 *   npx autonomous-qa verify http://localhost:8787 \
 *     --spec specs/golden-scenario.spec.json \
 *     --expect-digest <sha256 printed when the spec was ratified>
 *
 * Local runs are advisory (never attested). Definition of done = the SAME
 * spec digest passing on the deployed api.qa against the deployed target.
 */

import {
  Observer,
  normalizeTarget,
  isPubliclyRoutableSameOrigin,
  type ObserverOpts,
} from './http.js'
import { observeTarget, ROLE, parseAgentsJson, parseJsonBody, parseOpenapi } from './discovery.js'
import { runChecks } from './checks.js'
import { axScoreOf } from './grade.js'
import { sha256Hex } from './digest.js'
import { validateSchema, readPath } from './schema.js'
import { VERIFIER_VERSION } from './verify.js'
import type {
  CheckResult,
  EndpointExpect,
  Evidence,
  EvidenceBundle,
  PinnedRequirement,
  PinnedSpec,
  Verdict,
} from './types.js'

export interface PinnedReport {
  $type: 'PinnedVerificationReport'
  verifier: 'api.qa'
  verifierVersion: string
  mode: 'remote' | 'local'
  target: string
  spec: { name: string; version: string; digest: string }
  verifiedAt: string
  seed: number
  passed: boolean
  requirements: CheckResult[]
  evidence: EvidenceBundle
  attested: false
}

export interface VerifyPinnedOpts extends ObserverOpts {
  mode?: 'remote' | 'local'
  seed?: number
  /** The pin. When present, spec text MUST hash to this or nothing runs. */
  expectedDigest?: string
  allowPrivateTargets?: boolean
}

export function parsePinnedSpec(text: string): PinnedSpec {
  const doc = JSON.parse(text) as PinnedSpec
  if (doc.$type !== 'PinnedSpec' || !Array.isArray(doc.requirements)) {
    throw new Error('not a PinnedSpec: expected {"$type":"PinnedSpec","requirements":[...]}')
  }
  return doc
}

export async function verifyPinnedSpec(
  target: string,
  specText: string,
  opts: VerifyPinnedOpts = {},
): Promise<PinnedReport> {
  const mode = opts.mode ?? 'remote'
  const digest = await sha256Hex(specText)

  if (opts.expectedDigest && opts.expectedDigest !== digest) {
    // The anti-Goodhart gate: a locally edited spec fails before any probe.
    throw new Error(
      `spec digest mismatch: expected ${opts.expectedDigest}, supplied text hashes to ${digest}. ` +
        'The pinned contract is not the one this text represents — refusing to verify.',
    )
  }

  const spec = parsePinnedSpec(specText)
  const normalized = normalizeTarget(target, opts.allowPrivateTargets ?? mode === 'local')
  if ('error' in normalized) throw new Error(normalized.error)
  const origin = normalized.origin

  const seed = opts.seed ?? (Math.floor(Math.random() * 0xffffffff) >>> 0)
  // Pinned mode is consent mode: the target is yours, POST probes allowed. The
  // same consent gates the structural SSRF backstop for a private/local target.
  const observer = new Observer({
    ...opts,
    allowWrites: true,
    allowPrivate: opts.allowPrivateTargets ?? mode === 'local',
    budget: opts.budget ?? 48,
  })
  const bundle = await observeTarget(origin, observer, seed)

  // Extra observations demanded by the spec's endpoint requirements.
  //
  // Endpoint requirements run in requirement-array order and share a per-run
  // BINDING SCOPE: a requirement may `capture` values out of its response, and a
  // LATER requirement may interpolate them with `{{var}}` tokens into its
  // method/path/body/expect. Interpolation happens HERE, at observe time, after
  // the producing requirement has already run — the loop is sequential, so the
  // scope is populated in dependency order.
  const bindings: Bindings = {}
  for (const req of spec.requirements) {
    if (req.kind !== 'endpoint') continue
    const resolved = resolveEndpoint(req, origin, bindings)
    // Fail-closed: an undefined-var reference, an unparseable resolved path, or
    // a resolved URL that is off-origin/private is NEVER fetched. No evidence is
    // recorded; the judge re-derives the identical resolution failure purely
    // from the bundle and reports the same detail. This is the SSRF gate for a
    // TARGET-CONTROLLED captured value: it cannot smuggle an off-origin request.
    if (!resolved.ok) continue
    const ev = await observer.observe(`pinned:${req.id}`, resolved.url, {
      method: resolved.method,
      accept: 'application/json',
      body: resolved.body,
    })
    // Capture AFTER assertions pass (judgeExpect is pure — safe to call here to
    // gate the capture). A capture path that does not resolve simply leaves the
    // var unbound, so a downstream reference fails closed, never silently skips.
    if (req.capture && judgeExpect(ev, resolved.expect).length === 0) {
      captureInto(bindings, req.capture, ev)
    }
  }

  // Probe requirements resolve against the TARGET's own card-declared probe
  // manifest (`probes.<channel>`), never against spec-hardcoded routes. The
  // manifest is adversarial input: entries that are not same-origin GETs are
  // refused WITHOUT fetching, and any unresolvable requirement fails closed —
  // never skips. Two phases, so a derived amount (paramValue.fromProbe) can
  // read a number out of a phase-1 observation: the verifier, not the
  // manifest, owns the over-ceiling amount.
  const card = parseAgentsJson(
    parseJsonBody(observer.items.find((e) => e.role === ROLE.agentsJson)),
    origin,
  )
  const probePlans = new Map<string, ProbePlan>()
  const probeReqs = spec.requirements.filter(
    (r): r is Extract<PinnedRequirement, { kind: 'probe' }> => r.kind === 'probe',
  )
  const phase1 = probeReqs.filter((r) => r.paramValue === undefined || typeof r.paramValue === 'number')
  const phase2 = probeReqs.filter((r) => typeof r.paramValue === 'object' && r.paramValue !== null)
  for (const req of [...phase1, ...phase2]) {
    const plan: ProbePlan = {
      declared: dedupeByUrl(card.probes?.[req.probe] ?? []),
      entryProblems: new Map(),
      finalUrls: new Map(),
    }
    probePlans.set(req.id, plan)
    const min = req.minDeclared ?? 1
    if (plan.declared.length < min) {
      plan.unresolved =
        `probe manifest declares ${plan.declared.length} distinct probe(s) under "probes.${req.probe}"; ` +
        `the pinned contract requires at least ${min} — failing closed`
      continue
    }
    for (let i = 0; i < plan.declared.length; i++) {
      const entry = plan.declared[i]!
      // SHARED same-origin + publicly-routable gate (same helper as
      // monetization.probe and the probe-manifest check — no drift). Refused
      // WITHOUT fetching: a manifest cannot steer the verifier off-origin or
      // at a private/metadata address.
      if (!isPubliclyRoutableSameOrigin(entry.url, origin) || entry.method !== 'GET') {
        plan.entryProblems.set(i, `probe url ${entry.url} is not a same-origin GET — refused, fail closed`)
        continue
      }
      let url = entry.url
      if (req.paramValue !== undefined) {
        let amount: number
        if (typeof req.paramValue === 'number') {
          amount = req.paramValue
        } else {
          const { fromProbe, path, multiply } = req.paramValue
          const srcReq = phase1.find((r) => r.probe === fromProbe)
          const srcEv = srcReq
            ? observer.items.find((e) => e.role === `pinned:${srcReq.id}:0`)
            : undefined
          let srcBody: unknown
          try { srcBody = JSON.parse(srcEv?.body ?? '') } catch { /* non-JSON → unresolved below */ }
          const r = readPath(srcBody, path)
          if (!r.found || typeof r.value !== 'number') {
            plan.unresolved = `probes.${fromProbe} yielded no numeric ${path} — cannot derive amount, failing closed`
            break
          }
          amount = r.value * (multiply ?? 1)
        }
        if (typeof entry.param !== 'string' || entry.param.length === 0) {
          plan.unresolved =
            `probes.${req.probe} entry ${entry.url} declares no "param" member — ` +
            'cannot set the verifier-owned amount, failing closed'
          break
        }
        const u = new URL(url)
        u.searchParams.set(entry.param, String(amount))
        url = u.toString()
      }
      plan.finalUrls.set(i, url)
      await observer.observe(`pinned:${req.id}:${i}`, url, { accept: 'application/json' })
    }
  }
  const fullBundle: EvidenceBundle = { ...bundle, items: observer.items, bindings }

  // Judge (pure over the bundle).
  const surfaceChecks = runChecks(fullBundle)
  const axScore = axScoreOf(surfaceChecks)
  const results: CheckResult[] = []

  // The judge rebuilds the capture scope INCREMENTALLY, in the same requirement
  // order, reading response bodies straight out of the bundle. This is what
  // makes judging pure over the bundle AND order-respecting: a `{{var}}`
  // referenced before it is produced fails closed with the same undefined-var
  // detail the observe phase saw, and a replay of a stored bundle re-judges
  // identically without any re-fetch.
  const judgeBindings: Bindings = {}

  for (const req of spec.requirements) {
    if (req.kind === 'surface') {
      const idMap = { 'llms.txt': 'llms-txt', 'agents.json': 'agents-json', 'icp.json': 'icp-json', openapi: 'openapi' } as const
      const base = surfaceChecks.find((c) => c.id === idMap[req.surface])
      // Pinned tightening for the openapi surface: the spec may pin the
      // declared version prefix (e.g. "3.1") and a minimum operation count —
      // a generic "parses" verdict is not the same as "is the pinned contract".
      const extras: string[] = []
      if (req.surface === 'openapi' && base?.verdict === 'pass' &&
          (req.versionPrefix !== undefined || req.minOperations !== undefined)) {
        const summary = parseOpenapi(parseJsonBody(fullBundle.items.find((e) => e.role === ROLE.openapi)))
        if (req.versionPrefix !== undefined && !(summary.version ?? '').startsWith(req.versionPrefix)) {
          extras.push(`declared spec version ${summary.version === undefined ? '(none)' : `"${summary.version}"`} does not begin with "${req.versionPrefix}"`)
        }
        if (req.minOperations !== undefined && summary.operationCount < req.minOperations) {
          extras.push(`declares ${summary.operationCount} operation(s); the pinned contract requires at least ${req.minOperations}`)
        }
      }
      const verdict: Verdict = base?.verdict === 'pass' && extras.length === 0 ? 'pass' : 'fail'
      results.push({
        id: req.id, title: `surface ${req.surface} must be ${req.must}`,
        verdict,
        detail: extras.length > 0 ? extras.join('; ') : base?.detail ?? 'surface not judged',
        evidence: base?.evidence ?? [],
      })
    } else if (req.kind === 'ax-floor') {
      results.push({
        id: req.id, title: `AX score ≥ ${req.minScore}`,
        verdict: axScore.points >= req.minScore ? 'pass' : 'fail',
        detail: `AX ${axScore.points}/10 (floor ${req.minScore})`, evidence: [],
      })
    } else if (req.kind === 'check') {
      // Bind a MUST clause to a SPECIFIC api.qa check, not the coarse floor.
      const c = surfaceChecks.find((sc) => sc.id === req.check)
      const verdict: Verdict = c?.verdict === 'pass' ? 'pass' : 'fail'
      results.push({
        id: req.id, title: `check ${req.check} must ${req.must}`,
        verdict,
        detail:
          c === undefined
            ? `unknown check "${req.check}" — not produced by api.qa runChecks; cannot pass`
            : c.verdict === 'pass'
              ? `check ${req.check} passed: ${c.detail}`
              : `check ${req.check} verdict '${c.verdict}' (must be 'pass'): ${c.detail}`,
        evidence: c?.evidence ?? [],
      })
    } else if (req.kind === 'endpoint') {
      // Re-resolve interpolation/capture-chaining PURELY from the judge scope
      // (rebuilt from the bundle). A resolution failure — undefined `{{var}}`,
      // unparseable path, or an off-origin/private resolved URL — is a hard fail
      // that was NEVER fetched.
      const resolved = resolveEndpoint(req, origin, judgeBindings)
      if (!resolved.ok) {
        results.push({
          id: req.id, title: `${req.method} ${req.path}`, verdict: 'fail',
          detail: resolved.detail, evidence: [],
        })
        continue
      }
      const ev = fullBundle.items.find((e) => e.role === `pinned:${req.id}`)
      const problems = judgeExpect(ev, resolved.expect)
      const verdict: Verdict = problems.length === 0 ? 'pass' : 'fail'
      // Bind captures for downstream requirements — mirrors the observe phase
      // exactly (same bodies, same capture-on-pass gate), so the two scopes are
      // identical by construction.
      if (verdict === 'pass' && req.capture) captureInto(judgeBindings, req.capture, ev)
      results.push({
        id: req.id, title: `${req.method} ${resolved.url}`, verdict,
        detail: verdict === 'pass' ? 'behaved as pinned' : problems.join('; '),
        evidence: [`pinned:${req.id}`],
      })
    } else if (req.kind === 'probe') {
      const plan = probePlans.get(req.id)!
      if (plan.unresolved !== undefined) {
        results.push({
          id: req.id, title: `probe ${req.probe}`, verdict: 'fail',
          detail: plan.unresolved, evidence: [ROLE.agentsJson],
        })
      } else {
        const problems: string[] = []
        const evidence: string[] = []
        plan.declared.forEach((entry, i) => {
          const refused = plan.entryProblems.get(i)
          if (refused !== undefined) {
            problems.push(`#${i} ${entry.url}: ${refused}`)
            return
          }
          const role = `pinned:${req.id}:${i}`
          evidence.push(role)
          const ev = fullBundle.items.find((e) => e.role === role)
          const ps = judgeExpect(ev, req.expect)
          // Anti-decoy rule: the probed pathname must also have answered a
          // 200 `OK` envelope somewhere in this same run — a path that can
          // only ever say EMPTY/BLOCKED is a dedicated decoy, not a branch.
          if (req.pathMustServeOk === true) {
            const finalUrl = plan.finalUrls.get(i) ?? entry.url
            let pathname: string | undefined
            try { pathname = new URL(finalUrl).pathname } catch { /* unparseable → fails below */ }
            if (pathname === undefined || !okPathnamesOf(fullBundle).has(pathname)) {
              ps.push(`pathname ${pathname ?? finalUrl} was never observed answering 200 with an "OK" envelope in this run — the probe path does not demonstrably branch on its query (decoy endpoint)`)
            }
          }
          if (ps.length > 0) problems.push(`#${i} ${plan.finalUrls.get(i) ?? entry.url}: ${ps.join('; ')}`)
        })
        const verdict: Verdict = problems.length === 0 ? 'pass' : 'fail'
        results.push({
          id: req.id,
          title: `probe ${req.probe} (${plan.declared.length} declared)`,
          verdict,
          detail: verdict === 'pass' ? 'every declared probe behaved as pinned' : problems.join('; '),
          evidence,
        })
      }
    } else {
      // A spec kind this verifier does not implement must fail LOUDLY: a
      // silent pass (or skip) would let a newer contract vacuously clear.
      results.push({
        id: (req as { id: string }).id ?? 'unknown',
        title: 'unknown requirement kind',
        verdict: 'fail',
        detail: `unknown requirement kind "${(req as { kind?: string }).kind}" — verifier too old for this spec`,
        evidence: [],
      })
    }
  }

  return {
    $type: 'PinnedVerificationReport',
    verifier: 'api.qa',
    verifierVersion: VERIFIER_VERSION,
    mode,
    target: origin,
    spec: { name: spec.name, version: spec.version, digest },
    verifiedAt: fullBundle.fetchedAt,
    seed,
    passed: results.every((r) => r.verdict === 'pass'),
    requirements: results,
    evidence: fullBundle,
    attested: false,
  }
}

// ---------------------------------------------------------------------------
// Probe-requirement plumbing
// ---------------------------------------------------------------------------

interface ProbeEntry {
  method: string
  url: string
  param?: string
}

/** Per-requirement resolution of the card-declared probe manifest. */
interface ProbePlan {
  /** Declared entries for the channel, deduped by full URL. */
  declared: ProbeEntry[]
  /** Fail-closed reason that dooms the whole requirement (never a skip). */
  unresolved?: string
  /** Per-entry refusals (non-same-origin / non-GET) — never fetched. */
  entryProblems: Map<number, string>
  /** Final URLs actually observed (after verifier-owned param injection). */
  finalUrls: Map<number, string>
}

function dedupeByUrl(entries: ProbeEntry[]): ProbeEntry[] {
  // Distinctness keys on the FETCHED identity: fragments never reach the
  // wire, so `/e?a=1` and `/e?a=1#dup` are the same probe, not two.
  const key = (raw: string) => {
    try { const u = new URL(raw); u.hash = ''; return u.toString() } catch { return raw }
  }
  return [...new Map(entries.map((p) => [key(p.url), p])).values()]
}

/**
 * Pathnames observed answering HTTP 200 with a top-level `type: "OK"` JSON
 * envelope anywhere in the run. Memoized per bundle — the set backs the
 * `pathMustServeOk` anti-decoy rule.
 */
const okPathnamesCache = new WeakMap<EvidenceBundle, Set<string>>()
function okPathnamesOf(bundle: EvidenceBundle): Set<string> {
  const cached = okPathnamesCache.get(bundle)
  if (cached) return cached
  const out = new Set<string>()
  for (const ev of bundle.items) {
    if (ev.status !== 200) continue
    let body: unknown
    try { body = JSON.parse(ev.body ?? '') } catch { continue }
    if (!body || typeof body !== 'object' || (body as Record<string, unknown>).type !== 'OK') continue
    try { out.add(new URL(ev.url).pathname) } catch { /* unparseable url contributes nothing */ }
  }
  okPathnamesCache.set(bundle, out)
  return out
}

// ---------------------------------------------------------------------------
// Variable-capture + chaining (endpoint requirements)
// ---------------------------------------------------------------------------

/** Per-run capture scope: `varName -> value` extracted from a response body. */
type Bindings = Record<string, unknown>

type EndpointReq = Extract<PinnedRequirement, { kind: 'endpoint' }>

/** `{{var}}` token — dot/word chars only (matches a capture var name). */
const VAR_TOKEN = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g

/**
 * Interpolate every `{{var}}` in a string from the binding scope. A reference
 * to an unbound var is an ERROR (fail-closed) — the literal token is never
 * emitted onto the wire. Bound values render as their primitive text; a bound
 * object/array renders as compact JSON.
 */
function interpolateString(s: string, bindings: Bindings): { value: string } | { error: string } {
  let undef: string | undefined
  const value = s.replace(VAR_TOKEN, (_m, name: string) => {
    if (!Object.hasOwn(bindings, name)) {
      undef ??= name
      return ''
    }
    const v = bindings[name]
    if (v === null || v === undefined) return ''
    return typeof v === 'object' ? JSON.stringify(v) : String(v)
  })
  if (undef !== undefined) return { error: `undefined capture var {{${undef}}}` }
  return { value }
}

/** Deep-interpolate strings inside an arbitrary JSON value (body / expect). */
function interpolateDeep(value: unknown, bindings: Bindings): { value: unknown } | { error: string } {
  if (typeof value === 'string') return interpolateString(value, bindings)
  if (Array.isArray(value)) {
    const out: unknown[] = []
    for (const item of value) {
      const r = interpolateDeep(item, bindings)
      if ('error' in r) return r
      out.push(r.value)
    }
    return { value: out }
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      const r = interpolateDeep(v, bindings)
      if ('error' in r) return r
      out[k] = r.value
    }
    return { value: out }
  }
  return { value }
}

type ResolvedEndpoint =
  | { ok: true; method: string; url: string; body: unknown; expect: EndpointExpect }
  | { ok: false; detail: string }

/**
 * Resolve an endpoint requirement against the current binding scope: interpolate
 * method/path/body/expect, build the concrete URL, and RE-GATE it through the
 * SAME same-origin + publicly-routable + non-private check every pinned fetch
 * uses. Because a captured value is target-controlled, this gate is what stops a
 * malicious target from steering an interpolated path off-origin or at a
 * private/metadata address — such a resolution fails closed and is never
 * fetched. Deterministic in `bindings`, so observe and judge agree.
 */
function resolveEndpoint(req: EndpointReq, origin: string, bindings: Bindings): ResolvedEndpoint {
  const under = (detail: string): ResolvedEndpoint => ({
    ok: false,
    detail: `requirement ${req.id} references ${detail}`,
  })
  const m = interpolateString(req.method, bindings)
  if ('error' in m) return under(m.error)
  const p = interpolateString(req.path, bindings)
  if ('error' in p) return under(p.error)
  const b = interpolateDeep(req.body, bindings)
  if ('error' in b) return under(b.error)
  const e = interpolateDeep(req.expect, bindings)
  if ('error' in e) return under(e.error)

  let url: URL
  try {
    url = new URL(p.value, `${origin}/`)
  } catch {
    return { ok: false, detail: `requirement ${req.id} resolved to an unparseable url from path "${p.value}"` }
  }
  const resolvedUrl = url.toString()
  if (!isPubliclyRoutableSameOrigin(resolvedUrl, origin)) {
    return {
      ok: false,
      detail:
        `requirement ${req.id} resolved to off-origin/private url ${resolvedUrl} ` +
        '(a captured value must not steer the request off-origin) — refused, fail closed',
    }
  }
  return { ok: true, method: m.value.toUpperCase(), url: resolvedUrl, body: b.value, expect: e.value as EndpointExpect }
}

/**
 * Extract each `capture` dot-path from an observed response body and bind it.
 * A path that does not resolve (or a non-JSON body) leaves the var UNBOUND, so a
 * downstream `{{var}}` reference fails closed rather than silently skipping.
 */
function captureInto(bindings: Bindings, capture: Record<string, string>, ev: Evidence | undefined): void {
  let body: unknown
  try {
    body = JSON.parse(ev?.body ?? '')
  } catch {
    return
  }
  for (const [varName, path] of Object.entries(capture)) {
    const r = readPath(body, path)
    if (r.found) bindings[varName] = r.value
  }
}

/**
 * Judge one observed exchange against an expectation block. Pure; returns the
 * list of problems (empty = conforms). Shared by `endpoint` and `probe`
 * requirement kinds.
 */
function judgeExpect(ev: Evidence | undefined, expect: EndpointExpect): string[] {
  const problems: string[] = []
  if (!ev || ev.status === null) {
    problems.push(`fetch failed (${ev?.error ?? 'not observed'})`)
    return problems
  }
  const wanted = expect.status === undefined ? [200] : Array.isArray(expect.status) ? expect.status : [expect.status]
  if (!wanted.includes(ev.status)) problems.push(`status ${ev.status}, wanted ${wanted.join('|')}`)
  if (expect.contentTypeIncludes && !(ev.contentType ?? '').includes(expect.contentTypeIncludes)) {
    problems.push(`content-type ${ev.contentType}, wanted *${expect.contentTypeIncludes}*`)
  }
  if (expect.schema || expect.paths) {
    let body: unknown
    try { body = JSON.parse(ev.body ?? '') } catch { problems.push('body is not JSON') }
    if (body !== undefined) {
      if (expect.schema) {
        for (const v of validateSchema(body, expect.schema)) problems.push(`${v.path} ${v.message}`)
      }
      for (const p of expect.paths ?? []) {
        const r = readPath(body, p.path)
        if (p.exists !== undefined && r.found !== p.exists) problems.push(`path ${p.path} ${p.exists ? 'missing' : 'unexpectedly present'}`)
        if (p.equals !== undefined && (!r.found || JSON.stringify(r.value) !== JSON.stringify(p.equals))) {
          problems.push(`path ${p.path} = ${JSON.stringify(r.found ? r.value : undefined)}, wanted ${JSON.stringify(p.equals)}`)
        }
        // Numeric comparators — the pinned floor/ceiling. A comparator on a
        // path that is absent or non-numeric is itself a failure (the target
        // did not report the number the contract measures).
        const comparators: Array<[keyof typeof p, string, (a: number, b: number) => boolean]> = [
          ['gte', '>=', (a, b) => a >= b],
          ['lte', '<=', (a, b) => a <= b],
          ['gt', '>', (a, b) => a > b],
          ['lt', '<', (a, b) => a < b],
        ]
        for (const [key, sym, cmp] of comparators) {
          const bound = p[key] as number | undefined
          if (bound === undefined) continue
          if (!r.found || typeof r.value !== 'number') {
            problems.push(`path ${p.path} = ${JSON.stringify(r.found ? r.value : undefined)}, wanted a number ${sym} ${bound}`)
          } else if (!cmp(r.value, bound)) {
            problems.push(`path ${p.path} = ${r.value}, wanted ${sym} ${bound}`)
          }
        }
      }
    }
  }
  return problems
}
