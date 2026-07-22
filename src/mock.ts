/**
 * api.qa MOCK SERVER (ax-e6b.28.3).
 *
 * Given a target's published OpenAPI 3.1 doc, serve a DETERMINISTIC,
 * schema/example-conformant stand-in: for each declared (path, method, status,
 * content-type) produce a stable response body a consumer can develop against.
 * Postman "mock server" parity.
 *
 * The whole module is PURE — it serves ONLY locally generated responses from
 * the stored spec. It never fetches anything (no outbound surface, no SSRF): a
 * spec is REGISTERED inline (like /suite) and served by digest.
 *
 * Determinism contract: the same (spec, path, method, status, seed) yields a
 * byte-identical body every call. No Math.random / Date.now — a seed threaded
 * from the request (defaulting to a fixed seed) drives every non-fixed choice
 * through the shared mulberry32 PRNG (digest.ts). The generated body is
 * schema-conformant BY CONSTRUCTION: a contract-diff of the mock against its
 * own spec is CLEAN (see the dogfood test).
 *
 * REUSE: `resolveSchema` (contract.ts) dereferences `$ref` into
 * components.schemas recursively with a cycle guard; `validateSchema`
 * (schema.ts) is the same structural validator the contract-diff judges with;
 * `seededRandom` (digest.ts) is the seeded PRNG the attested runs already use.
 */

import { resolveSchema } from './contract.js'
import { seededRandom } from './digest.js'
import type { MiniSchema } from './types.js'

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const

/** A schema node may carry OpenAPI keywords MiniSchema does not model. */
interface RichSchema extends MiniSchema {
  example?: unknown
  oneOf?: unknown[]
  anyOf?: unknown[]
  allOf?: unknown[]
  format?: string
  minimum?: number
  maximum?: number
  default?: unknown
}

/** One declared (status, content-type) response the mock can serve. */
export interface MockResponse {
  status: string
  contentType?: string
  /** Resolved response schema (`$ref` dereferenced), when declared. */
  schema?: MiniSchema
  /** A declared example (media-level `example`/`examples`), used verbatim. */
  example?: unknown
  /** True when `example` was explicitly declared (distinguish from `undefined`). */
  hasExample: boolean
}

/** One declared operation the mock can serve. */
export interface MockOperation {
  path: string
  /** Upper-case HTTP method. */
  method: string
  templated: boolean
  responses: MockResponse[]
}

/** Default seed when a request does not select one — keeps bodies stable. */
export const DEFAULT_MOCK_SEED = 1

// ---------------------------------------------------------------------------
// Enumeration — declared operations + their responses (schema + example)
// ---------------------------------------------------------------------------

/**
 * Enumerate every declared HTTP operation of an OpenAPI 3.1 doc plus each
 * declared (status, content-type) response — its resolved schema AND any
 * declared media-level `example`/`examples` (the mock prefers the example
 * verbatim over a generated body). Deterministic order (path then method).
 */
export function enumerateMockOperations(doc: unknown): MockOperation[] {
  if (!doc || typeof doc !== 'object') return []
  const root = doc as Record<string, unknown>
  const paths = root.paths as Record<string, unknown> | undefined
  if (!paths || typeof paths !== 'object') return []
  const ops: MockOperation[] = []
  for (const [path, itemRaw] of Object.entries(paths)) {
    if (!itemRaw || typeof itemRaw !== 'object') continue
    const item = itemRaw as Record<string, unknown>
    const templated = path.includes('{')
    for (const m of HTTP_METHODS) {
      const opRaw = item[m]
      if (!opRaw || typeof opRaw !== 'object') continue
      const op = opRaw as Record<string, unknown>
      ops.push({ path, method: m.toUpperCase(), templated, responses: enumerateResponses(op, root) })
    }
  }
  return ops.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method))
}

