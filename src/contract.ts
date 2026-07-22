/**
 * Full OpenAPI 3.1 <-> live CONTRACT DIFF (ax-e6b.28.4).
 *
 * A PURE judge over an EvidenceBundle — same bundle → same report, byte for
 * byte. It generalizes the two honesty checks (schema-conformance,
 * claims-honesty): where those sampled a few 2xx bodies and flagged a claimed
 * endpoint that 404s, this enumerates EVERY declared (path, method, status,
 * content-type) and diffs the live response against the declared schema:
 *
 *   - status code matches a declared one; content-type matches;
 *   - the JSON body validates against the response schema (required fields,
 *     types, enums, additionalProperties — undeclared fields flagged);
 *   - ENDPOINT-level: declared-but-ABSENT (a declared GET-safe path that 404s
 *     or is unreachable = BREAKING / dishonest claim) and undeclared-but-
 *     PRESENT (a discovered endpoint the contract never declares = additive).
 *
 * Every deviation is CLASSIFIED breaking (a declared thing the live API
 * violates) vs additive (live has MORE than declared). The live evidence comes
 * ONLY through the gated Observer.observe — same-origin declared paths, recorded
 * in the bundle under the `contract:` (or the reused keyless `probe:endpoint:`)
 * roles. This module adds NO fetch surface of its own.
 */

import { ROLE, findEvidence, parseJsonBody, parseAgentsJson } from './discovery.js'
import { BUDGET_EXHAUSTED_ERROR } from './http.js'
import { validateSchema } from './schema.js'
import type {
  ContractDeviation,
  ContractDiffReport,
  ContractOperationDiff,
  Evidence,
  EvidenceBundle,
  MiniSchema,
} from './types.js'

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const

interface DeclaredResponse {
  status: string
  contentType?: string
  schema?: MiniSchema
}

interface DeclaredOperation {
  path: string
  /** Upper-case HTTP method. */
  method: string
  templated: boolean
  requiredParams: boolean
  secured: boolean
  /** GET-safe: a GET with no path template, no required params, no security. */
  probeable: boolean
  responses: DeclaredResponse[]
}

/**
 * Enumerate every declared HTTP operation of an OpenAPI 3.1 doc: (path, method)
 * plus each declared (status, content-type, schema). One-level $ref into
 * components.schemas is resolved. Deterministic order (path then method).
 */
export function enumerateOperations(doc: unknown): DeclaredOperation[] {
  if (!doc || typeof doc !== 'object') return []
  const root = doc as Record<string, unknown>
  const paths = root.paths as Record<string, unknown> | undefined
  if (!paths || typeof paths !== 'object') return []
  const ops: DeclaredOperation[] = []
  for (const [path, itemRaw] of Object.entries(paths)) {
    if (!itemRaw || typeof itemRaw !== 'object') continue
    const item = itemRaw as Record<string, unknown>
    const templated = path.includes('{')
    for (const m of HTTP_METHODS) {
      const opRaw = item[m]
      if (!opRaw || typeof opRaw !== 'object') continue
      const op = opRaw as Record<string, unknown>
      const params = Array.isArray(op.parameters) ? (op.parameters as Array<Record<string, unknown>>) : []
      const requiredParams = params.some((p) => p && p.required === true)
      const secured = Array.isArray(op.security) && op.security.length > 0
      const probeable = m === 'get' && !templated && !requiredParams && !secured
      ops.push({
        path,
        method: m.toUpperCase(),
        templated,
        requiredParams,
        secured,
        probeable,
        responses: enumerateResponses(op, root),
      })
    }
  }
  return ops.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method))
}

