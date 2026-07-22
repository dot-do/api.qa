import { describe, it, expect } from 'vitest'
import { Observer } from '../src/http.js'
import { observeTarget } from '../src/discovery.js'
import { runChecks } from '../src/checks.js'
import { axScoreOf, gradeOf } from '../src/grade.js'
import { GOOD, goodTargetRoutes, makeFetcher, withOverrides, withoutRoutes, type Routes } from './helpers.js'

async function judge(routes: Routes = goodTargetRoutes(), seed = 42) {
  const observer = new Observer({ fetcher: makeFetcher(routes), delayMs: 0 })
  const bundle = await observeTarget(GOOD, observer, seed)
  const checks = runChecks(bundle)
  const score = axScoreOf(checks)
  const { grade, notes } = gradeOf(score, checks)
  return { bundle, checks, score, grade, notes }
}

function verdictOf(checks: Awaited<ReturnType<typeof judge>>['checks'], id: string) {
  return checks.find((c) => c.id === id)?.verdict
}

describe('checks against the good target', () => {
  it('scores 10/10 and grades A+', async () => {
    const { checks, score, grade } = await judge()
    for (const c of checks) expect(c.verdict, `${c.id}: ${c.detail}`).not.toBe('fail')
    expect(score.points).toBe(10)
    expect(grade).toBe('A+')
  })

  it('is deterministic: judging the same bundle twice is byte-identical', async () => {
    const observer = new Observer({ fetcher: makeFetcher(goodTargetRoutes()), delayMs: 0 })
    const bundle = await observeTarget(GOOD, observer, 42)
    expect(JSON.stringify(runChecks(bundle))).toBe(JSON.stringify(runChecks(bundle)))
  })
})

describe('a keyless remote (HTTP) MCP is not penalized/capped (No-ask Zone, ax-q6o)', () => {
  const MCP_OAUTH_IDS = [
    'mcp-oauth-protected-resource',
    'mcp-oauth-as-metadata',
    'mcp-pkce',
    'mcp-oauth-dcr',
    'mcp-oauth-resource-indicators',
    'mcp-www-authenticate',
  ]

  it('keyless HTTP MCP (200 unauth, no OAuth well-knowns) → OAuth checks SKIP, grade stays A+ (no cap)', async () => {
    // Re-declare the good target's MCP as a REMOTE keyless HTTP endpoint and
    // answer the unauthenticated probe with a 200 (the server operates without
    // auth; it publishes NO OAuth well-knowns) — exactly .ax's own keyless-first
    // HTTP MCP face for the MCP-UI emitter / ChatGPT.
    const agentsBody = JSON.parse(
      goodTargetRoutes()['GET /.well-known/agents.json']!({ method: 'GET', accept: '*/*' }).body!,
    )
    agentsBody.interfaces.mcp = { transport: 'streamable-http', url: `${GOOD}/mcp`, tools: ['list_widgets'] }
    const routes = withOverrides(goodTargetRoutes(), {
      'GET /.well-known/agents.json': () => ({ status: 200, contentType: 'application/json', body: JSON.stringify(agentsBody) }),
      'GET /mcp': () => ({ status: 200, contentType: 'application/json', body: '{"jsonrpc":"2.0","id":1,"result":{}}' }),
    })
    const { checks, score, grade, notes } = await judge(routes)

    // Every MCP-OAuth sibling SKIPS — none fail.
    for (const id of MCP_OAUTH_IDS) {
      expect(verdictOf(checks, id), `${id}: ${checks.find((c) => c.id === id)?.detail}`).toBe('skip')
    }
    // AX-6 presence still passes for a remote transport + tools.
    expect(verdictOf(checks, 'mcp-declared')).toBe('pass')
    // No honesty check failed → NO cap. The surface reaches A+ on the rest.
    for (const c of checks) expect(c.verdict, `${c.id}: ${c.detail}`).not.toBe('fail')
    expect(score.points).toBe(10)
    expect(grade).toBe('A+')
    expect(notes.join(' ')).not.toMatch(/capped/)
  })
})