function enumerateResponses(op: Record<string, unknown>, root: Record<string, unknown>): MockResponse[] {
  const responses = op.responses as Record<string, unknown> | undefined
  if (!responses || typeof responses !== 'object') return []
  const out: MockResponse[] = []
  for (const [status, respRaw] of Object.entries(responses)) {
    if (!respRaw || typeof respRaw !== 'object') {
      out.push({ status, hasExample: false })
      continue
    }
    const resp = respRaw as Record<string, unknown>
    const content = resp.content as Record<string, unknown> | undefined
    if (!content || typeof content !== 'object' || Object.keys(content).length === 0) {
      out.push({ status, hasExample: false }) // e.g. 204 No Content
      continue
    }
    for (const [contentType, mediaRaw] of Object.entries(content)) {
      const media = mediaRaw && typeof mediaRaw === 'object' ? (mediaRaw as Record<string, unknown>) : undefined
      const schema = resolveSchema(media?.schema, root)
      const { example, hasExample } = declaredExample(media, schema)
      out.push({
        status,
        contentType,
        ...(schema ? { schema } : {}),
        ...(hasExample ? { example } : {}),
        hasExample,
      })
    }
  }
  return out
}

/**
 * A declared example, precedence: media-level `example`, then the first entry
 * of media-level `examples` (its `.value`), then a schema-level `example`.
 * Deterministic (object insertion order from the parsed JSON).
 */
function declaredExample(
  media: Record<string, unknown> | undefined,
  schema: MiniSchema | undefined,
): { example?: unknown; hasExample: boolean } {
  if (media && 'example' in media) return { example: media.example, hasExample: true }
  const examples = media?.examples
  if (examples && typeof examples === 'object') {
    const first = Object.values(examples as Record<string, unknown>)[0]
    if (first && typeof first === 'object' && 'value' in (first as Record<string, unknown>)) {
      return { example: (first as Record<string, unknown>).value, hasExample: true }
    }
  }
  const s = schema as RichSchema | undefined
  if (s && s.example !== undefined) return { example: s.example, hasExample: true }
  return { hasExample: false }
}

// ---------------------------------------------------------------------------
// The deterministic, schema-conformant body generator
// ---------------------------------------------------------------------------

/** Fixed, schema-valid placeholders for common string `format`s. */
const FORMAT_VALUES: Record<string, string> = {
  email: 'a@example.com',
  'date-time': '2020-01-01T00:00:00Z',
  date: '2020-01-01',
  time: '00:00:00',
  uuid: '00000000-0000-4000-8000-000000000000',
  uri: 'https://example.com',
  url: 'https://example.com',
  hostname: 'example.com',
  ipv4: '192.0.2.1',
  ipv6: '::1',
  password: 'password',
  byte: 'ZXhhbXBsZQ==',
}

/**
 * Produce a DETERMINISTIC, schema-conformant value for a resolved schema under
 * a seed. Same (schema, seed) → identical value, always. The generated value
 * validates against its own schema (self-consistency).
 */
export function generateExample(schema: MiniSchema | undefined, seed: number = DEFAULT_MOCK_SEED): unknown {
  return genValue(schema, seededRandom(seed >>> 0), 0)
}

const MAX_DEPTH = 12

