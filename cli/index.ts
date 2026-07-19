#!/usr/bin/env node
/**
 * npx api.qa — the verifier core, local mount.
 *
 *   npx api.qa <domain|url>                       grade a target (advisory, unsigned)
 *   npx api.qa verify <target> --spec <file>      pinned-spec mode (the hill-climb gate)
 *       [--expect-digest <sha256>] [--seed <n>] [--json]
 *   npx api.qa spec-digest <file>                 print the sha256 pin for a spec
 *   npx api.qa rejudge                            re-judge a JSON report from stdin
 *   npx api.qa mcp                                MCP server (stdio)
 *
 * Local runs are ADVISORY: deterministic and replayable, but never attested —
 * only the held-out deployed verifier signs. A hill-climb loop uses this
 * exact binary against a dev URL; the definition of done is the SAME spec
 * digest passing on the deployed api.qa.
 */

import { readFileSync } from 'node:fs'
import { verifyTarget, rejudge } from '../src/verify.js'
import { verifyPinnedSpec } from '../src/pinned.js'
import { reportMarkdown, pinnedMarkdown } from '../src/render.js'
import { verifyAttestation } from '../src/attest.js'
import { sha256Hex } from '../src/digest.js'
import { runMcpServer } from '../src/mcp.js'
import type { VerificationReport } from '../src/types.js'

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  const flags = new Map<string, string>()
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a.startsWith('--')) {
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(a.slice(2), next)
        i++
      } else flags.set(a.slice(2), 'true')
    } else positional.push(a)
  }
  const [cmd, ...rest] = positional
  const asJson = flags.get('json') === 'true'
  const seed = flags.has('seed') ? Number(flags.get('seed')) : undefined

  if (!cmd || cmd === 'help' || flags.has('help')) {
    console.log(usage())
    return cmd ? 0 : 1
  }

  if (cmd === 'mcp') {
    await runMcpServer()
    return 0
  }

  if (cmd === 'spec-digest') {
    const file = rest[0]
    if (!file) return die('spec-digest needs a file path')
    console.log(await sha256Hex(readFileSync(file, 'utf8')))
    return 0
  }

  if (cmd === 'rejudge') {
    const text = readFileSync(0, 'utf8')
    const report = JSON.parse(text) as VerificationReport
    const result = await rejudge(report)
    const attestationOk = report.attestation ? await verifyAttestation(report) : null
    console.log(JSON.stringify({ ...result, attestationValid: attestationOk }, null, 2))
    return result.consistent && attestationOk !== false ? 0 : 1
  }

  if (cmd === 'verify') {
    const target = rest[0]
    const specFile = flags.get('spec')
    if (!target || !specFile) return die('verify needs a target and --spec <file>')
    const specText = readFileSync(specFile, 'utf8')
    const report = await verifyPinnedSpec(target, specText, {
      mode: 'local',
      seed,
      expectedDigest: flags.get('expect-digest'),
      delayMs: isLocalTarget(target) ? 0 : 150,
    })
    console.log(asJson ? JSON.stringify(report, null, 2) : pinnedMarkdown(report))
    return report.passed ? 0 : 1
  }

  // Default: grade a target.
  const target = cmd
  const report = await verifyTarget(target, { mode: 'local', seed, delayMs: isLocalTarget(target) ? 0 : 150 })
  console.log(asJson ? JSON.stringify(report, null, 2) : reportMarkdown(report))
  return report.grade === 'F' ? 1 : 0
}

function isLocalTarget(target: string): boolean {
  return /localhost|127\.0\.0\.1|\[::1\]/.test(target)
}

function die(message: string): number {
  console.error(`api.qa: ${message}\n\n${usage()}`)
  return 1
}

function usage(): string {
  return `api.qa — the external verifier for agent-first APIs

  npx api.qa <domain|url>                      grade a target (advisory, unsigned)
  npx api.qa verify <target> --spec <file>     pinned-spec mode
      [--expect-digest <sha256>] [--seed <n>]
  npx api.qa spec-digest <file>                print the sha256 pin for a spec
  npx api.qa rejudge                           re-judge a JSON report from stdin
  npx api.qa mcp                               MCP server (stdio)
  flags: --json (raw report)

  Attested runs live at https://api.qa/{domain} — local runs never sign.`
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`api.qa: ${err instanceof Error ? err.message : err}`)
    process.exit(1)
  },
)