describe('each broken surface fails its own check', () => {
  it('missing llms.txt → llms-txt + linkset fail', async () => {
    const { checks } = await judge(withoutRoutes(goodTargetRoutes(), 'GET /llms.txt'))
    expect(verdictOf(checks, 'llms-txt')).toBe('fail')
    expect(verdictOf(checks, 'linkset')).toBe('fail')
  })

  it('no content negotiation (HTML for everyone) → content-negotiation fails', async () => {
    const { checks } = await judge(withOverrides(goodTargetRoutes(), {
      'GET /': () => ({ status: 200, contentType: 'text/html', body: '<!doctype html><html><body>wall of markup</body></html>' }),
    }))
    expect(verdictOf(checks, 'content-negotiation')).toBe('fail')
  })

  it('missing openapi → openapi fails, schema-conformance skips', async () => {
    const { checks } = await judge(withoutRoutes(goodTargetRoutes(), 'GET /openapi.json'))
    expect(verdictOf(checks, 'openapi')).toBe('fail')
    expect(verdictOf(checks, 'schema-conformance')).toBe('skip')
  })

  it('endpoints requiring keys → keyless-flow fails', async () => {
    const deny = () => ({ status: 401, contentType: 'application/json', body: '{"error":"key required"}' })
    const { checks } = await judge(withOverrides(goodTargetRoutes(), {
      'GET /api/status': deny,
      'GET /api/widgets': deny,
    }))
    expect(verdictOf(checks, 'keyless-flow')).toBe('fail')
  })

  it('offer probe answering 200 instead of a structured 402 → offers-402 fails', async () => {
    const { checks } = await judge(withOverrides(goodTargetRoutes(), {
      'GET /offers/upgrade': () => ({ status: 200, contentType: 'text/html', body: '<html>pricing page, call sales</html>' }),
    }))
    expect(verdictOf(checks, 'offers-402')).toBe('fail')
  })

  it('no mcp declaration → mcp-declared fails', async () => {
    const base = goodTargetRoutes()
    const agents = JSON.parse(
      (base['GET /.well-known/agents.json']!({ method: 'GET', accept: '*/*' }).body!),
    )
    delete agents.interfaces.mcp
    const { checks } = await judge(withOverrides(base, {
      'GET /.well-known/agents.json': () => ({ status: 200, contentType: 'application/json', body: JSON.stringify(agents) }),
    }))
    expect(verdictOf(checks, 'mcp-declared')).toBe('fail')
  })
})

describe('honesty checks cap the grade (the anti-Goodhart teeth)', () => {
  it('response violating the published schema → schema-conformance fails, grade capped at C', async () => {
    const { checks, score, grade, notes } = await judge(withOverrides(goodTargetRoutes(), {
      // claims {ok, widgets:integer}; serves strings — a lying contract
      'GET /api/status': () => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: 'yes' }) }),
    }))
    expect(verdictOf(checks, 'schema-conformance')).toBe('fail')
    expect(score.points).toBeGreaterThanOrEqual(9) // surfaces all still present…
    expect(['C', 'D', 'F']).toContain(grade) // …but the grade is capped
    expect(notes.join(' ')).toMatch(/capped at C/)
  })

  it('claimed endpoint that 404s → claims-honesty fails, grade capped', async () => {
    const { checks, grade } = await judge(withoutRoutes(goodTargetRoutes(), 'GET /api/widgets'))
    expect(verdictOf(checks, 'claims-honesty')).toBe('fail')
    expect(['C', 'D', 'F']).toContain(grade)
  })
})

// ---------------------------------------------------------------------------
// ax-c7m — content-negotiation grades application/json (grader blind-spot).
// A root that IGNORES Accept: application/json and hands an agent a wall of
// HTML is graded DOWN; a root that answers JSON passes; a root that has no
// JSON representation but negotiates md/html correctly is NOT false-failed.
// ---------------------------------------------------------------------------

