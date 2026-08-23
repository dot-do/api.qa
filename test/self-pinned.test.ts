/**
 * The wave-zero admission gate (fn-it register row, 2026-08-23): api.qa's
 * OWN face must pass the ratified admission contract — the full pinned
 * `apis-ax-axp@2.6.0` (24 requirements) — through exactly the machinery it
 * applies to every admitted target. The 10-point self checklist
 * (test/self.test.ts) is the AX grading rubric; THIS is the fail-closed
 * conformance gate the estate's worthiness bar (§4.6 of the property
 * template) reads.
 *
 * The spec text is vendored bytes (test/fixtures/apis-ax-standard-2.6.0
 * .spec.json); the digest assertion below is the pin — if the vendored copy
 * drifts from the ratified digest, nothing runs (vendoring-with-pins, the
 * anti-Goodhart gate applied to ourselves).
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createApp } from '../src/worker.js'
import { verifyPinnedSpec, AXP_PINNED_SPEC } from '../src/pinned.js'
import { sha256Hex } from '../src/digest.js'
import { SELF_ORIGIN } from '../src/self.js'
import type { Fetcher } from '../src/http.js'

const SPEC_PATH = fileURLToPath(new URL('./fixtures/apis-ax-standard-2.6.0.spec.json', import.meta.url))

function loopbackFetcher(): Fetcher {
  const app = createApp()
  return (url, init) => app.fetch(new Request(url, init))
}

describe('api.qa passes the ratified pinned admission contract on itself', () => {
  it(`vendored spec text hashes to the ratified pin (${AXP_PINNED_SPEC.digest.slice(0, 8)}…)`, async () => {
    const text = readFileSync(SPEC_PATH, 'utf8')
    expect(await sha256Hex(text)).toBe(AXP_PINNED_SPEC.digest)
  })

  it('verifyPinnedSpec(api.qa, apis-ax-axp@2.6.0) → passed: true', async () => {
    const text = readFileSync(SPEC_PATH, 'utf8')
    const report = await verifyPinnedSpec(SELF_ORIGIN, text, {
      mode: 'remote',
      fetcher: loopbackFetcher(),
      delayMs: 0,
      seed: 42,
      expectedDigest: AXP_PINNED_SPEC.digest,
    })
    const failures = report.requirements
      .filter((r) => r.verdict !== 'pass')
      .map((r) => `${r.id} [${r.verdict}]: ${r.detail}`)
    expect(failures, failures.join('\n')).toEqual([])
    expect(report.passed).toBe(true)
  })
})
