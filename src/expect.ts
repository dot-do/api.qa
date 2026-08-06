/**
 * The expectation engine — interpolation, endpoint resolution, capture and the
 * expectation judge. SHARED, deliberately, by every caller that has to decide
 * whether one observed exchange conforms to one pinned expectation.
 *
 * WHY THIS IS ITS OWN MODULE. These functions began life private to
 * `pinned.ts`, where `verifyPinnedSpec` was their only caller. They now have a
 * second one: the `published-test-suite` check judges a CARD-DECLARED suite,
 * and it must reach the SAME verdict `verifyPinnedSpec` would reach over the
 * same evidence. A second copy of the expectation judge — even a faithful one —
 * is precisely the drift this estate spends its effort preventing: the moment
 * two judges disagree, a target's conformance depends on which door asked.
 * So the judge is extracted, not forked, and both callers import this module.
 *
 * Everything here is PURE and deterministic in (evidence, expectation,
 * bindings). Nothing fetches. `resolveEndpoint` re-gates every resolved URL
 * through the shared same-origin + publicly-routable check, so a
 * TARGET-CONTROLLED captured value cannot steer a request off-origin no matter
 * which caller resolved it.
 */

import { isPubliclyRoutableSameOrigin } from './http.js'
import { validateSchema, readPath } from './schema.js'
import type { EndpointExpect, Evidence, PinnedRequirement } from './types.js'

// ---------------------------------------------------------------------------
// Variable-capture + chaining (endpoint requirements)
// ---------------------------------------------------------------------------

/** Per-run capture scope: `varName -> value` extracted from a response body. */
export type Bindings = Record<string, unknown>

export type EndpointReq = Extract<PinnedRequirement, { kind: 'endpoint' }>

/** `{{var}}` token — dot/word chars only (matches a capture var name). */
const VAR_TOKEN = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g

/** A string that is EXACTLY one `{{var}}` token, edge to edge (no surrounding text). */
const WHOLE_VALUE_TOKEN = /^\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}$/

/**
 * Interpolate every `{{var}}` in a string from the binding scope. A reference
 * to an unbound var is an ERROR (fail-closed) — the literal token is never
 * emitted onto the wire. Bound values render as their primitive text; a bound
 * object/array renders as compact JSON.
 *
 * This is the STRING-coercing path, used unconditionally for the URL path and
 * method (both are always strings on the wire) and for any partial/embedded
 * token (a token surrounded by other text, e.g. `/things/{{id}}`).
 */
export function interpolateString(s: string, bindings: Bindings): { value: string } | { error: string } {
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

/**
 * Interpolate a string leaf in a TYPED context (a JSON value inside `body` or
 * `expect` — e.g. `expect.paths[].equals`, an expected scalar, a body field).
 * When the ENTIRE string is a single whole-value `{{var}}` token, the RAW bound
 * value is substituted PRESERVING ITS TYPE (number / boolean / object / null),
 * so a captured numeric/boolean id chained into a typed compare or a JSON body
 * value is judged/serialized as the value it is — not falsely stringified to
 * `"1"` where `judgeExpect` would then mismatch `1`. Any other string (a
 * partial/embedded token, or plain text) falls through to string coercion.
 *
 * Surrounding whitespace is incidental ONLY for a NON-STRING binding: `'{{n}} '`
 * or `' {{n}} '` bound to a number/boolean/object/null is still a lone
 * whole-value token meant AS that value — whitespace cannot be part of the
 * intended literal — so it is TRIMMED before classification and the RAW typed
 * value is substituted (otherwise the trailing space would push it onto the
 * string-coercing path and silently false-FAIL a compliant numeric target,
 * `"1 "` vs `1`). But for a STRING binding the surrounding whitespace MAY be an
 * intended literal (`' {{tid}} '` with tid = 'hello' meaning the literal
 * ' hello '), so a string value keeps the string-coercing in-place path, which
 * substitutes the token where it sits and PRESERVES the surrounding whitespace.
 * (An edge-to-edge string token `'{{tid}}'` coerces to the identical raw string,
 * so it is unaffected either way.) A token adjacent to NON-whitespace text
 * (`'v{{n}}'`, `'{{a}}{{b}}'`) is genuine embedded interpolation and coerces.
 */
function interpolateTypedString(s: string, bindings: Bindings): { value: unknown } | { error: string } {
  const whole = WHOLE_VALUE_TOKEN.exec(s.trim())
  if (whole) {
    const name = whole[1]!
    if (!Object.hasOwn(bindings, name)) return { error: `undefined capture var {{${name}}}` }
    const v = bindings[name]
    // Preserve TYPE (trimming incidental whitespace) only when whitespace cannot
    // be part of an intended literal — i.e. the bound value is NON-STRING. A
    // STRING binding falls through to the string-coercing path below, which
    // preserves any surrounding whitespace in `s`.
    if (typeof v !== 'string') return { value: v }
  }
  return interpolateString(s, bindings)
}

/** Deep-interpolate strings inside an arbitrary JSON value (body / expect). */
export function interpolateDeep(value: unknown, bindings: Bindings): { value: unknown } | { error: string } {
  if (typeof value === 'string') return interpolateTypedString(value, bindings)
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

export type ResolvedEndpoint =
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
export function resolveEndpoint(req: EndpointReq, origin: string, bindings: Bindings): ResolvedEndpoint {
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
export function captureInto(bindings: Bindings, capture: Record<string, string>, ev: Evidence | undefined): void {
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
export function judgeExpect(ev: Evidence | undefined, expect: EndpointExpect): string[] {
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
        // Closed-vocabulary membership (e.g. AXP pricing model ∈ [free, metered]).
        if (p.oneOf !== undefined &&
            (!r.found || !p.oneOf.some((v) => JSON.stringify(v) === JSON.stringify(r.value)))) {
          problems.push(`path ${p.path} = ${JSON.stringify(r.found ? r.value : undefined)}, wanted one of ${JSON.stringify(p.oneOf)}`)
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