function enumerateResponses(op: Record<string, unknown>, root: Record<string, unknown>): DeclaredResponse[] {
  const responses = op.responses as Record<string, unknown> | undefined
  if (!responses || typeof responses !== 'object') return []
  const out: DeclaredResponse[] = []
  for (const [status, respRaw] of Object.entries(responses)) {
    if (!respRaw || typeof respRaw !== 'object') {
      out.push({ status })
      continue
    }
    const resp = respRaw as Record<string, unknown>
    const content = resp.content as Record<string, unknown> | undefined
    if (!content || typeof content !== 'object' || Object.keys(content).length === 0) {
      out.push({ status }) // e.g. 204 No Content — a declared status with no body
      continue
    }
    for (const [contentType, mediaRaw] of Object.entries(content)) {
      const media = mediaRaw && typeof mediaRaw === 'object' ? (mediaRaw as Record<string, unknown>) : undefined
      const schema = resolveSchema(media?.schema, root)
      out.push({ status, contentType, ...(schema ? { schema } : {}) })
    }
  }
  return out
}

/**
 * Resolve `$ref` into components.schemas RECURSIVELY — at the top level AND at
 * every nested schema position (`properties.*`, `items`, `additionalProperties`)
 * — so a component reference under a nested position is dereferenced exactly
 * like the top-level media-type schema. Before this fix, only the top-level
 * `$ref` was resolved: a nested `{ $ref }` node was left as-is, and
 * `validateSchema` treats an unrecognized node (no `type`/`properties`/`enum`/
 * `const`) as an EMPTY schema that accepts anything — so a violation under a
 * component reference (the normal real-spec shape) passed silently.
 *
 * `visited` guards against a `$ref` cycle (a schema that (in)directly refers to
 * itself): each ref name is added to a COPY of the set before descending into
 * the referenced schema, so a repeat of the SAME ref along the SAME resolution
 * path is caught and resolution stops there (returning an empty — accept-
 * anything — schema at the cycle point) rather than recursing forever. Sibling
 * branches that reuse the same component (not a cycle) are unaffected, since
 * each branch gets its own copy of `visited`.
 */
