/**
 * Shared fixture: a reference target whose card declares an executable
 * `api.qa/vitest@1` suite the target genuinely passes. Used by the
 * observe→judge tests and by the grade()/gradePinned() threading tests.
 */
import { sha256HexSync } from '../src/sha256-sync.js'
import { VITEST_RUNNER } from '../src/test-suite.js'
import { goodTargetRoutes, withOverrides, type Routes } from './helpers.js'

export const SUITE_PATH = '/.well-known/axp/suite.mjs.json' // a suite DOCUMENT (not .mjs)

export const json = (value: unknown) => () => ({ status: 200, contentType: 'application/json', body: JSON.stringify(value) })

/** An executable suite document the reference target genuinely passes. */
export function execDoc(extra: Record<string, unknown> = {}) {
  return {
    $type: 'Suite',
    name: 'good.example workflows',
    version: '1.0.0',
    environments: { public: { vars: { token: 't-1' } } },
    tests: `
import { describe, it, expect } from 'vitest'
import { origin, vars } from 'suite:env'

describe('status → widgets workflow', () => {
  it('status is ok', async () => {
    const r = await fetch(origin + '/api/status')
    expect(r.status).toBe(200)
    const b = await r.json()
    expect(b.ok).toBe(true)
    expect(b.widgets).toBeGreaterThan(0)
  })
  it('widgets lists, and the environment var is wired', async () => {
    expect(vars.token).toBe('t-1')
    const r = await fetch(origin + '/api/widgets')
    const list = await r.json()
    expect(list).toHaveLength(3)
    expect(list[0].id).toBe('w1')
  })
})
`,
    ...extra,
  }
}

export function routesFor(opts: {
  suite?: unknown
  declaration?: unknown
  digest?: string
  suitePath?: string
  serveSuite?: boolean
  suiteBody?: { status: number; contentType: string; body: string }
} = {}): { routes: Routes; suiteText: string } {
  const base = goodTargetRoutes()
  const path = opts.suitePath ?? SUITE_PATH
  const suite = opts.suite ?? execDoc()
  const suiteText = typeof suite === 'string' ? suite : JSON.stringify(suite)
  const card = JSON.parse(
    base['GET /.well-known/agents.json']!({ method: 'GET', accept: 'application/json' }).body!,
  ) as Record<string, any>
  card.interfaces.testSuite =
    opts.declaration ?? {
      url: path,
      digest: opts.digest ?? `sha256:${sha256HexSync(suiteText)}`,
      runner: VITEST_RUNNER,
    }
  const suiteRoute: Routes = {}
  if (opts.serveSuite !== false) {
    suiteRoute[`GET ${path}`] = opts.suiteBody ? () => opts.suiteBody! : () => ({ status: 200, contentType: 'application/json', body: suiteText })
  }
  return {
    routes: withOverrides(base, { 'GET /.well-known/agents.json': json(card), ...suiteRoute }),
    suiteText,
  }
}

