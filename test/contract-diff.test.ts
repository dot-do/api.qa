/**
 * Full OpenAPI 3.1 <-> live CONTRACT DIFF (ax-e6b.28.4).
 *
 * Acceptance: given a mock target whose live behavior DEVIATES from its
 * OpenAPI (missing required field, wrong type, enum violation, a declared
 * endpoint that 404s, an undeclared endpoint present), the diff enumerates
 * each deviation with the correct breaking/additive classification; a
 * CONFORMANT target yields a clean diff; the report is stable/deterministic
 * over recorded evidence. Dogfooded against a mock on the apis.directory
 * origin and against api.qa's own openapi.json shape. No network anywhere.
 */

import { describe, it, expect } from 'vitest'
import { Observer } from '../src/http.js'
import { observeTarget, ROLE } from '../src/discovery.js'
import { runChecks } from '../src/checks.js'
import { contractDiff } from '../src/contract.js'
import { axScoreOf, gradeOf } from '../src/grade.js'
import { verifyPinnedSpec } from '../src/pinned.js'
import { selfOpenapi, selfAgentsJson, selfIcpJson, selfLlmsTxt, SELF_ORIGIN } from '../src/self.js'
import { GOOD, goodTargetRoutes, makeFetcher, withOverrides, withoutRoutes, type Routes } from './helpers.js'

function json(body: unknown): { status: number; contentType: string; body: string } {
  return { status: 200, contentType: 'application/json', body: JSON.stringify(body) }
}

