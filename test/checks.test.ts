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