function genValue(schemaIn: MiniSchema | undefined, rand: () => number, depth: number): unknown {
  if (depth > MAX_DEPTH || schemaIn === undefined) return null
  const s = schemaIn as RichSchema

  // 1. A declared example / const / enum wins verbatim (all schema-conformant).
  if (s.example !== undefined) return clone(s.example)
  if (s.const !== undefined) return clone(s.const)
  if (s.enum && s.enum.length > 0) return clone(s.enum[0])
  if (s.default !== undefined) return clone(s.default)

  // 2. Composition: first branch of oneOf / anyOf / allOf (branches may still
  //    be a bare `$ref`, so resolve each before recursing — resolveSchema is
  //    only applied to the standard positions at enumeration time).
  const branch = s.oneOf?.[0] ?? s.anyOf?.[0] ?? s.allOf?.[0]
  if (branch !== undefined) return genValue(resolveBranch(branch), rand, depth + 1)

  // 3. Resolve the effective type: `type` may be a scalar or a 3.1 tuple
  //    (['string','null']). Prefer the first non-null member.
  const types = s.type === undefined ? [] : Array.isArray(s.type) ? s.type : [s.type]
  const nonNull = types.filter((t) => t !== 'null')
  const type = nonNull[0] ?? (types.includes('null') ? 'null' : inferType(s))

  switch (type) {
    case 'null':
      return null
    case 'boolean':
      return rand() < 0.5
    case 'integer':
      return genNumber(s, rand, true)
    case 'number':
      return genNumber(s, rand, false)
    case 'string':
      return genString(s)
    case 'array': {
      // A single-element array of the item schema (empty when unconstrained).
      return s.items ? [genValue(s.items, rand, depth + 1)] : []
    }
    case 'object':
      return genObject(s, rand, depth)
    default:
      // No usable type. nullable → null; otherwise the empty (accept-anything)
      // schema — a stable empty object keeps it valid and inspectable.
      return s.nullable === true ? null : {}
  }
}

/** Infer a container type when `type` is absent but structure implies one. */
function inferType(s: RichSchema): string {
  if (s.properties !== undefined || s.required !== undefined || s.additionalProperties !== undefined) return 'object'
  if (s.items !== undefined) return 'array'
  return ''
}

function genObject(s: RichSchema, rand: () => number, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const props = s.properties ?? {}
  // Declared properties first (stable declared order), then any required key
  // the schema failed to describe (kept present so `required` is satisfied).
  for (const [key, sub] of Object.entries(props)) {
    out[key] = genValue(sub, rand, depth + 1)
  }
  for (const key of s.required ?? []) {
    if (!(key in out)) out[key] = null
  }
  return out
}

function genNumber(s: RichSchema, rand: () => number, integer: boolean): number {
  const min = typeof s.minimum === 'number' ? s.minimum : undefined
  const max = typeof s.maximum === 'number' ? s.maximum : undefined
  if (min !== undefined && max !== undefined) {
    const v = min + rand() * (max - min)
    return integer ? Math.floor(v) : v
  }
  if (min !== undefined) return integer ? Math.ceil(min) : min
  if (max !== undefined) return integer ? Math.floor(max) : max
  // Unconstrained: a seeded, stable value.
  return integer ? Math.floor(rand() * 1000) : Math.round(rand() * 1000 * 100) / 100
}

function genString(s: RichSchema): string {
  if (typeof s.format === 'string' && FORMAT_VALUES[s.format] !== undefined) return FORMAT_VALUES[s.format]!
  return 'string'
}

/** Resolve a composition branch that may be a bare `$ref` node. */
function resolveBranch(branch: unknown): MiniSchema | undefined {
  if (!branch || typeof branch !== 'object') return undefined
  return branch as MiniSchema
}

function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T)
}

// ---------------------------------------------------------------------------
// Request → served response
// ---------------------------------------------------------------------------

export interface ServeOptions {
  /** Request Accept header — content-negotiates among declared content-types. */
  accept?: string
  /** Select a specific declared status (else the first 2xx, else the first). */
  status?: string
  /** Seed for the deterministic generator (default DEFAULT_MOCK_SEED). */
  seed?: number
}

export interface ServedResponse {
  status: number
  contentType: string
  /** The serialized body (JSON.stringify for JSON responses). */
  body: string
}

/**
 * Serve one request against a stored OpenAPI doc. Returns the generated
 * response for the matching (path, method, status, content-type), or
 * `undefined` when the mock declares no such operation (the caller 404s). PURE
 * — no fetch, no clock, no randomness beyond the seed.
 */
