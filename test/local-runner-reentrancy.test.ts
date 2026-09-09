/**
 * The local runner swaps process-wide state (globalThis.fetch, Math.random,
 * the document-form globals) for a run, so overlapping runs must be
 * serialized — and the gated fetch must reach the PLATFORM fetch, never an
 * ambient wrapper that delegates back to globalThis.fetch (gate → wrapper →
 * gate recursion: "Maximum call stack size exceeded", seen from the CLI
 * verify verb against a live property).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { localExecRunner, type ExecRunRequest } from '../src/exec/dialect.js'

const SUITE = `
import { origin } from 'suite:env'
describe('status', () => {
  it('answers', async () => { const r = await fetch(origin + '/api/status'); expect(r.status).toBe(200) })
  it('answers again', async () => { const r = await fetch(origin + '/api/status'); expect((await r.json()).ok).toBe(true) })
})
`
const req = (seed: number, sandbox = false): ExecRunRequest => ({
  artifactKind: 'document',
  testsSource: SUITE,
  origin: 'https://good.example',
  vars: {},
  environment: 'public',
  sandbox,
  seed,
  declarativeRows: 0,
  digest: `sha256:${seed}`,
})
const ok = async () => new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } })

describe('localExecRunner reentrancy', () => {
  it('serializes overlapping runs: every run registers and passes its own suite', async () => {
    const runner = localExecRunner({ fetch: ok })
    const outs = await Promise.all([1, 2, 3, 4].map((s) => runner.run(req(s))))
    for (const out of outs) {
      expect(out.status).toBe('ran')
      if (out.status !== 'ran') return
      expect(out.registered).toBe(2)
      expect(out.results.every((r) => r.status === 'pass')).toBe(true)
    }
  })

  describe('ambient fetch wrapper', () => {
    const saved = globalThis.fetch
    afterEach(() => {
      globalThis.fetch = saved
    })

    it('a host wrapper that delegates back to globalThis.fetch never recurses into the gate', async () => {
      // The hazard: a host patches fetch with a wrapper that resolves
      // globalThis.fetch LAZILY. If the gate's real fetch were the ambient
      // fetch at run start, gate → wrapper → gate would recurse forever.
      let hops = 0
      globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
        hops += 1
        return globalThis.fetch(input, init)
      }) as typeof fetch
      const out = await localExecRunner().run({ ...req(9), origin: 'https://unreachable.invalid' })
      // The run completes (network failures are fine here: the origin is a
      // name that cannot resolve) — what must never happen is the recursion.
      expect(out.status).toBe('ran')
      if (out.status !== 'ran') return
      for (const r of out.results) expect(String(r.reason ?? '')).not.toMatch(/call stack/i)
      expect(hops).toBe(0) // the gate reached the platform fetch directly
    })
  })
})

describe('Observer default transport as the gate\'s real fetch (the discovery wiring)', () => {
  it('does not recurse when the run swaps globalThis.fetch', async () => {
    const { Observer } = await import('../src/http.js')
    const observer = new Observer({ delayMs: 0 })
    const out = await localExecRunner().run({ ...req(11), origin: 'https://unreachable.invalid' }, { fetch: observer.transportFetcher })
    expect(out.status).toBe('ran')
    if (out.status !== 'ran') return
    for (const r of out.results) expect(String(r.reason ?? '')).not.toMatch(/call stack/i)
  })
})
