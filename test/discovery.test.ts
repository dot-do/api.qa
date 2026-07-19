import { describe, it, expect } from 'vitest'
import { Observer } from '../src/http.js'
import { observeTarget, deriveDiscovery, digestBundle } from '../src/discovery.js'
import { GOOD, goodTargetRoutes, makeFetcher, withOverrides, withoutRoutes } from './helpers.js'

async function observe(routes = goodTargetRoutes(), seed = 42) {
  const observer = new Observer({ fetcher: makeFetcher(routes), delayMs: 0 })
  return observeTarget(GOOD, observer, seed)
}

describe('discovery', () => {
  it('finds and validates all machine surfaces on a good target', async () => {
    const discovery = await deriveDiscovery(await observe())
    expect(discovery.surfaces.llmsTxt).toMatchObject({ present: true, valid: true })
    expect(discovery.surfaces.agentsJson).toMatchObject({ present: true, valid: true })
    expect(discovery.surfaces.icpJson).toMatchObject({ present: true, valid: true })
    expect(discovery.surfaces.openapi).toMatchObject({ present: true, valid: true })
    expect(discovery.claims.name).toBe('good.example')
    expect(discovery.claims.mcp?.tools).toContain('list_widgets')
    expect(discovery.claims.offers).toHaveLength(1)
    expect(discovery.claims.offerProbe?.url).toBe(`${GOOD}/offers/upgrade`)
  })

  it('collects claimed endpoints from agents.json and OpenAPI, skipping templates', async () => {
    const discovery = await deriveDiscovery(await observe())
    const urls = discovery.claims.endpoints.map((e) => e.url)
    expect(urls).toContain(`${GOOD}/api/status`)
    expect(urls).toContain(`${GOOD}/api/widgets`)
    // /api/widgets/{id} has a required path param — not a probe candidate
    expect(discovery.claims.endpoints.filter((e) => e.source === 'openapi').map((e) => e.url))
      .not.toContain(`${GOOD}/api/widgets/{id}`)
  })

  it('marks absent surfaces as not present', async () => {
    const discovery = await deriveDiscovery(
      await observe(withoutRoutes(goodTargetRoutes(), 'GET /icp.json', 'GET /llms.txt')),
    )
    expect(discovery.surfaces.icpJson.present).toBe(false)
    expect(discovery.surfaces.llmsTxt.present).toBe(false)
  })

  it('marks invalid JSON surfaces as present but invalid', async () => {
    const discovery = await deriveDiscovery(
      await observe(withOverrides(goodTargetRoutes(), {
        'GET /.well-known/agents.json': () => ({ status: 200, contentType: 'application/json', body: 'not json{' }),
      })),
    )
    expect(discovery.surfaces.agentsJson).toMatchObject({ present: true, valid: false })
  })

  it('evidence digest is deterministic: same target state + seed → same digest', async () => {
    const d1 = await digestBundle(await observe(goodTargetRoutes(), 7))
    const d2 = await digestBundle(await observe(goodTargetRoutes(), 7))
    expect(d1).toBe(d2)
  })

  it('evidence digest changes when the target changes', async () => {
    const d1 = await digestBundle(await observe(goodTargetRoutes(), 7))
    const d2 = await digestBundle(
      await observe(withOverrides(goodTargetRoutes(), {
        'GET /api/status': () => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, widgets: 4 }) }),
      }), 7),
    )
    expect(d1).not.toBe(d2)
  })

  it('different seeds may probe differently but the seed is recorded', async () => {
    const bundle = await observe(goodTargetRoutes(), 99)
    expect(bundle.seed).toBe(99)
  })
})