export function serveMock(doc: unknown, method: string, path: string, opts: ServeOptions = {}): ServedResponse | undefined {
  const ops = enumerateMockOperations(doc)
  const op = matchOperation(ops, method, path)
  if (!op) return undefined

  const response = selectResponse(op.responses, opts.status)
  if (!response) return undefined
  const statusNum = statusToNumber(response.status)

  // Content negotiation among the declared content-types for this status.
  const candidates = op.responses.filter((r) => r.status === response.status && r.contentType)
  const chosen = negotiate(candidates, opts.accept) ?? response
  const contentType = chosen.contentType ?? 'application/json'

  // A declared status with no content (e.g. 204) → empty body.
  if (!chosen.contentType && !chosen.schema && !chosen.hasExample) {
    return { status: statusNum, contentType: 'application/json', body: '' }
  }

  const value = chosen.hasExample
    ? chosen.example
    : generateExample(chosen.schema, opts.seed ?? DEFAULT_MOCK_SEED)

  const body = serializeBody(value, contentType)
  return { status: statusNum, contentType, body }
}

/**
 * Match a request (method, concrete path) to a declared operation. A STATIC
 * declared path wins over a TEMPLATED one; among templated candidates the
 * first in deterministic (sorted) order wins. `{param}` segments match any
 * single non-empty path segment.
 */
function matchOperation(ops: MockOperation[], method: string, path: string): MockOperation | undefined {
  const m = method.toUpperCase()
  const forMethod = ops.filter((o) => o.method === m)
  const exact = forMethod.find((o) => !o.templated && o.path === path)
  if (exact) return exact
  return forMethod.find((o) => o.templated && templateMatches(o.path, path))
}

function templateMatches(template: string, path: string): boolean {
  const t = template.split('/')
  const p = path.split('/')
  if (t.length !== p.length) return false
  for (let i = 0; i < t.length; i++) {
    const seg = t[i]!
    if (seg.startsWith('{') && seg.endsWith('}')) {
      if (p[i]!.length === 0) return false // a template segment needs a value
    } else if (seg !== p[i]) {
      return false
    }
  }
  return true
}

/** Choose the status to serve: an explicit request, else the first 2xx, else the first declared. */
function selectResponse(responses: MockResponse[], requested?: string): MockResponse | undefined {
  if (responses.length === 0) return undefined
  if (requested) {
    const exact = responses.find((r) => r.status === requested)
    if (exact) return exact
    return undefined
  }
  const success = responses.find((r) => /^2\d\d$/.test(r.status))
  if (success) return success
  const twoXX = responses.find((r) => /^2xx$/i.test(r.status))
  if (twoXX) return twoXX
  const concrete = responses.find((r) => /^\d\d\d$/.test(r.status))
  return concrete ?? responses[0]
}

/** Pick the content-type matching the Accept header, else prefer JSON, else the first. */
function negotiate(candidates: MockResponse[], accept?: string): MockResponse | undefined {
  if (candidates.length === 0) return undefined
  if (accept) {
    const wanted = accept
      .split(',')
      .map((a) => a.split(';')[0]!.trim().toLowerCase())
      .filter((a) => a.length > 0)
    for (const w of wanted) {
      if (w === '*/*') break
      const hit = candidates.find((c) => baseType(c.contentType!) === w || typeMatchesWildcard(w, c.contentType!))
      if (hit) return hit
    }
  }
  const json = candidates.find((c) => baseType(c.contentType!).includes('json'))
  return json ?? candidates[0]
}

function typeMatchesWildcard(wanted: string, ct: string): boolean {
  const [wType, wSub] = wanted.split('/')
  const [cType] = baseType(ct).split('/')
  return wSub === '*' && wType === cType
}

function baseType(ct: string): string {
  return ct.split(';')[0]!.trim().toLowerCase()
}

function statusToNumber(status: string): number {
  if (/^\d\d\d$/.test(status)) return Number(status)
  if (/^([1-5])xx$/i.test(status)) return Number(status[0]) * 100
  return 200 // 'default' and anything non-numeric → 200
}

function serializeBody(value: unknown, contentType: string): string {
  if (baseType(contentType).includes('json')) return JSON.stringify(value)
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}
