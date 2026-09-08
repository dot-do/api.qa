/**
 * grade() / gradePinned() thread the exec runner: a card-declared executable
 * suite is RUN by the local gate (Node default), a passed runner is used
 * verbatim, and inside workerd the default is the typed runner-unavailable
 * (never a silent pass, never a data: import crash).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { grade, defaultExecRunner, RUNNER_UNAVAILABLE_WORKERD } from '../src/local.js'
import type { ExecSuiteRunner } from '../src/exec/dialect.js'
import { GOOD, makeWorker } from './helpers.js'
import { routesFor } from './suite-fixture.js'

const suiteCheck = (checks: { id: string; verdict: string; detail: string }[]) => checks.find((c) => c.id === "published-test-suite")!

describe('grade() and the exec runner', () => {
  it('runs a card-declared vitest@1 suite through the in-memory handler by default (Node)', async () => {
    const { routes } = routesFor()
    const report = await grade(makeWorker(routes, GOOD), { baseOrigin: GOOD })
    const c = suiteCheck(report.checks)
    expect(c.verdict).toBe('pass')
    expect(c.detail).not.toContain('runner-unavailable')
  })

  it('uses an explicitly passed runner verbatim', async () => {
    const { routes } = routesFor()
    const run = vi.fn(async () => ({ status: 'runner-unavailable' as const, reason: 'spy runner' }))
    const execRunner: ExecSuiteRunner = { run }
    const report = await grade(makeWorker(routes, GOOD), { baseOrigin: GOOD, execRunner })
    expect(run).toHaveBeenCalledTimes(1)
    const c = suiteCheck(report.checks)
    expect(c.verdict).toBe('fail')
    expect(c.detail).toContain('spy runner')
  })
})

describe('defaultExecRunner inside workerd', () => {
  const saved = globalThis.navigator
  afterEach(() => {
    Object.defineProperty(globalThis, 'navigator', { value: saved, configurable: true, writable: true })
  })

  it('is the typed runner-unavailable with the Worker Loader fix named', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: { userAgent: 'Cloudflare-Workers' },
      configurable: true,
      writable: true,
    })
    const outcome = await defaultExecRunner().run({
      artifactKind: 'document',
      testsSource: '',
      origin: GOOD,
      vars: {},
      environment: 'public',
      sandbox: false,
      seed: 1,
      declarativeRows: 0,
      digest: 'sha256:0',
    })
    expect(outcome.status).toBe('runner-unavailable')
    expect(outcome).toMatchObject({ reason: RUNNER_UNAVAILABLE_WORKERD })
    expect(RUNNER_UNAVAILABLE_WORKERD).toContain('workerLoaderExecRunner')
  })
})
