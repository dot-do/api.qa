/**
 * A WARM Worker Loader isolate (same content-hash id → same evaluated module
 * graph) must run the suite again in full: an ES module evaluates once, so
 * the suite's top-level describe/it calls happen only on the first run —
 * the shim records them and the entry replays them into the new harness.
 * Before this, the second run of the same digest registered nothing and
 * capability coverage collapsed.
 */
import { describe, expect, it } from 'vitest'
import { createOutboundGateway, workerLoaderExecRunner, type WorkerLoaderLike } from '../src/exec/runner.js'
import type { ExecRunRequest } from '../src/exec/dialect.js'

const rewrite = (source: string, map: Record<string, string>) =>
  source
    .replace(/(\bfrom\s*|\bimport\s*)(["'])([^"']*)\2/g, (w, lead: string, q: string, spec: string) =>
      map[spec] === undefined ? w : `${lead}${q}${map[spec]}${q}`,
    )
    .replace(/\bimport\s*\(\s*(["'])([^"']*)\1\s*\)/g, (w, q: string, spec: string) =>
      map[spec] === undefined ? w : `import(${q}${map[spec]}${q})`,
    )
const dataUrl = (s: string) => `data:text/javascript;charset=utf-8,${encodeURIComponent(s).replace(/'/g, '%27').replace(/"/g, '%22')}`

/**
 * A loader whose module graph is keyed by the loader id, exactly like the
 * platform: the same id gives back the SAME evaluated entry module, so the
 * second `fetch()` runs in a warm isolate.
 */
function warmLoader(gateway: { fetch(r: Request): Promise<Response> }): WorkerLoaderLike & { spins: number } {
  const entries = new Map<string, { fetch(): Promise<Response> }>()
  const self = {
    spins: 0,
    get: (id: string, getCode: Parameters<WorkerLoaderLike['get']>[1]) => ({
      getEntrypoint: () => ({
        fetch: async () => {
          let entry = entries.get(id)
          if (!entry) {
            self.spins += 1
            const code = await getCode()
            const mods = code.modules
            const map: Record<string, string> = {}
            map['./harness.mjs'] = dataUrl(mods['./harness.mjs']!.js + `\n//# warm:${id}:harness`)
            map['suite:env'] = dataUrl(mods['suite:env']!.js + `\n//# warm:${id}:env`)
            map['vitest'] = dataUrl(mods['vitest']!.js + `\n//# warm:${id}:vitest`)
            map['./suite-tests.mjs'] = dataUrl(rewrite(mods['./suite-tests.mjs']!.js, map) + `\n//# warm:${id}:tests`)
            const entryUrl = dataUrl(rewrite(mods[code.mainModule]!.js, map) + `\n//# warm:${id}:entry`)
            entry = ((await import(/* @vite-ignore */ entryUrl)) as { default: { fetch(): Promise<Response> } }).default
            entries.set(id, entry)
          }
          const g = globalThis as Record<string, unknown>
          const saved = { fetch: g.fetch, random: Math.random, reg: g.__APIQA_VITEST_RUNS__ }
          const savedGlobals = Object.fromEntries(['describe', 'it', 'test', 'expect', 'vi'].map((n) => [n, g[n]]))
          g.fetch = (input: string | URL | Request, init?: RequestInit) => gateway.fetch(new Request(input, init))
          try {
            return await entry.fetch()
          } finally {
            g.fetch = saved.fetch
            Math.random = saved.random
            g.__APIQA_VITEST_RUNS__ = saved.reg
            for (const [n, v] of Object.entries(savedGlobals)) {
              if (v === undefined) delete g[n]
              else g[n] = v
            }
          }
        },
      }),
    }),
  }
  return self
}

const okFetch = async () => new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } })

const suites: Array<[string, string]> = [
  [
    'module form (imports from vitest)',
    `import { describe, it, expect } from 'vitest'
import { origin } from 'suite:env'
describe('status', () => {
  it('answers', async () => { const r = await fetch(origin + '/api/status'); expect(r.status).toBe(200) })
  it('nested twice', () => { expect(1).toBe(1) })
})
it('top-level', () => { expect('a').toBe('a') })`,
  ],
  [
    'document form (globals)',
    `describe('status', () => {
  it('answers', async () => { const r = await fetch(origin + '/api/status'); expect(r.status).toBe(200) })
})
test('top-level test alias', () => { expect(2).toBe(2) })
import { origin } from 'suite:env'`,
  ],
]

describe('warm isolate reuse re-registers the whole suite', () => {
  for (const [label, testsSource] of suites) {
    it(label, async () => {
      const gateway = createOutboundGateway(okFetch)
      const loader = warmLoader(gateway)
      const runner = workerLoaderExecRunner(loader, { outbound: gateway })
      const req: ExecRunRequest = {
        artifactKind: 'document',
        testsSource,
        origin: 'https://good.example',
        vars: {},
        environment: 'public',
        sandbox: false,
        seed: 7,
        declarativeRows: 0,
        digest: `sha256:${label.length}`,
      }
      const first = await runner.run(req)
      const second = await runner.run(req)
      const third = await runner.run({ ...req, seed: 8 })
      expect(loader.spins).toBe(1) // same digest → one isolate, three runs
      for (const out of [first, second, third]) {
        expect(out.status).toBe('ran')
        if (out.status !== 'ran') return
        expect(out.results.map((r) => `${r.name}:${r.status}`)).toEqual(first.status === 'ran' ? first.results.map((r) => `${r.name}:${r.status}`) : [])
        expect(out.results.every((r) => r.status === 'pass')).toBe(true)
      }
      expect(first.status === 'ran' && first.results.length).toBe(label.startsWith('module') ? 3 : 2)
    })
  }
})
