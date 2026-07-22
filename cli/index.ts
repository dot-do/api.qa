#!/usr/bin/env node
/**
 * npx autonomous-qa — the verifier core, local mount.
 *
 *   npx autonomous-qa <domain|url>                       grade a target (advisory, unsigned)
 *   npx autonomous-qa verify <target> --spec <file>      pinned-spec mode (the hill-climb gate)
 *       [--expect-digest <sha256>] [--seed <n>] [--json]
 *   npx autonomous-qa spec-digest <file>                 print the sha256 pin for a spec
 *   npx autonomous-qa rejudge                            re-judge a JSON report from stdin
 *   npx autonomous-qa mcp                                MCP server (stdio)
 *
 * Local runs are ADVISORY: deterministic and replayable, but never attested —
 * only the held-out deployed verifier signs. A hill-climb loop uses this
 * exact binary against a dev URL; the definition of done is the SAME spec
 * digest passing on the deployed api.qa.
 */

import { readFileSync } from 'node:fs'
import { verifyTarget, rejudge } from '../src/verify.js'
import { verifyPinnedSpec, verifySuite } from '../src/pinned.js'
import { parseDataset, verifySuiteDataDriven } from '../src/dataset.js'
import { reportMarkdown, pinnedMarkdown, suiteMarkdown, dataDrivenMarkdown } from '../src/render.js'
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

  if (cmd === 'suite') {
    const suiteFile = rest[0] ?? flags.get('suite')
    const envName = flags.get('env')
    if (!suiteFile || !envName) return die('suite needs a suite file and --env <name>')
    const suiteText = readFileSync(suiteFile, 'utf8')
    const targetFlag = flags.get('target')

    // Data-driven mode (Newman --iteration-data parity): run the suite once per
    // dataset row, binding each row into the env scope, and print a per-
    // iteration × per-probe matrix + overall verdict. Non-zero exit if any
    // iteration fails (including an SSRF-refused row).
    const dataFile = flags.get('iteration-data')
    if (dataFile) {
      const datasetText = readFileSync(dataFile, 'utf8')
      const format = /\.json$/i.test(dataFile) ? 'json' : /\.csv$/i.test(dataFile) ? 'csv' : undefined
      const rows = parseDataset(datasetText, format ? { format } : {})
      const report = await verifySuiteDataDriven(suiteText, envName, rows, {
        mode: 'local',
        seed,
        expectedDigest: flags.get('expect-digest'),
        target: targetFlag,
        delayMs: targetFlag && isLocalTarget(targetFlag) ? 0 : 150,
      })
      console.log(asJson ? JSON.stringify(report, null, 2) : dataDrivenMarkdown(report))
      return report.passed ? 0 : 1
    }

    const report = await verifySuite(suiteText, envName, {
      mode: 'local',
      seed,
      expectedDigest: flags.get('expect-digest'),
      target: targetFlag,
      delayMs: targetFlag && isLocalTarget(targetFlag) ? 0 : 150,
    })
    console.log(asJson ? JSON.stringify(report, null, 2) : suiteMarkdown(report))
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
  console.error(`autonomous-qa: ${message}\n\n${usage()}`)
  return 1
}

function usage(): string {
  return `autonomous-qa — the external verifier for agent-first APIs (hosted service: api.qa)

  npx autonomous-qa <domain|url>                      grade a target (advisory, unsigned)
  npx autonomous-qa verify <target> --spec <file>     pinned-spec mode
      [--expect-digest <sha256>] [--seed <n>]
  npx autonomous-qa suite <file> --env <name>         reusable suite/collection mode
      [--iteration-data <dataset.csv|.json>]          run once per dataset row (data-driven)
      [--target <target>] [--expect-digest <sha256>] [--seed <n>]
      (target defaults to the selected environment's baseUrl var)
  npx autonomous-qa spec-digest <file>                print the sha256 pin for a spec/suite
  npx autonomous-qa rejudge                           re-judge a JSON report from stdin
  npx autonomous-qa mcp                               MCP server (stdio)
  flags: --json (raw report)

  Attested runs live at https://api.qa/{domain} — local runs never sign.`
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`autonomous-qa: ${err instanceof Error ? err.message : err}`)
    process.exit(1)
  },
)
