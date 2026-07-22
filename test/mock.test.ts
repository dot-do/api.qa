import { describe, it, expect } from 'vitest'
import {
  generateExample,
  serveMock,
  enumerateMockOperations,
  DEFAULT_MOCK_SEED,
  MAX_MOCK_SPEC_BYTES,
} from '../src/mock.js'
import { contractDiff, resolveSchema } from '../src/contract.js'
import { validateSchema } from '../src/schema.js'
import { ROLE } from '../src/discovery.js'
import { createApp } from '../src/worker.js'
import { MemoryKV } from '../src/cache.js'
import type { MiniSchema, Evidence, EvidenceBundle } from '../src/types.js'

// ---------------------------------------------------------------------------
// A fixture OpenAPI 3.1 doc: a GET-safe object with required fields + enum +
// nested $ref + array + format + nullable; a $ref path; a POST (201); and a
// GET carrying a DECLARED example (used verbatim, not generated).
// ---------------------------------------------------------------------------

const SPEC = {
  openapi: '3.1.0',
  info: { title: 'Fixture', version: '1.0.0' },
  paths: {
    '/widgets': {
      get: {
        responses: {
          '200': {
            description: 'a widget',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['id', 'status', 'tags', 'owner'],
                  additionalProperties: false,
                  properties: {
                    id: { type: 'integer', minimum: 1, maximum: 100 },
                    status: { type: 'string', enum: ['active', 'archived'] },
                    email: { type: 'string', format: 'email' },
                    createdAt: { type: 'string', format: 'date-time' },
                    tags: { type: 'array', items: { type: 'string' } },
                    owner: { $ref: '#/components/schemas/Owner' },
                    nickname: { type: ['string', 'null'] },
                  },
                },
              },
            },
          },
        },
      },
      post: {
        responses: {
          '201': {
            description: 'created',
            content: {
              'application/json': {
                schema: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
              },
            },
          },
        },
      },
    },
    '/widgets/{id}': {
      get: {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: {
          '200': {
            description: 'an owner',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Owner' } } },
          },
        },
      },
    },
    '/health': {
      get: {
        responses: {
          '200': {
            description: 'liveness',
            content: {
              'application/json': {
                schema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' }, region: { type: 'string' } } },
                example: { ok: true, region: 'us-east-1' },
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      Owner: {
        type: 'object',
        required: ['name', 'role'],
        properties: {
          name: { type: 'string' },
          role: { type: 'string', enum: ['admin', 'member'] },
          manager: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        },
      },
    },
  },
}

const ROOT = SPEC as unknown as Record<string, unknown>

// ---------------------------------------------------------------------------
// generateExample — deterministic, schema-conformant per type
// ---------------------------------------------------------------------------

describe('generateExample — per-type deterministic values', () => {
  it('string → stable placeholder; format-aware', () => {
    expect(generateExample({ type: 'string' })).toBe('string')
    expect(generateExample({ type: 'string', format: 'email' } as MiniSchema)).toBe('a@example.com')
    expect(generateExample({ type: 'string', format: 'date-time' } as MiniSchema)).toBe('2020-01-01T00:00:00Z')
  })

  it('integer/number honor minimum/maximum', () => {
    const v = generateExample({ type: 'integer', minimum: 5, maximum: 5 } as MiniSchema)
    expect(v).toBe(5)
    const n = generateExample({ type: 'integer', minimum: 10, maximum: 20 } as MiniSchema) as number
    expect(Number.isInteger(n)).toBe(true)
    expect(n).toBeGreaterThanOrEqual(10)
    expect(n).toBeLessThanOrEqual(20)
  })

  it('boolean → stable bool', () => {
    expect(typeof generateExample({ type: 'boolean' })).toBe('boolean')
  })

  it('enum → first value; const → the const', () => {
    expect(generateExample({ enum: ['red', 'blue'] })).toBe('red')
    expect(generateExample({ const: 'api.qa' })).toBe('api.qa')
  })

  it('object recurses required + declared properties', () => {
    const v = generateExample({
      type: 'object',
      required: ['a'],
      properties: { a: { type: 'string' }, n: { type: 'integer', minimum: 1, maximum: 1 } },
    } as MiniSchema) as Record<string, unknown>
    expect(v.a).toBe('string')
    expect(v.n).toBe(1)
  })

  it('array → a single-element array of the item schema', () => {
    const v = generateExample({ type: 'array', items: { type: 'string' } }) as unknown[]
    expect(v).toEqual(['string'])
  })

  it('nullable (3.1 tuple) → first non-null member', () => {
    expect(generateExample({ type: ['string', 'null'] })).toBe('string')
    // pure-null type → null
    expect(generateExample({ type: ['null'] as MiniSchema['type'] })).toBeNull()
  })

  it('oneOf/anyOf → first branch, resolving a $ref branch', () => {
    expect(generateExample({ oneOf: [{ type: 'string' }, { type: 'integer' }] } as MiniSchema)).toBe('string')
    // a $ref branch is resolved against the root then generated
    const managerSchema = resolveSchema({ $ref: '#/components/schemas/Owner' }, ROOT)!
    const owner = generateExample(managerSchema) as Record<string, unknown>
    expect(owner.name).toBe('string')
    expect(owner.role).toBe('admin') // enum first value
  })

  it('$ref is resolved recursively (nested component)', () => {
    const schema = resolveSchema(
      (SPEC.paths['/widgets'].get.responses['200'].content['application/json'] as { schema: unknown }).schema,
      ROOT,
    )!
    const v = generateExample(schema) as Record<string, unknown>
    const owner = v.owner as Record<string, unknown>
    expect(owner.role).toBe('admin')
  })

  it('is deterministic: same (schema, seed) → identical; seed observable', () => {
    const schema: MiniSchema = { type: 'integer', minimum: 0, maximum: 1_000_000 } as MiniSchema
    expect(generateExample(schema, 42)).toBe(generateExample(schema, 42))
    // different seeds are allowed to differ (the seed is threaded through)
    expect(generateExample(schema, 1)).not.toBe(generateExample(schema, 999999))
  })
})

// ---------------------------------------------------------------------------
// Every generated body validates against its own schema (self-consistency)
// ---------------------------------------------------------------------------

describe('generated bodies are schema-conformant (self-consistent)', () => {
  it('every declared JSON response validates against its schema', () => {
    for (const op of enumerateMockOperations(SPEC)) {
      for (const r of op.responses) {
        if (!r.schema || r.hasExample) continue
        const body = generateExample(r.schema, DEFAULT_MOCK_SEED)
        expect(validateSchema(body, r.schema)).toEqual([])
      }
    }
  })
})

// ---------------------------------------------------------------------------
// serveMock — status, content-type, example precedence, matching, 404
// ---------------------------------------------------------------------------

describe('serveMock', () => {
  it('serves the declared status + JSON content-type with a conformant body', () => {
    const served = serveMock(SPEC, 'GET', '/widgets')!
    expect(served.status).toBe(200)
    expect(served.contentType).toBe('application/json')
    const body = JSON.parse(served.body)
    const schema = resolveSchema(
      (SPEC.paths['/widgets'].get.responses['200'].content['application/json'] as { schema: unknown }).schema,
      ROOT,
    )!
    expect(validateSchema(body, schema)).toEqual([])
    expect(body.status).toBe('active') // enum first
    expect(body.id).toBeGreaterThanOrEqual(1)
    expect(body.id).toBeLessThanOrEqual(100)
  })

  it('uses a DECLARED example verbatim rather than generating', () => {
    const served = serveMock(SPEC, 'GET', '/health')!
    expect(JSON.parse(served.body)).toEqual({ ok: true, region: 'us-east-1' })
  })

  it('serves the declared POST 201', () => {
    const served = serveMock(SPEC, 'POST', '/widgets')!
    expect(served.status).toBe(201)
    expect(JSON.parse(served.body)).toHaveProperty('id')
  })

  it('matches a templated path', () => {
    const served = serveMock(SPEC, 'GET', '/widgets/42')!
    expect(served.status).toBe(200)
    const owner = JSON.parse(served.body)
    expect(owner.role).toBe('admin')
  })

  it('an undeclared path → undefined (caller 404s)', () => {
    expect(serveMock(SPEC, 'GET', '/nope')).toBeUndefined()
    expect(serveMock(SPEC, 'DELETE', '/widgets')).toBeUndefined()
  })

  it('is deterministic: same request twice → identical body', () => {
    expect(serveMock(SPEC, 'GET', '/widgets')!.body).toBe(serveMock(SPEC, 'GET', '/widgets')!.body)
  })
})

// ---------------------------------------------------------------------------
// Worker routes — POST /mock (register) + */mock/:digest/<path> (serve)
// ---------------------------------------------------------------------------

function app() {
  return createApp({ REPORTS: new MemoryKV() })
}

async function register(a: ReturnType<typeof createApp>, spec: unknown): Promise<string> {
  const res = await a.fetch(new Request('https://api.qa/mock', { method: 'POST', body: JSON.stringify({ spec }) }))
  expect(res.status).toBe(200)
  return ((await res.json()) as { digest: string }).digest
}

describe('worker mock route', () => {
  it('POST /mock registers by digest and reports operations', async () => {
    const a = app()
    const res = await a.fetch(new Request('https://api.qa/mock', { method: 'POST', body: JSON.stringify({ spec: SPEC }) }))
    const body = (await res.json()) as { digest: string; operations: number; mock: string }
    expect(body.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(body.operations).toBe(4)
    expect(body.mock).toBe(`https://api.qa/mock/${body.digest}`)
  })

  it('POST /mock rejects a non-spec / empty-paths doc', async () => {
    const a = app()
    const res = await a.fetch(new Request('https://api.qa/mock', { method: 'POST', body: JSON.stringify({ spec: { openapi: '3.1.0', paths: {} } }) }))
    expect(res.status).toBe(400)
  })

  it('GET /mock/:digest/<path> serves status + content-type + conformant body', async () => {
    const a = app()
    const digest = await register(a, SPEC)
    const res = await a.fetch(new Request(`https://api.qa/mock/${digest}/widgets`))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/json')
    expect(res.headers.get('x-mock-server')).toBe('api.qa')
    const schema = resolveSchema(
      (SPEC.paths['/widgets'].get.responses['200'].content['application/json'] as { schema: unknown }).schema,
      ROOT,
    )!
    expect(validateSchema(await res.json(), schema)).toEqual([])
  })

  it('the SAME request twice returns the byte-identical body (deterministic)', async () => {
    const a = app()
    const digest = await register(a, SPEC)
    const one = await (await a.fetch(new Request(`https://api.qa/mock/${digest}/widgets`))).text()
    const two = await (await a.fetch(new Request(`https://api.qa/mock/${digest}/widgets`))).text()
    expect(one).toBe(two)
  })

  it('a declared example is served verbatim', async () => {
    const a = app()
    const digest = await register(a, SPEC)
    const res = await a.fetch(new Request(`https://api.qa/mock/${digest}/health`))
    expect(await res.json()).toEqual({ ok: true, region: 'us-east-1' })
  })

  it('serves a templated path and a POST operation', async () => {
    const a = app()
    const digest = await register(a, SPEC)
    const owner = await a.fetch(new Request(`https://api.qa/mock/${digest}/widgets/7`))
    expect(owner.status).toBe(200)
    const created = await a.fetch(new Request(`https://api.qa/mock/${digest}/widgets`, { method: 'POST' }))
    expect(created.status).toBe(201)
  })

  it('an undeclared path → 404', async () => {
    const a = app()
    const digest = await register(a, SPEC)
    const res = await a.fetch(new Request(`https://api.qa/mock/${digest}/does-not-exist`))
    expect(res.status).toBe(404)
  })

  it('an unknown digest → 404', async () => {
    const a = app()
    const res = await a.fetch(new Request('https://api.qa/mock/deadbeef/widgets'))
    expect(res.status).toBe(404)
  })

  it('the seed query changes generated numbers but stays deterministic per seed', async () => {
    const a = app()
    const digest = await register(a, SPEC)
    const s1 = await (await a.fetch(new Request(`https://api.qa/mock/${digest}/widgets?seed=1`))).text()
    const s1b = await (await a.fetch(new Request(`https://api.qa/mock/${digest}/widgets?seed=1`))).text()
    const s2 = await (await a.fetch(new Request(`https://api.qa/mock/${digest}/widgets?seed=2`))).text()
    expect(s1).toBe(s1b)
    // both remain schema-conformant regardless of seed
    const schema = resolveSchema(
      (SPEC.paths['/widgets'].get.responses['200'].content['application/json'] as { schema: unknown }).schema,
      ROOT,
    )!
    expect(validateSchema(JSON.parse(s2), schema)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// DOGFOOD — a contract-diff of the mock against its OWN spec is CLEAN.
// The mock is conformant to its own spec BY CONSTRUCTION, so the reusable
// contract engine (contract.ts) run over the served bodies finds zero
// deviations. This is the fixture guarantee (ax-e6b.28.1 / ax-e6b.28.4).
// ---------------------------------------------------------------------------

describe('dogfood — contract-diff of the mock vs its own spec is CLEAN', () => {
  it('serves each GET-safe operation and the contract-diff reports clean', async () => {
    const a = app()
    const digest = await register(a, SPEC)
    const target = 'https://fixture.test'
    const ev = (role: string, url: string, body: string): Evidence => ({
      role,
      url,
      method: 'GET',
      status: 200,
      contentType: 'application/json',
      headers: {},
      body,
      elapsedMs: 0,
    })

    const items: Evidence[] = [ev(ROLE.openapi, `${target}/openapi.json`, JSON.stringify(SPEC))]
    // Fetch each GET-safe declared path from the mock and record it as the
    // live contract evidence for that path.
    for (const path of ['/widgets', '/health']) {
      const res = await a.fetch(new Request(`https://api.qa/mock/${digest}${path}`))
      items.push(ev(ROLE.contract('GET', path), `${target}${path}`, await res.text()))
    }

    const bundle: EvidenceBundle = { target, fetchedAt: '2020-01-01T00:00:00Z', seed: 0, items }
    const report = contractDiff(bundle)
    expect(report.openapiValid).toBe(true)
    expect(report.operationsProbed).toBe(2)
    expect(report.deviations).toEqual([])
    expect(report.clean).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// resolveSchema — expansion budget (HIGH fix, ALSO hardens contract-diff:
// enumerateOperations there calls the SAME resolveSchema).
// ---------------------------------------------------------------------------

describe('resolveSchema — expansion budget bounds a non-cyclic fan-out $ref DAG (HIGH DoS fix)', () => {
  it('a fan-out(30,2) DAG resolves fast and without OOM (was O(2^depth) unbounded)', () => {
    // Each level's TWO properties $ref a DISTINCT next-level component, so the
    // same-path cycle guard never trips — before the budget fix this was an
    // unbounded 2^30 expansion.
    const schemas: Record<string, unknown> = {}
    const DEPTH = 30
    for (let i = 0; i <= DEPTH; i++) {
      schemas[`L${i}`] =
        i === DEPTH
          ? { type: 'string' }
          : {
              type: 'object',
              properties: {
                a: { $ref: `#/components/schemas/L${i + 1}` },
                b: { $ref: `#/components/schemas/L${i + 1}` },
              },
            }
    }
    const root = { components: { schemas } } as unknown as Record<string, unknown>
    const start = Date.now()
    const resolved = resolveSchema({ $ref: '#/components/schemas/L0' }, root)
    const elapsed = Date.now() - start
    expect(resolved).toBeDefined()
    expect(elapsed).toBeLessThan(2000)
  })

  it('a normal (non-adversarial) spec still resolves fully — the budget does not truncate real specs', () => {
    const schema = resolveSchema(
      (SPEC.paths['/widgets'].get.responses['200'].content['application/json'] as { schema: unknown }).schema,
      ROOT,
    )! as MiniSchema & { properties: Record<string, MiniSchema & { $ref?: string }> }
    // The nested $ref'd Owner is fully inlined (no surviving $ref anywhere).
    const owner = schema.properties.owner!
    expect(owner.$ref).toBeUndefined()
    expect(owner.properties?.name).toEqual({ type: 'string' })
    expect(owner.required).toEqual(['name', 'role'])
  })

  it("contract-diff still works (its resolveSchema calls are now budget-bounded)", () => {
    for (const op of enumerateMockOperations(SPEC)) {
      for (const r of op.responses) {
        if (!r.schema || r.hasExample) continue
        expect(validateSchema(generateExample(r.schema, DEFAULT_MOCK_SEED), r.schema)).toEqual([])
      }
    }
  })
})

// ---------------------------------------------------------------------------
// $ref inside oneOf/anyOf/allOf is dereferenced (HIGH fix).
// ---------------------------------------------------------------------------

describe('$ref inside a composition branch (oneOf/anyOf/allOf) is dereferenced (HIGH fix)', () => {
  const UNION_SPEC = {
    openapi: '3.1.0',
    info: { title: 'union', version: '1.0.0' },
    paths: {
      '/things': {
        get: {
          responses: {
            '200': {
              description: 'a thing or null',
              content: {
                'application/json': {
                  schema: { oneOf: [{ $ref: '#/components/schemas/Widget' }, { type: 'null' }] },
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Widget: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
      },
    },
  }

  it('resolveSchema dereferences the $ref branch instead of leaving it bare', () => {
    const root = UNION_SPEC as unknown as Record<string, unknown>
    const schema = resolveSchema(
      (UNION_SPEC.paths['/things'].get.responses['200'].content['application/json'] as { schema: unknown }).schema,
      root,
    ) as unknown as { oneOf: Array<Record<string, unknown>> }
    expect(schema.oneOf[0]!.$ref).toBeUndefined()
    expect(schema.oneOf[0]!.properties).toEqual({ id: { type: 'integer' } })
  })

  it('the mock emits a conformant body for the resolved branch, not {} (matches no branch)', () => {
    const served = serveMock(UNION_SPEC, 'GET', '/things')!
    const body = JSON.parse(served.body)
    expect(body).not.toEqual({})
    expect(body).toHaveProperty('id')
    expect(typeof body.id).toBe('number')
  })
})

// ---------------------------------------------------------------------------
// allOf: deep-merged in generation AND enforced (conjunctively) in validation
// (HIGH fix — previously first-branch-only / vacuous).
// ---------------------------------------------------------------------------

describe('allOf is honored (deep-merged) by the generator AND enforced by validateSchema (HIGH fix)', () => {
  const allOfSchema = {
    allOf: [
      { type: 'object', required: ['a'], properties: { a: { type: 'string' } } },
      { type: 'object', required: ['b'], properties: { b: { type: 'integer' } } },
    ],
  } as unknown as MiniSchema

  it('generates ONE value satisfying BOTH allOf branches (both required fields present)', () => {
    const body = generateExample(allOfSchema) as Record<string, unknown>
    expect(body).toHaveProperty('a')
    expect(body).toHaveProperty('b')
    expect(typeof body.a).toBe('string')
    expect(typeof body.b).toBe('number')
    expect(validateSchema(body, allOfSchema)).toEqual([])
  })

  it('validateSchema FAILS a body missing one allOf branch\'s required field', () => {
    const violations = validateSchema({ a: 'x' }, allOfSchema)
    expect(violations.some((v) => v.message === 'required property missing' && v.path === '$.b')).toBe(true)
  })

  it('validateSchema PASSES a body satisfying every allOf branch', () => {
    expect(validateSchema({ a: 'x', b: 1 }, allOfSchema)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Validation keywords honored by BOTH the generator and validateSchema
// (HIGH fix — previously unread by both, so violations passed silently).
// ---------------------------------------------------------------------------

describe('validation keywords are honored by the generator AND enforced by validateSchema (HIGH fix)', () => {
  it('maxLength truncates and minLength pads a generated string', () => {
    const shortSchema = { type: 'string', maxLength: 3 } as MiniSchema
    const v = generateExample(shortSchema) as string
    expect(v.length).toBeLessThanOrEqual(3)
    expect(validateSchema(v, shortSchema)).toEqual([])
    expect(validateSchema('toolong', shortSchema).length).toBeGreaterThan(0)

    const longSchema = { type: 'string', minLength: 10 } as MiniSchema
    const v2 = generateExample(longSchema) as string
    expect(v2.length).toBeGreaterThanOrEqual(10)
    expect(validateSchema(v2, longSchema)).toEqual([])
    expect(validateSchema('short', longSchema).length).toBeGreaterThan(0)
  })

  it('a simple pattern is honored by the generator; validateSchema enforces ANY pattern', () => {
    const schema = { type: 'string', pattern: '^\\d+$' } as MiniSchema
    const v = generateExample(schema) as string
    expect(/^\d+$/.test(v)).toBe(true)
    expect(validateSchema(v, schema)).toEqual([])
    expect(validateSchema('abc', schema).length).toBeGreaterThan(0)
  })

  it('minItems / maxItems / uniqueItems are honored by the generator and enforced by validateSchema', () => {
    const schema = {
      type: 'array',
      items: { type: 'string' },
      minItems: 3,
      maxItems: 5,
      uniqueItems: true,
    } as MiniSchema
    const v = generateExample(schema) as unknown[]
    expect(v.length).toBeGreaterThanOrEqual(3)
    expect(v.length).toBeLessThanOrEqual(5)
    expect(new Set(v.map((x) => JSON.stringify(x))).size).toBe(v.length)
    expect(validateSchema(v, schema)).toEqual([])
    expect(validateSchema(['a', 'a'], schema).length).toBeGreaterThan(0) // too few AND duplicate
  })

  it('multipleOf is honored by the generator and enforced by validateSchema', () => {
    const schema = { type: 'integer', multipleOf: 5, minimum: 1, maximum: 100 } as MiniSchema
    const v = generateExample(schema) as number
    expect(v % 5).toBe(0)
    expect(validateSchema(v, schema)).toEqual([])
    expect(validateSchema(7, schema).length).toBeGreaterThan(0)
  })

  it('exclusiveMinimum / exclusiveMaximum are honored by the generator and enforced by validateSchema', () => {
    const schema = { type: 'integer', exclusiveMinimum: 0, exclusiveMaximum: 10 } as MiniSchema
    const v = generateExample(schema) as number
    expect(v).toBeGreaterThan(0)
    expect(v).toBeLessThan(10)
    expect(validateSchema(v, schema)).toEqual([])
    expect(validateSchema(0, schema).length).toBeGreaterThan(0)
    expect(validateSchema(10, schema).length).toBeGreaterThan(0)
  })

  it('minProperties is honored by the generator and enforced by validateSchema', () => {
    const schema = {
      type: 'object',
      minProperties: 3,
      properties: { a: { type: 'string' } },
      required: ['a'],
    } as MiniSchema
    const v = generateExample(schema) as Record<string, unknown>
    expect(Object.keys(v).length).toBeGreaterThanOrEqual(3)
    expect(validateSchema(v, schema)).toEqual([])
    expect(validateSchema({ a: 'x' }, schema).length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// oneOf 'exactly one' (MED fix — a value must match EXACTLY one branch).
// ---------------------------------------------------------------------------

describe("oneOf generates a value matching EXACTLY ONE branch (MED fix)", () => {
  it('oneOf: [integer, number] no longer generates a value matching BOTH branches', () => {
    const branches = [{ type: 'integer' } as MiniSchema, { type: 'number' } as MiniSchema]
    const schema = { oneOf: branches } as unknown as MiniSchema
    const v = generateExample(schema)
    const matchCount = branches.filter((b) => validateSchema(v, b).length === 0).length
    expect(matchCount).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// POST /mock abuse-surface bounds: max spec body size + MAX_MOCK_SPECS
// registry cap (MED fix, mirrors MAX_MONITORS).
// ---------------------------------------------------------------------------

describe('POST /mock abuse-surface bounds (MED fix)', () => {
  it('refuses a spec body larger than MAX_MOCK_SPEC_BYTES with 413', async () => {
    const a = app()
    // A syntactically-valid, oversized JSON body (padding inside a string
    // value so it stays valid JSON but blows past the byte cap).
    const oversizedSpec = { ...SPEC, _pad: 'x'.repeat(MAX_MOCK_SPEC_BYTES + 1) }
    const res = await a.fetch(
      new Request('https://api.qa/mock', { method: 'POST', body: JSON.stringify({ spec: oversizedSpec }) }),
    )
    expect(res.status).toBe(413)
  })

  it('MAX_MOCK_SPECS caps the DISTINCT-spec registry with 429, but re-registering an existing spec stays idempotent', async () => {
    const a = createApp({ REPORTS: new MemoryKV(), MAX_MOCK_SPECS: '2' })
    const specFor = (n: number): unknown => ({
      openapi: '3.1.0',
      info: { title: `spec${n}`, version: '1' },
      paths: { [`/n${n}`]: { get: { responses: { '200': { description: 'ok' } } } } },
    })
    const post = (spec: unknown) =>
      a.fetch(new Request('https://api.qa/mock', { method: 'POST', body: JSON.stringify({ spec }) }))

    const r1 = await post(specFor(1))
    const r2 = await post(specFor(2))
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)

    const r3 = await post(specFor(3))
    expect(r3.status).toBe(429)
    expect(((await r3.json()) as { error: string }).error).toMatch(/registry full/)

    // Re-registering an ALREADY-stored spec (same digest) is idempotent — it
    // does not count against the cap even while at capacity.
    const again = await post(specFor(1))
    expect(again.status).toBe(200)
  })
})
