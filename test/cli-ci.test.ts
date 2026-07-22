/**
 * End-to-end CI-citizen tests: spawn the REAL compiled CLI and assert the
 * ACTUAL process exit code (the load-bearing property a pipeline gates on),
 * that the file reporters write parseable JUnit/JSON, and that the shipped
 * GitHub Action workflow is well-formed.
 *
 * These are hermetic: the only "network" is a connection-refused probe to
 * loopback port 9 (discard), which fails fast and deterministically produces a
 * grade-F report — exercising the full emit + non-zero-exit path with no
 * external dependency.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { spawnSync, execSync } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertWellFormedXml } from './helpers.js'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const bin = join(repoRoot, 'dist', 'cli', 'index.js')
const spec = join(repoRoot, 'examples', 'golden-scenario.spec.json')

function run(args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [bin, ...args], { cwd: repoRoot, encoding: 'utf8' })
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

describe('CLI exit codes (spawned, real process status)', () => {
  beforeAll(() => {
    execSync('npm run build', { cwd: repoRoot, stdio: 'ignore' })
    expect(existsSync(bin)).toBe(true)
  }, 120_000)

  it('no command → exit 1 (usage)', () => {
    expect(run([]).status).toBe(1)
  })

  it('help → exit 0', () => {
    expect(run(['help']).status).toBe(0)
  })

  it('spec-digest → exit 0 and prints a sha256', () => {
    const r = run(['spec-digest', spec])
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toMatch(/^[0-9a-f]{64}$/)
  })

  it('verify without --spec → exit 1 (bad args)', () => {
    expect(run(['verify', 'http://localhost:9']).status).toBe(1)
  })

  it('suite without --env → exit 1 (bad args)', () => {
    expect(run(['suite', join(repoRoot, 'examples', 'golden-scenario.suite.json')]).status).toBe(1)
  })

  it('DIGEST PIN MISMATCH → exit 1, before any probe (no silent green)', () => {
    const r = run([
      'verify',
      'http://localhost:9',
      '--spec',
      spec,
      '--expect-digest',
      '0'.repeat(64),
    ])
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/digest mismatch/)
  })

  it('a run that FAILS (unreachable target, grade F) → exit 1', () => {
    // grade mode against connection-refused loopback: a grade-F report, not a throw.
    const r = run(['http://localhost:9'])
    expect(r.status).toBe(1)
  })

  it('file reporters write parseable JUnit + JSON and still exit non-zero on failure', () => {
    const dir = mkdtempSync(join(tmpdir(), 'apiqa-ci-'))
    // Target paths under NON-EXISTENT subdirectories of the mkdtemp'd base —
    // mkdtempSync only guarantees `dir` itself exists, not `dir/nested/out/`,
    // so this still exercises emit()'s parent-dir auto-create (LOW #2: writing
    // straight into `dir` never exercised the ENOENT-crash path at all).
    const junitPath = join(dir, 'nested', 'out', 'r.junit.xml')
    const jsonPath = join(dir, 'nested', 'out2', 'r.json')
    const r = run([
      'http://localhost:9',
      '--reporter',
      'junit',
      '--reporter-junit-out',
      junitPath,
      '--reporter',
      'json',
      '--reporter-json-out',
      jsonPath,
    ])
    expect(r.status).toBe(1)
    // reporter file-writes must NOT pollute stdout
    expect(r.stdout.trim()).toBe('')
    expect(existsSync(junitPath)).toBe(true)
    expect(existsSync(jsonPath)).toBe(true)

    const xml = readFileSync(junitPath, 'utf8')
    assertWellFormedXml(xml)
    expect(xml).toMatch(/<testsuites[^>]*\bfailures="\d+"/)

    const j = JSON.parse(readFileSync(jsonPath, 'utf8')) as {
      $report: string
      verdict: string
      exitCode: number
      totals: { tests: number }
    }
    expect(j.$report).toBe('api.qa.ci-run')
    expect(j.verdict).toBe('FAILED')
    expect(j.exitCode).toBe(1)
    expect(j.totals.tests).toBeGreaterThan(0)
  })

  it('auto-creates a NON-EXISTENT parent directory chain — the fresh-checkout / shipped-Action case', () => {
    // Deliberately does NOT use mkdtempSync for this path: mkdtempSync always
    // pre-creates its directory, which would silently avoid the exact bug
    // this test exists to catch (HIGH: emit() writeFileSync'd straight into
    // `reports/...` with no parent-dir creation — a fresh checkout has no
    // `reports/` dir, so the shipped GitHub Action ENOENT-crashed on EVERY
    // run: exit 1 with no artifacts, even when every probe passed).
    const missingRoot = join(tmpdir(), `apiqa-ci-missing-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    const junitPath = join(missingRoot, 'reports', 'api-qa.junit.xml')
    expect(existsSync(missingRoot)).toBe(false)
    try {
      const r = run(['http://localhost:9', '--reporter', 'junit', '--reporter-junit-out', junitPath])
      expect(r.status).toBe(1)
      expect(existsSync(junitPath)).toBe(true)
      const xml = readFileSync(junitPath, 'utf8')
      assertWellFormedXml(xml)
      expect(xml).toMatch(/<testsuites[^>]*\bfailures="\d+"/)
    } finally {
      rmSync(missingRoot, { recursive: true, force: true })
    }
  })

  it('a file reporter with no output path writes well-formed XML to stdout', () => {
    const r = run(['http://localhost:9', '--reporter', 'junit'])
    expect(r.status).toBe(1)
    expect(r.stdout.startsWith('<?xml')).toBe(true)
    assertWellFormedXml(r.stdout)
  })

  it('an unknown reporter name → exit 1', () => {
    const r = run(['http://localhost:9', '--reporter', 'tap'])
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/unknown reporter/)
  })
})

describe('GitHub Action workflow is well-formed', () => {
  const wfPath = join(repoRoot, '.github', 'workflows', 'api-qa-example.yml')
  const yaml = readFileSync(wfPath, 'utf8')

  it('uses no tab indentation and consistent 2-space steps', () => {
    const lines = yaml.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const indent = lines[i]!.match(/^[ \t]*/)![0]
      expect(indent.includes('\t'), `tab indentation at line ${i + 1}`).toBe(false)
      // even-width indentation (the whole file, including block-scalar bodies, is 2-space stepped)
      if (lines[i]!.trim() !== '') expect(indent.length % 2, `odd indent at line ${i + 1}: ${lines[i]}`).toBe(0)
    }
  })

  it('declares the required workflow structure', () => {
    expect(yaml).toMatch(/^name:/m)
    expect(yaml).toMatch(/^on:/m)
    expect(yaml).toMatch(/^jobs:/m)
    expect(yaml).toMatch(/runs-on:/)
    expect(yaml).toMatch(/steps:/)
    expect(yaml).toContain('actions/checkout@')
    expect(yaml).toContain('actions/setup-node@')
  })

  it('runs the pinned gate and uploads reports on failure', () => {
    expect(yaml).toContain('autonomous-qa suite')
    expect(yaml).toContain('--expect-digest')
    expect(yaml).toMatch(/--reporter\s+junit/)
    expect(yaml).toContain('actions/upload-artifact@')
    expect(yaml).toContain('if: always()')
  })

  it('has balanced ${{ }} expression braces', () => {
    const opens = (yaml.match(/\$\{\{/g) ?? []).length
    const closes = (yaml.match(/\}\}/g) ?? []).length
    expect(opens).toBeGreaterThan(0)
    expect(opens).toBe(closes)
  })
})