export function resolveSchema(schema: unknown, root: Record<string, unknown>, visited: ReadonlySet<string> = new Set()): MiniSchema | undefined {
  if (!schema || typeof schema !== 'object') return undefined
  const s = schema as Record<string, unknown>
  const ref = s.$ref
  if (typeof ref === 'string') {
    if (visited.has(ref)) return {} // cycle: stop resolving further, accept-anything at this point
    const m = ref.match(/^#\/components\/schemas\/(.+)$/)
    const components = root.components as Record<string, unknown> | undefined
    const schemas = components?.schemas as Record<string, unknown> | undefined
    if (m && schemas && m[1] && schemas[m[1]] && typeof schemas[m[1]] === 'object') {
      const nextVisited = new Set(visited)
      nextVisited.add(ref)
      return resolveSchema(schemas[m[1]], root, nextVisited)
    }
    return undefined
  }
  // Not a $ref: recursively resolve every nested schema position so no
  // component reference survives unresolved anywhere in the tree.
  const out: MiniSchema = { ...(s as MiniSchema) }
  if (out.properties) {
    const props: Record<string, MiniSchema> = {}
    for (const [key, sub] of Object.entries(out.properties)) {
      const resolved = resolveSchema(sub, root, visited)
      if (resolved) props[key] = resolved
    }
    out.properties = props
  }
  if (out.items) {
    const resolved = resolveSchema(out.items, root, visited)
    if (resolved) out.items = resolved
  }
  if (out.additionalProperties && typeof out.additionalProperties === 'object') {
    const resolved = resolveSchema(out.additionalProperties, root, visited)
    if (resolved) out.additionalProperties = resolved
  }
  return out
}

// ---------------------------------------------------------------------------
// The diff
// ---------------------------------------------------------------------------

/**
 * Live evidence for a declared GET-safe path. The dedicated contract probe
 * (`contract:GET <path>`) is preferred; a path that the seeded keyless sample
 * already fetched is REUSED from its `probe:endpoint:GET <path>` role so the
 * observer never double-fetches it.
 */
function liveEvidence(bundle: EvidenceBundle, path: string): Evidence | undefined {
  return (
    findEvidence(bundle, ROLE.contract('GET', path)) ??
    findEvidence(bundle, ROLE.keyless('GET', path))
  )
}

function isValidOpenapi(doc: unknown): boolean {
  if (!doc || typeof doc !== 'object') return false
  const d = doc as Record<string, unknown>
  const version = typeof d.openapi === 'string' ? d.openapi : typeof d.swagger === 'string' ? d.swagger : undefined
  return version !== undefined && !!d.paths && typeof d.paths === 'object'
}

/** True when the declared status pattern matches a live status: exact, NXX range, or `default`. */
function statusMatches(declared: string, live: number): boolean {
  if (declared === String(live)) return true
  if (/^[1-5]xx$/i.test(declared)) return Math.floor(live / 100) === Number(declared[0])
  return false
}

/** The bare media type, stripped of parameters ('application/json; charset=utf-8' → 'application/json'). */
function baseType(ct: string): string {
  return ct.split(';')[0]!.trim().toLowerCase()
}

/**
 * The full contract diff, pure over the bundle. Skips nothing — a caller
 * decides the verdict; this reports every deviation with its classification.
 */
export function contractDiff(bundle: EvidenceBundle): ContractDiffReport {
  const target = bundle.target
  const openapiEv = findEvidence(bundle, ROLE.openapi)
  const doc = parseJsonBody(openapiEv)
  const openapiValid = isValidOpenapi(doc)
  const ops = openapiValid ? enumerateOperations(doc) : []
  const declaredPaths = new Set(ops.map((o) => o.path))

  const perOperation: ContractOperationDiff[] = []
  const declaredButAbsent: ContractDeviation[] = []
  const undeclaredButPresent: ContractDeviation[] = []
  let operationsProbed = 0

  // ── Per (path, method) diff for every GET-safe operation ──────────────────
  for (const op of ops) {
    if (!op.probeable) continue
    const live = liveEvidence(bundle, op.path)
    const deviations: ContractDeviation[] = []
    const declaredStatuses = [...new Set(op.responses.map((r) => r.status))]
    const at = (extra: Partial<ContractDeviation>): ContractDeviation => ({
      path: op.path,
      method: op.method,
      location: '(endpoint)',
      kind: 'unknown',
      classification: 'breaking',
      detail: '',
      ...extra,
    })

    // UNPROBED (not a violation): the contract loop RESERVES budget for the
    // higher-value fixed probes (402-offer, MCP-OAuth, AAP) ahead of itself,
    // and — for an endpoint-rich target — may still cap out or drain the
    // shared politeness budget before reaching every declared GET-safe path.
    // That is a coverage limit, not a claim the target broke: report it as
    // `probed: false` with zero deviations, never as declared-but-absent /
    // breaking. Distinguished from a GENUINE fetch failure (dishonest claim,
    // still breaking below) by the exact budget-exhausted marker error.
    if (live === undefined || (live.status === null && live.error === BUDGET_EXHAUSTED_ERROR)) {
      perOperation.push({
        path: op.path,
        method: op.method,
        probed: false,
        liveStatus: null,
        declaredStatuses,
        deviations: [],
      })
      continue
    }

    operationsProbed++

    if (live.status === null) {
      // Declared, but unreachable — a dishonest claim (BREAKING).
      const d = at({
        kind: 'endpoint-unreachable',
        detail: `declared GET ${op.path} was not reachable (${live?.error ?? 'not probed'})`,
        expected: `one of [${declaredStatuses.join(', ') || '2xx'}]`,
        actual: 'unreachable',
      })
      deviations.push(d)
      declaredButAbsent.push(d)
    } else if (live.status === 404 && !op.responses.some((r) => statusMatches(r.status, 404))) {
      // Declared path that 404s and never declared a 404 — declared-but-ABSENT.
      const d = at({
        status: '404',
        kind: 'endpoint-absent',
        detail: `declared GET ${op.path} returned 404 — the contract claims an endpoint that does not exist`,
        expected: `one of [${declaredStatuses.join(', ') || '2xx'}]`,
        actual: '404',
      })
      deviations.push(d)
      declaredButAbsent.push(d)
    } else {
      const match =
        op.responses.find((r) => statusMatches(r.status, live.status!)) ??
        op.responses.find((r) => r.status.toLowerCase() === 'default')
      if (!match) {
        // A declared endpoint returning a status the contract never declares —
        // contract drift (BREAKING): a client written to the contract is unready.
        deviations.push(
          at({
            status: String(live.status),
            location: '(status)',
            kind: 'status-undeclared',
            detail: `GET ${op.path} returned ${live.status}, which is not among the declared statuses [${declaredStatuses.join(', ')}]`,
            expected: `one of [${declaredStatuses.join(', ')}]`,
            actual: String(live.status),
          }),
        )
      } else {
        // Content-type diff — only when the matched response declares one.
        if (match.contentType) {
          const wanted = baseType(match.contentType)
          const got = live.contentType ? baseType(live.contentType) : ''
          if (got !== wanted) {
            deviations.push(
              at({
                status: match.status,
                location: '(content-type)',
                kind: 'content-type-mismatch',
                detail: `GET ${op.path} (${match.status}) declared content-type ${wanted} but served ${got || '(none)'}`,
                expected: wanted,
                actual: got || '(none)',
              }),
            )
          }
        }
        // Body schema diff — only for a JSON response with a declared schema.
        if (match.schema && match.contentType && baseType(match.contentType).includes('json')) {
          const body = parseJsonBody(live)
          if (body === undefined) {
            deviations.push(
              at({
                status: match.status,
                location: '$',
                kind: 'not-json',
                detail: `GET ${op.path} (${match.status}) declares ${match.contentType} but the body did not parse as JSON`,
                expected: 'JSON matching the declared schema',
                actual: 'non-JSON body',
              }),
            )
          } else {
            // BREAKING: required-missing / wrong-type / enum / const — reuse the
            // shared structural validator, then map each violation with its path.
            for (const v of validateSchema(body, match.schema)) {
              deviations.push(
                at({
                  status: match.status,
                  location: v.path,
                  kind: violationKind(v.message),
                  classification: 'breaking',
                  detail: `GET ${op.path} (${match.status}) ${v.path}: ${v.message}`,
                }),
              )
            }
            // ADDITIVE (or BREAKING if the schema is closed): undeclared fields.
            collectUndeclaredFields(body, match.schema, '$', op, match.status, deviations)
          }
        }
      }
    }

    perOperation.push({
      path: op.path,
      method: op.method,
      probed: true,
      liveStatus: live?.status ?? null,
      declaredStatuses,
      deviations,
    })
  }

  // ── Undeclared-but-PRESENT: discovered endpoints the contract never declares ─
  // Reuse the keyless-candidate discovery: agents.json's declared GET http
  // endpoints, plus any keyless/contract probe that answered 2xx, whose
  // same-origin pathname is NOT a declared OpenAPI path.
  const agents = parseAgentsJson(parseJsonBody(findEvidence(bundle, ROLE.agentsJson)), target)
  const seenUndeclared = new Set<string>()
  const considerUndeclared = (pathname: string, live: Evidence | undefined): void => {
    if (declaredPaths.has(pathname) || seenUndeclared.has(pathname)) return
    if (!live || live.status === null || live.status < 200 || live.status >= 300) return
    seenUndeclared.add(pathname)
    const d: ContractDeviation = {
      path: pathname,
      method: 'GET',
      status: String(live.status),
      location: '(endpoint)',
      kind: 'endpoint-undeclared',
      classification: 'additive',
      detail: `GET ${pathname} answers ${live.status} but is not declared in the OpenAPI contract (ghost surface — additive)`,
      expected: 'a declared OpenAPI operation',
      actual: `live ${live.status}`,
    }
    undeclaredButPresent.push(d)
  }
  for (const e of agents.endpoints) {
    if (e.method !== 'GET') continue
    const pathname = sameOriginPath(e.url, target)
    if (pathname === undefined) continue
    considerUndeclared(pathname, liveEvidence(bundle, pathname))
  }
  // Any contract/keyless evidence whose path is undeclared but answered 2xx.
  for (const ev of bundle.items) {
    const pathname = pathFromRole(ev.role)
    if (pathname === undefined) continue
    considerUndeclared(pathname, ev)
  }

  const deviations = [
    ...perOperation.flatMap((o) => o.deviations),
    ...undeclaredButPresent,
  ]
  const breaking = deviations.filter((d) => d.classification === 'breaking').length
  const additive = deviations.length - breaking

  return {
    $type: 'ContractDiffReport',
    target,
    openapiValid,
    operationsDeclared: ops.length,
    operationsProbed,
    perOperation,
    declaredButAbsent,
    undeclaredButPresent,
    deviations,
    breaking,
    additive,
    clean: deviations.length === 0,
  }
}

/** Map a validateSchema message to a stable deviation kind. */
function violationKind(message: string): string {
  if (message.includes('required property missing')) return 'missing-required'
  if (message.startsWith('expected const')) return 'const-violation'
  if (message.startsWith('not in enum')) return 'enum-violation'
  if (message.startsWith('expected ')) return 'wrong-type'
  return 'schema-violation'
}

/**
 * Walk the response body against its schema and flag fields the declared schema
 * does not name. An extra field is ADDITIVE when the object is open (the JSON
 * Schema default, or `additionalProperties: true`), and BREAKING when the object
 * is CLOSED (`additionalProperties: false` — the contract promised these were
 * all the fields, and the live API broke that promise). An `additionalProperties`
 * SUBSCHEMA declares the extra field as allowed-but-typed — not undeclared.
 */
function collectUndeclaredFields(
  value: unknown,
  schema: MiniSchema,
  path: string,
  op: DeclaredOperation,
  status: string,
  out: ContractDeviation[],
): void {
  if (schema.enum !== undefined || schema.const !== undefined) return
  if (Array.isArray(value)) {
    if (schema.items) value.forEach((it, i) => collectUndeclaredFields(it, schema.items!, `${path}[${i}]`, op, status, out))
    return
  }
  if (value === null || typeof value !== 'object') return
  const isObjectSchema = schema.type === 'object' || schema.properties !== undefined
  if (!isObjectSchema) return
  const props = schema.properties ?? {}
  const ap = schema.additionalProperties
  for (const [key, sub] of Object.entries(value as Record<string, unknown>)) {
    if (Object.hasOwn(props, key)) {
      collectUndeclaredFields(sub, props[key]!, `${path}.${key}`, op, status, out)
    } else if (ap === false) {
      out.push({
        path: op.path,
        method: op.method,
        status,
        location: `${path}.${key}`,
        kind: 'closed-additional-property',
        classification: 'breaking',
        detail: `GET ${op.path} (${status}) ${path}.${key}: undeclared field on a closed object (additionalProperties: false) — the contract promised no extra fields`,
        expected: 'no additional properties',
        actual: `extra field "${key}"`,
      })
    } else if (ap === undefined || ap === true) {
      out.push({
        path: op.path,
        method: op.method,
        status,
        location: `${path}.${key}`,
        kind: 'undeclared-field',
        classification: 'additive',
        detail: `GET ${op.path} (${status}) ${path}.${key}: field present in the live response but not declared in the schema (additive)`,
        expected: 'declared property',
        actual: `extra field "${key}"`,
      })
    } else {
      // additionalProperties is a subschema — the extra field is allowed but
      // must match it; a mismatch is BREAKING, otherwise it is declared-open.
      for (const v of validateSchema(sub, ap)) {
        out.push({
          path: op.path,
          method: op.method,
          status,
          location: `${path}.${key}${v.path.slice(1)}`,
          kind: violationKind(v.message),
          classification: 'breaking',
          detail: `GET ${op.path} (${status}) additionalProperties ${path}.${key}: ${v.message}`,
        })
      }
    }
  }
}

function sameOriginPath(url: string, origin: string): string | undefined {
  try {
    const u = new URL(url, origin)
    return u.origin === origin ? u.pathname : undefined
  } catch {
    return undefined
  }
}

/** Extract the path from a `contract:GET <path>` or `probe:endpoint:GET <path>` role. */
function pathFromRole(role: string): string | undefined {
  const c = role.match(/^contract:GET (.+)$/)
  if (c) return c[1]
  const k = role.match(/^probe:endpoint:GET (.+)$/)
  if (k) return k[1]
  return undefined
}
