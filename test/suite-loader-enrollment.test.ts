/**
 * SUITE_LOADER enrollment (2026-08-08) — the config + wiring invariants that
 * make the hosted `api.qa/vitest@1` runner REAL on the deployed worker.
 *
 * Three families, all cheap and all load-bearing:
 *
 *  1. CONFIG — wrangler.jsonc actually enables the pieces the runner
 *     feature-detects: `worker_loaders` binding SUITE_LOADER, and the
 *     SUITE_OUTBOUND same-worker loopback service binding naming the
 *     SuiteGateway entrypoint. (The code path survives their absence by
 *     design — these pins assert the ENROLLED state so a silent config
 *     regression cannot quietly demote the runner to `runner-unavailable`.)
 *
 *  2. THE ENTRY SPLIT — src/exec/gateway.ts imports `cloudflare:workers`,
 *     which only workerd resolves, so it may be imported ONLY by the wrangler
 *     entry (src/entry.ts) and NEVER by src/worker.ts or anything the vitest
 *     graph reaches (the apis-vin entry-only import trick). The entry must
 *     also re-export the worker default handler and BOTH Durable Object
 *     classes, because wrangler discovers DO classes as named exports of
 *     `main` — dropping one would break the deploy's migrations.
 *
 *  3. THE RPC DRAIN SHAPE — in production SUITE_OUTBOUND is a service-binding
 *     stub whose `drainViolations` is an async RPC returning a structured
 *     clone. The runner's auto-detection (`hasDrain`) must treat that shape
 *     as the out-of-band record, so a forged all-green isolate body still
 *     fails on a gateway-recorded refusal (A.8.6.3 fail-closed totality).
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createOutboundGateway,
  workerLoaderExecRunner,
  RUNNER_UNAVAILABLE_NO_BINDING,
  RUNNER_UNAVAILABLE_NO_OUTBOUND,
  type WorkerLoaderLike,
} from '../src/exec/runner.js'
import type { ExecRunRequest } from '../src/exec/dialect.js'
import { createApp, EXEC_PROBE_TTL_MS, type Env, type ExecProbeResult } from '../src/worker.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const wranglerText = readFileSync(join(repoRoot, 'wrangler.jsonc'), 'utf8')
const entryText = readFileSync(join(repoRoot, 'src', 'entry.ts'), 'utf8')
const gatewayText = readFileSync(join(repoRoot, 'src', 'exec', 'gateway.ts'), 'utf8')

/** Every non-comment line of a JSONC file (leading-`//` lines dropped). */
const activeWranglerLines = wranglerText
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('//'))
  .join('\n')

/** Recursively list files under dir (paths relative to dir). */
function walk(dir: string, prefix = ''): string[] {
  return readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(dir, join(prefix, e.name)) : [join(prefix, e.name)],
  )
}

describe('enrollment config: wrangler.jsonc enables what the runner feature-detects', () => {
  it('main is the entry split (src/entry.ts), not the vitest-imported worker module', () => {
    expect(activeWranglerLines).toMatch(/"main":\s*"src\/entry\.ts"/)
  })

  it('the Worker Loader binding SUITE_LOADER is ENABLED (not comment-held)', () => {
    expect(activeWranglerLines).toMatch(/"worker_loaders":\s*\[\s*\{\s*"binding":\s*"SUITE_LOADER"\s*\}\s*\]/)
  })

  it('SUITE_OUTBOUND is the same-worker loopback service binding naming SuiteGateway', () => {
    expect(activeWranglerLines).toMatch(
      /"services":\s*\[\s*\{\s*"binding":\s*"SUITE_OUTBOUND",\s*"service":\s*"api-qa",\s*"entrypoint":\s*"SuiteGateway"\s*\}\s*\]/,
    )
  })

  it("the config's entrypoint name matches the class gateway.ts actually exports", () => {
    const m = /"entrypoint":\s*"([A-Za-z0-9_]+)"/.exec(activeWranglerLines)
    expect(m).not.toBeNull()
    expect(gatewayText).toContain(`export class ${m![1]} extends WorkerEntrypoint`)
  })
})