// A richer OpenAPI than the shared helper's — an enum and (optionally) a closed
// object, so type / enum / additionalProperties deviations can be exercised.
function richOpenapi(statusSchema?: unknown): unknown {
  return {
    openapi: '3.1.0',
    info: { title: 'good.example', version: '1.0.0' },
    servers: [{ url: GOOD }],
    paths: {
      '/api/status': {
        get: {
          responses: {
            '200': {
              description: 'ok',
              content: {
                'application/json': {
                  schema: statusSchema ?? {
                    type: 'object',
                    required: ['ok', 'widgets', 'level'],
                    properties: {
                      ok: { type: 'boolean' },
                      widgets: { type: 'integer' },
                      level: { type: 'string', enum: ['low', 'high'] },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/api/widgets': {
        get: {
          responses: {
            '200': {
              description: 'widgets',
              content: {
                'application/json': {
                  schema: { type: 'array', items: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
                },
              },
            },
          },
        },
      },
      '/api/widgets/{id}': {
        get: { parameters: [{ name: 'id', in: 'path', required: true }], responses: { '200': { description: 'one' } } },
      },
    },
  }
}

/** The reference rich target — CONFORMANT unless `over` breaks a surface. */
function richTarget(over: Routes = {}, openapi: unknown = richOpenapi()): Routes {
  return withOverrides(goodTargetRoutes(), {
    'GET /openapi.json': () => json(openapi),
    'GET /api/status': () => json({ ok: true, widgets: 3, level: 'low' }),
    'GET /api/widgets': () => json([{ id: 'w1' }, { id: 'w2' }]),
    ...over,
  })
}

async function run(routes: Routes, origin = GOOD, seed = 42) {
  const observer = new Observer({ fetcher: makeFetcher(routes, origin), delayMs: 0 })
  const bundle = await observeTarget(origin, observer, seed)
  const checks = runChecks(bundle)
  return { bundle, diff: contractDiff(bundle), checks }
}

function diffCheck(checks: Awaited<ReturnType<typeof run>>['checks']) {
  return checks.find((c) => c.id === 'contract-diff')!
}

// ---------------------------------------------------------------------------

describe('contract-diff — a CONFORMANT target yields a clean diff', () => {
  it('enumerates the contract and finds zero deviations; the check passes', async () => {
    const { diff, checks } = await run(richTarget())
    expect(diff.$type).toBe('ContractDiffReport')
    expect(diff.openapiValid).toBe(true)
    expect(diff.operationsDeclared).toBe(3) // status, widgets, widgets/{id}
    expect(diff.operationsProbed).toBe(2) // the two GET-safe paths ({id} is templated)
    expect(diff.clean).toBe(true)
    expect(diff.breaking).toBe(0)
    expect(diff.additive).toBe(0)
    expect(diff.declaredButAbsent).toHaveLength(0)
    expect(diff.undeclaredButPresent).toHaveLength(0)
    expect(diffCheck(checks).verdict).toBe('pass')
    // The structured report rides on the CheckResult (a monitorable signal).
    expect(diffCheck(checks).contractDiff).toEqual(diff)
  })

  it('is deterministic: diffing the same bundle twice is byte-identical', async () => {
    const { bundle } = await run(richTarget())
    expect(JSON.stringify(contractDiff(bundle))).toBe(JSON.stringify(contractDiff(bundle)))
  })

  it('probes EVERY GET-safe path, not just the seeded keyless sample of 3', async () => {
    // Six GET-safe operations — more than MAX_KEYLESS_PROBES(3). The contract
    // pass must fetch the ones the keyless sample missed (under contract: roles).
    const names = ['a', 'b', 'c', 'd', 'e', 'f']
    const paths: Record<string, unknown> = {}
    const agents = JSON.parse(goodTargetRoutes()['GET /.well-known/agents.json']!({ method: 'GET', accept: '*/*' }).body!)
    agents.interfaces.http = {} // declare ONLY the six paths, so nothing is an undeclared ghost
    const over: Routes = {}
    for (const n of names) {
      paths[`/api/${n}`] = {
        get: { responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } } } } } },
      }
      agents.interfaces.http[n] = { method: 'GET', url: `${GOOD}/api/${n}`, auth: 'none' }
      over[`GET /api/${n}`] = () => json({ id: n })
    }
    const openapi = { openapi: '3.1.0', info: { title: 't', version: '1' }, paths }
    const routes = withOverrides(withoutRoutes(goodTargetRoutes(), 'GET /api/status', 'GET /api/widgets'), {
      'GET /openapi.json': () => json(openapi),
      'GET /.well-known/agents.json': () => json(agents),
      ...over,
    })
    const { bundle, diff, checks } = await run(routes)
    expect(diff.operationsProbed).toBe(6)
    expect(diff.clean).toBe(true)
    expect(diffCheck(checks).verdict).toBe('pass')
    // At least one path was fetched under the dedicated contract role (beyond the sample).
    expect(bundle.items.some((e) => e.role.startsWith('contract:GET '))).toBe(true)
  })
})

describe('contract-diff — BREAKING deviations (a declared thing the live API violates)', () => {
  it('missing required field → breaking, classified at its JSON path', async () => {
    const { diff, checks } = await run(richTarget({ 'GET /api/status': () => json({ ok: true, level: 'low' }) }))
    const dev = diff.deviations.find((d) => d.location === '$.widgets')
    expect(dev?.kind).toBe('missing-required')
    expect(dev?.classification).toBe('breaking')
    expect(diff.breaking).toBeGreaterThanOrEqual(1)
    expect(diffCheck(checks).verdict).toBe('fail')
  })

  it('wrong type → breaking, with expected-vs-actual context', async () => {
    const { diff } = await run(richTarget({ 'GET /api/status': () => json({ ok: 'yes', widgets: 3, level: 'low' }) }))
    const dev = diff.deviations.find((d) => d.location === '$.ok')
    expect(dev?.kind).toBe('wrong-type')
    expect(dev?.classification).toBe('breaking')
    expect(dev?.detail).toMatch(/expected boolean, got string/)
  })

  it('enum violation → breaking', async () => {
    const { diff } = await run(richTarget({ 'GET /api/status': () => json({ ok: true, widgets: 3, level: 'medium' }) }))
    const dev = diff.deviations.find((d) => d.location === '$.level')
    expect(dev?.kind).toBe('enum-violation')
    expect(dev?.classification).toBe('breaking')
  })

  it('wrong type nested inside an array element → breaking at $[i].field', async () => {
    const { diff } = await run(richTarget({ 'GET /api/widgets': () => json([{ id: 'w1' }, { id: 5 }]) }))
    const dev = diff.deviations.find((d) => d.location === '$[1].id')
    expect(dev?.kind).toBe('wrong-type')
    expect(dev?.classification).toBe('breaking')
  })

  it('declared endpoint that 404s → declared-but-ABSENT, breaking', async () => {
    const { diff, checks } = await run(withoutRoutes(richTarget(), 'GET /api/widgets'))
    const absent = diff.declaredButAbsent.find((d) => d.path === '/api/widgets')
    expect(absent?.kind).toBe('endpoint-absent')
    expect(absent?.classification).toBe('breaking')
    expect(diffCheck(checks).verdict).toBe('fail')
  })

  it('declared endpoint returning an UNDECLARED status → breaking (contract drift)', async () => {
    const { diff } = await run(richTarget({ 'GET /api/status': () => ({ status: 418, contentType: 'application/json', body: '{}' }) }))
    const dev = diff.deviations.find((d) => d.path === '/api/status' && d.kind === 'status-undeclared')
    expect(dev?.classification).toBe('breaking')
    expect(dev?.actual).toBe('418')
  })

  it('content-type mismatch → breaking', async () => {
    const { diff } = await run(richTarget({ 'GET /api/status': () => ({ status: 200, contentType: 'text/html', body: '<html>nope</html>' }) }))
    const dev = diff.deviations.find((d) => d.path === '/api/status' && d.kind === 'content-type-mismatch')
    expect(dev?.classification).toBe('breaking')
    expect(dev?.expected).toBe('application/json')
  })

  it('undeclared field on a CLOSED object (additionalProperties:false) → breaking', async () => {
    const closed = {
      type: 'object',
      required: ['ok', 'widgets', 'level'],
      additionalProperties: false,
      properties: { ok: { type: 'boolean' }, widgets: { type: 'integer' }, level: { type: 'string', enum: ['low', 'high'] } },
    }
    const { diff } = await run(
      richTarget({ 'GET /api/status': () => json({ ok: true, widgets: 3, level: 'low', debug: 'x' }) }, richOpenapi(closed)),
    )
    const dev = diff.deviations.find((d) => d.location === '$.debug')
    expect(dev?.kind).toBe('closed-additional-property')
    expect(dev?.classification).toBe('breaking')
  })
})

describe('contract-diff — ADDITIVE deviations (live has MORE than declared)', () => {
  it('undeclared field on an OPEN object → additive, and the check still passes', async () => {
    const { diff, checks } = await run(richTarget({ 'GET /api/status': () => json({ ok: true, widgets: 3, level: 'low', extra: 1 }) }))
    const dev = diff.deviations.find((d) => d.location === '$.extra')
    expect(dev?.kind).toBe('undeclared-field')
    expect(dev?.classification).toBe('additive')
    expect(diff.breaking).toBe(0)
    expect(diff.additive).toBe(1)
    expect(diff.clean).toBe(false)
    expect(diffCheck(checks).verdict).toBe('pass') // additive-only never fails
  })

  it('undeclared-but-PRESENT endpoint → additive ghost surface', async () => {
    const base = goodTargetRoutes()
    const agents = JSON.parse(base['GET /.well-known/agents.json']!({ method: 'GET', accept: '*/*' }).body!)
    agents.interfaces.http.ghost = { method: 'GET', url: `${GOOD}/api/ghost`, auth: 'none' }
    const { diff, checks } = await run(
      richTarget({
        'GET /.well-known/agents.json': () => json(agents),
        'GET /api/ghost': () => json({ hello: 'world' }), // 2xx, not in the OpenAPI
      }),
    )
    const ghost = diff.undeclaredButPresent.find((d) => d.path === '/api/ghost')
    expect(ghost?.kind).toBe('endpoint-undeclared')
    expect(ghost?.classification).toBe('additive')
    expect(diff.breaking).toBe(0)
    expect(diffCheck(checks).verdict).toBe('pass')
  })
})

describe('contract-diff — breaking caps the grade (the anti-Goodhart teeth)', () => {
  it('a breaking deviation fails the honesty check and caps the grade at C', async () => {
    const { checks } = await run(richTarget({ 'GET /api/status': () => json({ ok: true, level: 'low' }) }))
    expect(diffCheck(checks).verdict).toBe('fail')
    const { grade, notes } = gradeOf(axScoreOf(checks), checks)
    expect(['C', 'D', 'F']).toContain(grade)
    expect(notes.join(' ')).toMatch(/capped at C/)
  })

  it('a fully conformant target keeps its A+ (contract-diff does not cap a clean surface)', async () => {
    const { checks } = await run(richTarget())
    const { grade } = gradeOf(axScoreOf(checks), checks)
    expect(grade).toBe('A+')
  })

  it('SKIPs (no cap) when the target publishes no OpenAPI to diff against', async () => {
    const { diff, checks } = await run(withoutRoutes(richTarget(), 'GET /openapi.json'))
    expect(diff.openapiValid).toBe(false)
    expect(diffCheck(checks).verdict).toBe('skip')
  })
})

describe('contract-diff — SSRF posture: same-origin probes only', () => {
  it('an off-origin servers[] entry never steers a fetch off the target origin', async () => {
    const evilOpenapi = {
      openapi: '3.1.0',
      info: { title: 't', version: '1' },
      // A hostile declared server — the diff must NEVER resolve paths against it.
      servers: [{ url: 'https://evil.example' }, { url: 'http://169.254.169.254' }],
      paths: (richOpenapi() as { paths: unknown }).paths,
    }
    const fetched: string[] = []
    const inner = makeFetcher(richTarget({}, evilOpenapi), GOOD)
    const observer = new Observer({
      fetcher: (url, init) => {
        fetched.push(url)
        return inner(url, init)
      },
      delayMs: 0,
    })
    const bundle = await observeTarget(GOOD, observer, 42)
    const diff = contractDiff(bundle)
    // Every fetch stayed same-origin; servers[] was ignored for probing.
    expect(fetched.every((u) => new URL(u).origin === GOOD)).toBe(true)
    expect(fetched.some((u) => u.includes('evil.example') || u.includes('169.254'))).toBe(false)
    expect(diff.clean).toBe(true)
  })
})

describe('contract-diff — nested $ref is resolved RECURSIVELY (not just the top-level media-type schema)', () => {
  // components.schemas.Owner <- components.schemas.Widget.properties.owner <- the
  // top-level response schema's properties.widget. Two levels of $ref beneath
  // the top-level schema — the shape a real OpenAPI spec actually uses.
  function nestedRefOpenapi(): unknown {
    return {
      openapi: '3.1.0',
      info: { title: 't', version: '1' },
      paths: {
        '/api/nested': {
          get: {
            responses: {
              '200': {
                description: 'ok',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      required: ['widget'],
                      properties: { widget: { $ref: '#/components/schemas/Widget' } },
                    },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          Widget: {
            type: 'object',
            required: ['id', 'owner'],
            properties: {
              id: { type: 'string' },
              owner: { $ref: '#/components/schemas/Owner' },
            },
          },
          Owner: {
            type: 'object',
            required: ['name'],
            properties: { name: { type: 'string' } },
          },
        },
      },
    }
  }

  async function runNested(body: unknown) {
    return run(
      withOverrides(goodTargetRoutes(), {
        'GET /openapi.json': () => json(nestedRefOpenapi()),
        'GET /api/nested': () => json(body),
      }),
    )
  }

  it('a violation TWO $ref-levels deep (wrong type under Widget.owner.name) is now DETECTED as breaking', async () => {
    const { diff, checks } = await runNested({ widget: { id: 'w1', owner: { name: 42 } } })
    const dev = diff.deviations.find((d) => d.location === '$.widget.owner.name')
    expect(dev?.kind).toBe('wrong-type')
    expect(dev?.classification).toBe('breaking')
    expect(diffCheck(checks).verdict).toBe('fail')
  })

  it('a required field missing UNDER a nested $ref (Widget.owner missing name) is now DETECTED as breaking', async () => {
    const { diff } = await runNested({ widget: { id: 'w1', owner: {} } })
    const dev = diff.deviations.find((d) => d.location === '$.widget.owner.name')
    expect(dev?.kind).toBe('missing-required')
    expect(dev?.classification).toBe('breaking')
  })

  it('a conformant nested-$ref\'d body has zero breaking deviations and the check passes', async () => {
    const { diff, checks } = await runNested({ widget: { id: 'w1', owner: { name: 'Bob' } } })
    // breaking (not `clean`): the base fixture's agents.json still declares
    // /api/status + /api/widgets, which this minimal openapi doesn't — those
    // are additive undeclared-but-present ghosts, not a conformance failure.
    expect(diff.breaking).toBe(0)
    expect(diffCheck(checks).verdict).toBe('pass')
  })

  it('a cyclic $ref (a schema that refers to itself) resolves without hanging or throwing', async () => {
    const cyclicOpenapi = {
      openapi: '3.1.0',
      info: { title: 't', version: '1' },
      paths: {
        '/api/node': {
          get: {
            responses: {
              '200': {
                description: 'ok',
                content: { 'application/json': { schema: { $ref: '#/components/schemas/Node' } } },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          Node: {
            type: 'object',
            required: ['value'],
            properties: {
              value: { type: 'string' },
              child: { $ref: '#/components/schemas/Node' }, // self-referential
            },
          },
        },
      },
    }
    const { diff, checks } = await run(
      withOverrides(goodTargetRoutes(), {
        'GET /openapi.json': () => json(cyclicOpenapi),
        'GET /api/node': () => json({ value: 'a', child: { value: 'b', child: { value: 'c' } } }),
      }),
    )
    // Completing at all (vitest's own timeout) proves the cycle guard held; the
    // shallow levels the guard DID resolve must still validate cleanly.
    expect(diff.$type).toBe('ContractDiffReport')
    expect(diffCheck(checks).verdict).not.toBe('skip')
  })
})

describe('contract-diff — budget priority (ax-e6b.28.4 starvation fix)', () => {
  const MCP_CHECK_IDS = [
    'mcp-oauth-protected-resource',
    'mcp-oauth-as-metadata',
    'mcp-pkce',
    'mcp-oauth-dcr',
    'mcp-oauth-resource-indicators',
    'mcp-www-authenticate',
  ] as const

  it('an endpoint-rich target (20 declared GET paths) + MCP + 402 + AAP does NOT starve the MCP-OAuth / 402 / AAP checks; the un-probed contract remainder is reported unprobed, never breaking', async () => {
    const N = 20
    const paths: Record<string, unknown> = {}
    const over: Routes = {}
    for (let i = 0; i < N; i++) {
      const name = `p${i}`
      paths[`/api/${name}`] = {
        get: {
          responses: {
            '200': {
              description: 'ok',
              content: {
                'application/json': {
                  schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
                },
              },
            },
          },
        },
      }
      over[`GET /api/${name}`] = () => json({ id: name })
    }
    const openapi = { openapi: '3.1.0', info: { title: 'rich', version: '1' }, paths }

    const agentsBody = JSON.parse(
      goodTargetRoutes()['GET /.well-known/agents.json']!({ method: 'GET', accept: '*/*' }).body!,
    )
    agentsBody.interfaces.mcp = { transport: 'streamable-http', url: `${GOOD}/mcp`, tools: ['list'] }

    const protectedResource = { resource: `${GOOD}/mcp`, authorization_servers: [GOOD] }
    const asMetadata = {
      issuer: GOOD,
      authorization_endpoint: `${GOOD}/authorize`,
      token_endpoint: `${GOOD}/token`,
      code_challenge_methods_supported: ['S256'],
      registration_endpoint: `${GOOD}/register`,
    }

    const routes = withOverrides(goodTargetRoutes(), {
      'GET /openapi.json': () => json(openapi),
      'GET /.well-known/agents.json': () => json(agentsBody),
      'GET /.well-known/agent-configuration': () => json({}),
      'GET /mcp': () => ({
        status: 401,
        contentType: 'application/json',
        body: '{}',
        headers: { 'www-authenticate': `Bearer resource_metadata="${GOOD}/.well-known/oauth-protected-resource"` },
      }),
      'GET /.well-known/oauth-protected-resource': () => json(protectedResource),
      'GET /.well-known/oauth-authorization-server': () => json(asMetadata),
      ...over,
    })

    const { bundle, diff, checks } = await run(routes)

    // The fixed high-value probes ran with priority — none starved to a null
    // status by the unbounded declared surface.
    for (const id of ['offers-402', ...MCP_CHECK_IDS]) {
      const c = checks.find((cc) => cc.id === id)
      expect(c, `check ${id} missing`).toBeDefined()
      expect(c!.verdict, `${id}: ${c!.detail}`).toBe('pass')
    }
    expect(bundle.items.find((e) => e.role === ROLE.agentConfiguration)?.status).not.toBeNull()
    expect(bundle.items.find((e) => e.role === ROLE.offer)?.status).toBe(402)
    expect(bundle.items.find((e) => e.role === ROLE.mcpUnauth)?.status).toBe(401)

    // Coverage is bounded (MAX_CONTRACT_PROBES), but the un-probed remainder is
    // reported as unprobed — never as a false declared-but-absent/breaking verdict.
    expect(diff.operationsDeclared).toBe(N)
    expect(diff.operationsProbed).toBeLessThan(N)
    expect(diff.breaking).toBe(0)
    expect(diff.declaredButAbsent).toHaveLength(0)
    const unprobedOps = diff.perOperation.filter((o) => !o.probed)
    expect(unprobedOps.length).toBeGreaterThan(0)
    expect(unprobedOps.every((o) => o.deviations.length === 0)).toBe(true)
    expect(diffCheck(checks).verdict).not.toBe('fail')
  })
})

describe('contract-diff — pinnable via kind:"check"', () => {
  it('a pinned contract binds contract-diff and PASSES a conformant target', async () => {
    const spec = JSON.stringify({
      $type: 'PinnedSpec',
      name: 'contract-diff-gate',
      version: '1',
      requirements: [{ id: 'diff', kind: 'check', check: 'contract-diff', must: 'pass' }],
    })
    const report = await verifyPinnedSpec(GOOD, spec, {
      fetcher: makeFetcher(richTarget()),
      delayMs: 0,
      seed: 1,
      mode: 'local',
    })
    expect(report.passed).toBe(true)
  })

  it('a pinned contract-diff gate FAILS a target whose live surface breaks the contract', async () => {
    const spec = JSON.stringify({
      $type: 'PinnedSpec',
      name: 'contract-diff-gate',
      version: '1',
      requirements: [{ id: 'diff', kind: 'check', check: 'contract-diff', must: 'pass' }],
    })
    const report = await verifyPinnedSpec(GOOD, spec, {
      fetcher: makeFetcher(richTarget({ 'GET /api/status': () => json({ ok: true, level: 'low' }) })),
      delayMs: 0,
      seed: 1,
      mode: 'local',
    })
    expect(report.passed).toBe(false)
    expect(report.requirements.find((r) => r.id === 'diff')?.verdict).toBe('fail')
  })
})

// ---------------------------------------------------------------------------
// Dogfood
// ---------------------------------------------------------------------------

describe('dogfood — contract-diff against a mock on the apis.directory origin', () => {
  const APIS = 'https://apis.directory'
  const apisOpenapi = {
    openapi: '3.1.0',
    info: { title: 'apis.directory', version: '1.0.0' },
    servers: [{ url: APIS }],
    paths: {
      '/api/apis': {
        get: {
          responses: {
            '200': {
              description: 'the directory',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['count', 'apis'],
                    properties: {
                      count: { type: 'integer' },
                      apis: { type: 'array', items: { type: 'object', required: ['domain'], properties: { domain: { type: 'string' } } } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  }
  const llms = '# apis.directory\n\n> The directory of agent-first APIs. See /.well-known/agents.json, /openapi.json, /icp.json.\n\nEverything one command deep.'
  const agents = {
    name: 'apis.directory',
    interfaces: { http: { list: { method: 'GET', url: `${APIS}/api/apis`, auth: 'none' } }, mcp: { transport: 'stdio', command: 'x', tools: ['list'] } },
    openapi: `${APIS}/openapi.json`,
    attestationLadder: [{ rung: 'anonymous' }],
    monetization: { offers: [{ id: 'pro', title: 'Pro' }] },
  }
  const icp = { contract: 'apis.directory/icp', agent_classes: [{ id: 'builder' }] }
  const apisRoutes = (over: Routes = {}): Routes => ({
    'GET /': (req) =>
      req.accept.includes('text/html')
        ? { status: 200, contentType: 'text/html', body: '<!doctype html><html><body><h1>apis.directory</h1></body></html>' }
        : { status: 200, contentType: 'text/markdown', body: llms },
    'GET /llms.txt': () => ({ status: 200, contentType: 'text/markdown', body: llms }),
    'GET /.well-known/agents.json': () => json(agents),
    'GET /icp.json': () => json(icp),
    'GET /openapi.json': () => json(apisOpenapi),
    'GET /api/apis': () => json({ count: 2, apis: [{ domain: 'good.example' }, { domain: 'api.qa' }] }),
    ...over,
  })

  it('a conformant directory diffs clean', async () => {
    const { diff, checks } = await run(apisRoutes(), APIS)
    expect(diff.openapiValid).toBe(true)
    expect(diff.operationsProbed).toBe(1)
    expect(diff.clean).toBe(true)
    expect(diffCheck(checks).verdict).toBe('pass')
  })

  it('a directory that drops the required `count` field is caught as breaking', async () => {
    const { diff, checks } = await run(apisRoutes({ 'GET /api/apis': () => json({ apis: [{ domain: 'good.example' }] }) }), APIS)
    const dev = diff.deviations.find((d) => d.location === '$.count')
    expect(dev?.kind).toBe('missing-required')
    expect(dev?.classification).toBe('breaking')
    expect(diffCheck(checks).verdict).toBe('fail')
  })
})

describe("dogfood — contract-diff against api.qa's own openapi.json shape", () => {
  const selfRoutes = (over: Routes = {}): Routes => ({
    'GET /': (req) =>
      req.accept.includes('text/html')
        ? { status: 200, contentType: 'text/html', body: '<!doctype html><html><body><h1>api.qa</h1></body></html>' }
        : { status: 200, contentType: 'text/markdown', body: selfLlmsTxt() },
    'GET /llms.txt': () => ({ status: 200, contentType: 'text/markdown', body: selfLlmsTxt() }),
    'GET /.well-known/agents.json': () => json(selfAgentsJson()),
    'GET /icp.json': () => json(selfIcpJson()),
    'GET /openapi.json': () => json(selfOpenapi()),
    'GET /health': () => json({ ok: true, verifier: 'api.qa', version: '0.1.0' }),
    ...over,
  })

  it('the self shape diffs with no breaking deviations (llms.txt is an additive ghost)', async () => {
    const { diff, checks } = await run(selfRoutes(), SELF_ORIGIN)
    expect(diff.openapiValid).toBe(true)
    // /health + /openapi.json are the two GET-safe declared operations.
    expect(diff.operationsProbed).toBe(2)
    expect(diff.breaking).toBe(0)
    expect(diffCheck(checks).verdict).toBe('pass')
    // agents.json declares GET /llms.txt (usage) — present, but not in the OpenAPI.
    expect(diff.undeclaredButPresent.some((d) => d.path === '/llms.txt')).toBe(true)
  })

  it("a /health that violates its declared const (ok:true) is caught as breaking", async () => {
    const { diff, checks } = await run(selfRoutes({ 'GET /health': () => json({ ok: false, verifier: 'api.qa', version: '0.1.0' }) }), SELF_ORIGIN)
    const dev = diff.deviations.find((d) => d.path === '/health' && d.location === '$.ok')
    expect(dev?.kind).toBe('const-violation')
    expect(dev?.classification).toBe('breaking')
    expect(diffCheck(checks).verdict).toBe('fail')
  })
})
