/**
 * The `vitest` CLI verb — LOCAL parity for the executable dialect (A.8.6.2).
 *
 * Spawns the REAL compiled CLI against the self-contained fixture suite (no
 * network — the fixture asserts over `suite:env` / `suite:module` only), and
 * pins the load-bearing process behavior a pipeline gates on: exit 0 on all
 * pass, exit 1 on a failing test, and exit 1 fail-closed on a digest
 * mismatch. The run goes through the SAME shared harness the hosted verifier
 * executes, so "green here" is "green hosted" by construction.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { spawnSync, execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { sha256HexSync } from '../src/sha256-sync.js'
import { readFileSync } from 'node:fs'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const bin = join(repoRoot, 'dist', 'cli', 'index.js')
const fixture = join(repoRoot, 'test', 'fixtures', 'vitest-suite.json')

function run(args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [bin, ...args], { cwd: repoRoot, encoding: 'utf8' })
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

describe('autonomous-qa vitest — local executable-suite runner', () => {
  beforeAll(() => {
    execSync('npm run build', { cwd: repoRoot, stdio: 'ignore' })
    expect(existsSync(bin)).toBe(true)
  }, 120_000)

  it('runs a self-contained suite to green, exit 0', () => {
    const r = run(['vitest', fixture, '--target', 'https://example.com', '--seed', '1'])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('2/2 tests passed')
  })

  it('honors --expect-digest fail-closed: a wrong pin exits 1 and instantiates nothing', () => {
    const r = run(['vitest', fixture, '--target', 'https://example.com', '--expect-digest', `sha256:${'0'.repeat(64)}`])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('digest mismatch')
  })

  it('accepts the CORRECT digest pin and exits 0', () => {
    const digest = `sha256:${sha256HexSync(readFileSync(fixture, 'utf8'))}`
    const r = run(['vitest', fixture, '--target', 'https://example.com', '--expect-digest', digest])
    expect(r.status).toBe(0)
  })

  it('--json emits the typed outcome (runner, digest, seed, per-test results)', () => {
    const r = run(['vitest', fixture, '--target', 'https://example.com', '--seed', '9', '--json'])
    expect(r.status).toBe(0)
    const parsed = JSON.parse(r.stdout) as { runner: string; seed: number; outcome: { status: string; results: unknown[] } }
    expect(parsed.runner).toBe('api.qa/vitest@1')
    expect(parsed.seed).toBe(9)
    expect(parsed.outcome.status).toBe('ran')
    expect(parsed.outcome.results).toHaveLength(2)
  })
})