describe('the entry split: cloudflare:workers stays out of the vitest graph', () => {
  it('src/entry.ts re-exports the default handler, BOTH DO classes, and SuiteGateway', () => {
    expect(entryText).toMatch(/export \{ default \} from '\.\/worker\.js'/)
    expect(entryText).toMatch(/export \{ DomainCooldown, MonitorSchedulerDO \} from '\.\/worker\.js'/)
    expect(entryText).toMatch(/export \{ SuiteGateway \} from '\.\/exec\/gateway\.js'/)
  })

  it("src/exec/gateway.ts is the ONLY src module importing 'cloudflare:workers'", () => {
    const importers = walk(join(repoRoot, 'src'))
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))
      .filter((f) => /from\s+['"]cloudflare:workers['"]/.test(readFileSync(join(repoRoot, 'src', f), 'utf8')))
    expect(importers).toEqual([join('exec', 'gateway.ts')])
  })

  it('no src module other than the entry imports the gateway, and nothing imports the entry', () => {
    for (const f of walk(join(repoRoot, 'src')).filter((f) => f.endsWith('.ts'))) {
      const text = readFileSync(join(repoRoot, 'src', f), 'utf8')
      if (f !== 'entry.ts') expect(text, `${f} must not import exec/gateway`).not.toMatch(/from\s+['"][^'"]*exec\/gateway(\.js)?['"]/)
      expect(text, `${f} must not import the wrangler entry`).not.toMatch(/from\s+['"][^'"]*\/entry(\.js)?['"]/)
    }
    // The test graph must never resolve them either — that is the whole trick.
    for (const f of walk(join(repoRoot, 'test')).filter((f) => f.endsWith('.ts'))) {
      const text = readFileSync(join(repoRoot, 'test', f), 'utf8')
      expect(text, `test/${f} must not import src/entry or exec/gateway`).not.toMatch(
        /^\s*import[^\n]*from\s+['"][^'"]*(\/entry|exec\/gateway)(\.js)?['"]/m,
      )
    }
  })

  it('gateway.ts is a thin mount over createOutboundGateway with a MODULE-LEVEL sink', () => {
    // A fresh entrypoint instance is constructed per invocation, so the shared
    // record MUST live at module scope — an instance field would drop it
    // between the isolate's fetches and the runner's drain.
    expect(gatewayText).toMatch(/^const gateway[^\n]*=\s*createOutboundGateway\(\)/m)
    expect(gatewayText).toMatch(/async fetch\(request: Request\)/)
    expect(gatewayText).toMatch(/async drainViolations\(\)/)
  })
})

describe('the RPC drain shape: a service-binding-stub outbound still fails closed', () => {
  const req: ExecRunRequest = {
    artifactKind: 'document',
    origin: 'https://target.example',
    vars: {},
    environment: 'public',
    sandbox: false,
    seed: 7,
    declarativeRows: 0,
    testsSource: `it('x', () => {})`,
  }
  const okFetch = async (url: string): Promise<Response> =>
    new Response(JSON.stringify({ ok: true, url }), { status: 200, headers: { 'content-type': 'application/json' } })

  it('a forged all-green isolate body cannot bury a refusal drained over the async RPC shape', async () => {
    const gateway = createOutboundGateway(okFetch)
    // What SUITE_OUTBOUND is in production: fetch + an ASYNC drain whose
    // result crosses an RPC boundary as a structured clone, not the live array.
    const rpcStub = {
      fetch: (r: Request) => gateway.fetch(r),
      drainViolations: async () => structuredClone(await gateway.drainViolations()),
    }
    // The gateway refused an egress during the run window…
    await rpcStub.fetch(new Request('http://169.254.169.254/latest/meta-data/'))
    // …but the isolate body claims a clean pass with zero violations.
    const forgedLoader: WorkerLoaderLike = {
      get: () => ({
        getEntrypoint: () => ({
          fetch: async () =>
            new Response(
              JSON.stringify({ registered: 1, results: [{ name: 'x', status: 'pass', durationMs: 1 }], violations: [] }),
              { headers: { 'content-type': 'application/json' } },
            ),
        }),
      }),
    }
    const outcome = await workerLoaderExecRunner(forgedLoader, { outbound: rpcStub }).run(req)
    expect(outcome.status).toBe('failed')
    if (outcome.status === 'failed') expect(outcome.reason).toContain('network floor')
  })
})

