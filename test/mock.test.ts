import { describe, it, expect } from 'vitest'
import {
  generateExample,
  serveMock,
  enumerateMockOperations,
  DEFAULT_MOCK_SEED,
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