function detailOf(checks: Awaited<ReturnType<typeof judge>>['checks'], id: string) {
  return checks.find((c) => c.id === id)?.detail ?? ''
}

describe('content-negotiation grades Accept: application/json (ax-c7m)', () => {
  const htmlWall = { status: 200, contentType: 'text/html', body: '<!doctype html><html><body>wall of markup</body></html>' }

  it('root that ignores Accept: application/json (returns HTML) is graded DOWN', async () => {
    const { checks, score } = await judge(withOverrides(goodTargetRoutes(), {
      // md/html negotiate correctly, but an agent asking for JSON gets HTML.
      'GET /': (req: { accept: string }) =>
        req.accept.includes('text/html')
          ? htmlWall
          : req.accept.includes('application/json')
            ? htmlWall
            : { status: 200, contentType: 'text/markdown', body: '# good.example\n\n> markdown for agents, long enough to be substantive content here.' },
    }))
    expect(verdictOf(checks, 'content-negotiation')).toBe('fail')
    expect(detailOf(checks, 'content-negotiation')).toMatch(/ignores Accept: application\/json/i)
    expect(score.points).toBeLessThan(10) // the AX-4 point is withheld
  })

  it('root that correctly returns JSON for Accept: application/json passes', async () => {
    const { checks } = await judge(withOverrides(goodTargetRoutes(), {
      'GET /': (req: { accept: string }) =>
        req.accept.includes('text/html')
          ? { status: 200, contentType: 'text/html', body: '<!doctype html><html><body><h1>good</h1></body></html>' }
          : req.accept.includes('application/json')
            ? { status: 200, contentType: 'application/json', body: JSON.stringify({ service: 'good.example' }) }
            : { status: 200, contentType: 'text/markdown', body: '# good.example\n\n> markdown for agents, long enough to be substantive content here.' },
    }))
    expect(verdictOf(checks, 'content-negotiation')).toBe('pass')
    expect(detailOf(checks, 'content-negotiation')).toMatch(/parseable JSON body/i)
  })

  it('root with NO JSON representation but correct md/html is NOT false-failed (partial credit)', async () => {
    // The default good target returns markdown (non-HTML) for application/json.
    const { checks, score, grade } = await judge()
    expect(verdictOf(checks, 'content-negotiation')).toBe('pass')
    expect(detailOf(checks, 'content-negotiation')).toMatch(/partial credit/i)
    expect(score.points).toBe(10)
    expect(grade).toBe('A+')
  })

  it('root serves a parseable JSON body under a non-JSON content-type — accurate detail, not "served no JSON body"', async () => {
    // LOW fix: a JSON body WAS served (it parses), just mislabeled as
    // text/plain. The old detail said "served no JSON body served", which is
    // inaccurate — distinguish "no JSON body at all" from "JSON body under
    // the wrong content-type". Verdict semantics unchanged (still a pass).
    const { checks, score, grade } = await judge(withOverrides(goodTargetRoutes(), {
      'GET /': (req: { accept: string }) =>
        req.accept.includes('text/html')
          ? { status: 200, contentType: 'text/html', body: '<!doctype html><html><body><h1>good</h1></body></html>' }
          : req.accept.includes('application/json')
            ? { status: 200, contentType: 'text/plain', body: JSON.stringify({ service: 'good.example' }) }
            : { status: 200, contentType: 'text/markdown', body: '# good.example\n\n> markdown for agents, long enough to be substantive content here.' },
    }))
    expect(verdictOf(checks, 'content-negotiation')).toBe('pass')
    const detail = detailOf(checks, 'content-negotiation')
    expect(detail).toMatch(/parseable JSON body under a non-JSON content-type/i)
    expect(detail).not.toMatch(/served no JSON body/i)
    expect(score.points).toBe(10)
    expect(grade).toBe('A+')
  })
})
