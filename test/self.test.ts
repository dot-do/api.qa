/**
 * The self-referential gate: api.qa must score 10/10 A+ on its own
 * checklist, discovered and judged through exactly the machinery it applies
 * to everyone else. If a change to the verifier breaks the verifier's own
 * surfaces — or a change to the surfaces breaks the checks — this fails.
 */

import { describe, it, expect } from 'vitest'
import { createApp } from '../src/worker.js'
import { verifyTarget } from '../src/verify.js'
import { verifyAttestation, generateSigningKey } from '../src/attest.js'
import { SELF_ORIGIN } from '../src/self.js'
import type { Fetcher } from '../src/http.js'

function loopbackFetcher(): Fetcher {
  const app = createApp()
  return (url, init) => app.fetch(new Request(url, init))
}

describe('api.qa verifies api.qa', () => {
  it('scores 10/10 and grades A+ on its own checklist', async () => {
    const report = await verifyTarget(SELF_ORIGIN, {
      mode: 'remote', fetcher: loopbackFetcher(), delayMs: 0, seed: 42,
      signingKeys: await generateSigningKey(),
    })
    for (const c of report.checks) {
      expect(c.verdict, `${c.id}: ${c.detail}`).not.toBe('fail')
    }
    expect(report.axScore.points).toBe(10)
    expect(report.grade).toBe('A+')
    expect(report.attested).toBe(true)
    expect(await verifyAttestation(report)).toBe(true)
  })

  it('the worker /self route returns its own graded report', async () => {
    const app = createApp()
    const res = await app.fetch(new Request('https://api.qa/self', { headers: { accept: 'application/json' } }))
    expect(res.status).toBe(200)
    const report = (await res.json()) as { grade: string; axScore: { points: number }; target: string }
    expect(report.target).toBe(SELF_ORIGIN)
    expect(report.grade).toBe('A+')
    expect(report.axScore.points).toBe(10)
  })

  it('the /api.qa domain route grades api.qa via loopback too', async () => {
    const app = createApp()
    const res = await app.fetch(new Request('https://api.qa/api.qa'))
    expect(res.status).toBe(200)
    const md = await res.text()
    expect(md).toContain('Grade A+')
    expect(md).toContain('AX score **10/10**')
  })
})
