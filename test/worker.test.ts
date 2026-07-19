import { describe, it, expect } from 'vitest'
import { createApp } from '../src/worker.js'
import { goodTargetRoutes, makeFetcher, GOOD } from './helpers.js'

function app() {
  return createApp({}, { externalFetcher: makeFetcher(goodTargetRoutes()), externalDelayMs: 0 })
}

const req = (path: string, init?: RequestInit) => new Request(`https://api.qa${path}`, init)

describe('worker machine surfaces', () => {
  it('content-negotiates the root: curl gets markdown, browsers get HTML', async () => {
    const asCurl = await app().fetch(req('/', { headers: { accept: '*/*' } }))
    expect(await asCurl.text()).toMatch(/^# api\.qa/)
    const asBrowser = await app().fetch(req('/', { headers: { accept: 'text/html,application/xhtml+xml' } }))
    expect(await asBrowser.text()).toMatch(/^<!doctype html>/)
  })

  it('serves llms.txt, agents.json, icp.json, openapi.json, health', async () => {
    const a = app()
    expect((await a.fetch(req('/llms.txt'))).status).toBe(200)
    const agents = (await (await a.fetch(req('/.well-known/agents.json'))).json()) as { name: string }
    expect(agents.name).toBe('api.qa')
    const icp = (await (await a.fetch(req('/icp.json'))).json()) as { agent_classes: unknown[] }
    expect(icp.agent_classes.length).toBeGreaterThan(0)
    const openapi = (await (await a.fetch(req('/openapi.json'))).json()) as { openapi: string }
    expect(openapi.openapi).toBe('3.1.0')
    const health = (await (await a.fetch(req('/health'))).json()) as { ok: boolean }
    expect(health.ok).toBe(true)
  })

  it('sends a Link header linkset on every response', async () => {
    const res = await app().fetch(req('/health'))
    expect(res.headers.get('link')).toContain('agents.json')
  })

  it('the 402 boundary is a structured offer, not an error page', async () => {
    const res = await app().fetch(req('/offers/attested-run'))
    expect(res.status).toBe(402)
    const offer = (await res.json()) as { id: string; alternatives: unknown[] }
    expect(offer.id).toBe('attested-run')
    expect(offer.alternatives.length).toBeGreaterThan(0)
  })
})

describe('worker report routes', () => {
  it('GET /{domain} verifies an external target and content-negotiates the report', async () => {
    const a = app()
    const md = await (await a.fetch(req('/good.example'))).text()
    expect(md).toContain('# api.qa report — good.example')
    expect(md).toContain('Grade A+')

    const htmlRes = await a.fetch(req('/good.example', { headers: { accept: 'text/html' } }))
    const html = await htmlRes.text()
    expect(html).toContain('application/ld+json')
    expect(html).toContain('ClaimReview')

    const jsonRes = await a.fetch(req('/good.example', { headers: { accept: 'application/json' } }))
    const report = (await jsonRes.json()) as { grade: string; attested: boolean; evidence: { items: unknown[] } }
    expect(report.grade).toBe('A+')
    expect(report.attested).toBe(true)
    expect(report.evidence.items.length).toBeGreaterThan(5)
  })

  it('refuses private targets (SSRF guard) with a 400', async () => {
    const res = await app().fetch(req('/localhost.local'))
    expect(res.status).toBe(400)
  })

  it('POST /verify runs pinned-spec mode and enforces the digest pin', async () => {
    const spec = {
      $type: 'PinnedSpec', name: 'mini', version: '1',
      requirements: [{ id: 'status-ok', kind: 'endpoint', method: 'GET', path: '/api/status', expect: { status: 200 } }],
    }
    const okRes = await app().fetch(req('/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: GOOD, spec, seed: 1 }),
    }))
    expect(okRes.status).toBe(200)
    const report = (await okRes.json()) as { passed: boolean }
    expect(report.passed).toBe(true)

    const badRes = await app().fetch(req('/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: GOOD, spec, expectedDigest: 'deadbeef' }),
    }))
    expect(badRes.status).toBe(400)
    expect(((await badRes.json()) as { error: string }).error).toMatch(/digest mismatch/)
  })

  it('unknown routes answer with a pointer to llms.txt', async () => {
    const res = await app().fetch(req('/no/such/route'))
    expect(res.status).toBe(404)
    expect(((await res.json()) as { see: string }).see).toContain('llms.txt')
  })
})