// ---------------------------------------------------------------------------
// GET /health?exec=1 — the post-deploy proof face
// ---------------------------------------------------------------------------

describe('GET /health?exec=1 — the runner-availability probe', () => {
  const probeOf = async (app: ReturnType<typeof createApp>): Promise<ExecProbeResult> => {
    const res = await app.fetch(new Request('https://api.qa/health?exec=1'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; exec: ExecProbeResult }
    expect(body.ok).toBe(true)
    return body.exec
  }

  /** A loader that answers the probe suite with a clean one-test pass, counting spins. */
  const cannedLoader = () => {
    const calls: string[] = []
    const loader: WorkerLoaderLike = {
      get: (id) => {
        calls.push(id)
        return {
          getEntrypoint: () => ({
            fetch: async () =>
              new Response(
                JSON.stringify({
                  registered: 1,
                  results: [{ name: 'the isolate runs', status: 'pass', durationMs: 1 }],
                  violations: [],
                }),
                { headers: { 'content-type': 'application/json' } },
              ),
          }),
        }
      },
    }
    return { loader, calls }
  }

  it('the plain /health answer is UNCHANGED — no exec member without the opt-in query', async () => {
    const res = await createApp({}).fetch(new Request('https://api.qa/health'))
    expect(await res.json()).not.toHaveProperty('exec')
  })

  it('unprovisioned deployment: available:false with the typed no-binding reason', async () => {
    const exec = await probeOf(createApp({}, { now: () => 1_000_000 }))
    expect(exec.available).toBe(false)
    expect(exec.status).toBe('runner-unavailable')
    expect(exec.reason).toBe(RUNNER_UNAVAILABLE_NO_BINDING)
  })

  it('binding present but no outbound gateway: refuses to run open, by name', async () => {
    const { loader } = cannedLoader()
    const exec = await probeOf(createApp({ SUITE_LOADER: loader } as Env, { now: () => 2_000_000 }))
    expect(exec.available).toBe(false)
    expect(exec.reason).toBe(RUNNER_UNAVAILABLE_NO_OUTBOUND)
  })

  it('enrolled shape: a MEASURED run answers available:true, and the TTL memo bounds isolate spins', async () => {
    const { loader, calls } = cannedLoader()
    const outbound = createOutboundGateway()
    let t = 10_000_000
    const env = { SUITE_LOADER: loader, SUITE_OUTBOUND: outbound } as Env
    const app = createApp(env, { now: () => t })

    const first = await probeOf(app)
    expect(first).toMatchObject({ runner: 'api.qa/vitest@1', available: true, status: 'ran', cached: false })
    // The probe's isolate id is the CONTENT HASH of the fixed probe bytes —
    // repeat probes warm-reuse one isolate instead of minting new ones.
    expect(calls[0]).toMatch(/^vitest1:sha256:[0-9a-f]{64}:/)

    t += EXEC_PROBE_TTL_MS - 1
    const second = await probeOf(createApp(env, { now: () => t }))
    expect(second).toMatchObject({ available: true, cached: true, probedAtMs: first.probedAtMs })
    expect(calls).toHaveLength(1)

    t += 2
    const third = await probeOf(createApp(env, { now: () => t }))
    expect(third.cached).toBe(false)
    expect(calls).toHaveLength(2)
  })
})
