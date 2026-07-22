#!/usr/bin/env node
/**
 * npx autonomous-qa — the verifier core, local mount.
 *
 *   npx autonomous-qa <domain|url>                       grade a target (advisory, unsigned)
 *   npx autonomous-qa verify <target> --spec <file>      pinned-spec mode (the hill-climb gate)
 *       [--expect-digest <sha256>] [--seed <n>] [--json]
 *   npx autonomous-qa dev <entry.js|localhost-url>       grade a surface PRE-DEPLOY, in-process
 *       [--spec <file>] [--expect-digest <sha256>] [--json]   (Worker entry mounted in memory,
 *                                                              or a running local dev server by URL)
 *   npx autonomous-qa suite <file> --env <name>          reusable suite/collection mode
 *       [--iteration-data <dataset>] [--target <t>] [--expect-digest <sha256>]
 *   npx autonomous-qa spec-digest <file>                 print the sha256 pin for a spec
 *   npx autonomous-qa rejudge                            re-judge a JSON report from stdin
 *   npx autonomous-qa mcp                                MCP server (stdio)
 *
 * CI CITIZEN (Newman parity):
 *   - EXIT CODES: `verify` / `suite` / `suite --iteration-data` exit NON-ZERO
 *     iff ANY requirement / probe / iteration failed (or the digest pin
 *     mismatched, or the target was unreachable/refused). Exit 0 only when
 *     everything passed. A gate that exits 0 on a failure is a silent green.
 *   - REPORTERS: `--reporter cli|junit|json` (repeatable, comma-splittable) with
 *     `--reporter-out <path>` (shared) or `--reporter-junit-out` /
 *     `--reporter-json-out` (per reporter). `cli` = the human/markdown output.
 *
 * Local runs are ADVISORY: deterministic and replayable, but never attested —
 * only the held-out deployed verifier signs. A hill-climb loop uses this
 * exact binary against a dev URL; the definition of done is the SAME spec
 * digest passing on the deployed api.qa.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { verifyTarget, rejudge } from '../src/verify.js'
import { grade, gradePinned, type FetchHandler, type GradeTarget } from '../src/local.js'
import { isUrl, isLocalTarget, isPrivateUrlHost } from './target.js'
import { verifyPinnedSpec, verifySuite } from '../src/pinned.js'
import { parseDataset, verifySuiteDataDriven } from '../src/dataset.js'
import { reportMarkdown, pinnedMarkdown, suiteMarkdown, dataDrivenMarkdown } from '../src/render.js'
import {
  exitCodeFor,
  junitXml,
  jsonReportText,
  resolveReporters,
  type AnyRunReport,
  type ReporterSpec,
} from '../src/reporters.js'
import { verifyAttestation } from '../src/attest.js'
import { sha256Hex } from '../src/digest.js'
import { runMcpServer } from '../src/mcp.js'
import type { VerificationReport } from '../src/types.js'

interface Flags {
  /** Last value wins (single-valued reads). */
  get(k: string): string | undefined
  has(k: string): boolean
  /** Every value supplied for a repeated flag, in order. */
  all(k: string): string[]
}

function parseFlags(argv: string[]): { flags: Flags; positional: string[] } {
  const single = new Map<string, string>()
  const multi = new Map<string, string[]>()
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      let value: string
      if (next !== undefined && !next.startsWith('--')) {
        value = next
        i++
      } else value = 'true'
      single.set(key, value)
      const arr = multi.get(key) ?? []
      arr.push(value)
      multi.set(key, arr)
    } else positional.push(a)
  }
  const flags: Flags = {
    get: (k) => single.get(k),
    has: (k) => single.has(k),
    all: (k) => multi.get(k) ?? [],
  }
  return { flags, positional }
}

/**
 * Emit a produced report through the selected reporters, then return its exit
 * code. When NO `--reporter` is given, preserve the legacy behavior: `--json`
 * prints the raw report, otherwise the markdown renderer prints. When
 * `--reporter` IS given, `cli` prints the markdown; `junit`/`json` render to
 * their output path (or stdout when no path). Exit code is ALWAYS `exitCodeFor`
 * — independent of which reporters ran, so reporting never masks a failure.
 */
function emit(report: AnyRunReport, markdown: string, flags: Flags): number {
  const requested = flags.all('reporter')
  if (requested.length === 0) {
    // Legacy path: --json raw report, else markdown.
    console.log(flags.get('json') === 'true' ? JSON.stringify(report, null, 2) : markdown)
    return exitCodeFor(report)
  }
  const specs: ReporterSpec[] = resolveReporters(requested, (k) => flags.get(k))
  for (const spec of specs) {
    const text =
      spec.name === 'cli' ? markdown : spec.name === 'junit' ? junitXml(report) : jsonReportText(report)
    if (spec.out) {
      // A fresh checkout has no `reports/` dir (or whatever parent the caller
      // named); a shipped GitHub Action writing straight to `reports/x.xml`
      // would ENOENT-crash on EVERY run with no artifacts — the worst kind of
      // CI citizen (cries wolf, stuck red even when the suite passes). Create
      // the parent unconditionally so every caller of `emit()` is covered.
      mkdirSync(dirname(spec.out), { recursive: true })
      writeFileSync(spec.out, text)
      console.error(`autonomous-qa: ${spec.name} report → ${spec.out}`)
    } else {
      // cli reporter uses stdout; file reporters with no path also go to stdout.
      process.stdout.write(text.endsWith('\n') ? text : text + '\n')
    }
  }
  return exitCodeFor(report)
}

async function main(): Promise<number> {
  const { flags, positional } = parseFlags(process.argv.slice(2))
  const [cmd, ...rest] = positional
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
    return emit(report, pinnedMarkdown(report), flags)
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
      return emit(report, dataDrivenMarkdown(report), flags)
    }

    const report = await verifySuite(suiteText, envName, {
      mode: 'local',
      seed,
      expectedDigest: flags.get('expect-digest'),
      target: targetFlag,
      delayMs: targetFlag && isLocalTarget(targetFlag) ? 0 : 150,
    })
    return emit(report, suiteMarkdown(report), flags)
  }

  if (cmd === 'dev') {
    const entry = rest[0]
    if (!entry) return die('dev needs an entry module path or a localhost URL')
    const specFile = flags.get('spec')
    // Mount the surface in-process (a Worker entry module) OR grade a running
    // dev server by URL. A localhost/private URL is the ONE place `dev` opts
    // into the private-host allowance — local only, never inferred from a
    // remote target (the SSRF invariant lives in src/local.ts).
    //
    // SSRF: the opt-in MUST be anchored to the PARSED HOSTNAME, never a
    // substring test over the whole URL string — `isLocalTarget` (cli/
    // target.ts) is a loose, unanchored `/localhost|127\.0\.0\.1|\[::1\]/`
    // match used ONLY as a cosmetic delay-throttle heuristic elsewhere in this
    // file. Reusing it here would let a PUBLIC url that merely embeds that
    // substring in its path, query, or subdomain (e.g.
    // `http://127.0.0.1.attacker.com/`, or `http://public.example/?x=localhost`)
    // flip `allowPrivate` on for a run against a real public origin, disabling
    // the private-host backstop it was never meant to disable. `isPrivateUrlHost`
    // instead parses the URL and checks `isPrivateHost` against the HOSTNAME
    // ONLY (the same function the core SSRF gate in src/http.ts enforces with),
    // so a public host can never trigger the allowance no matter what its
    // path/query/subdomain contains.
    let target: GradeTarget
    let allowPrivate = false
    if (isUrl(entry)) {
      target = entry
      allowPrivate = isPrivateUrlHost(entry)
    } else {
      target = await loadHandler(entry)
    }
    const gradeOpts = { seed, delayMs: 0, allowPrivate }
    if (specFile) {
      const specText = readFileSync(specFile, 'utf8')
      const report = await gradePinned(target, specText, {
        ...gradeOpts,
        expectedDigest: flags.get('expect-digest'),
      })
      return emit(report, pinnedMarkdown(report), flags)
    }
    const report = await grade(target, gradeOpts)
    return emit(report, reportMarkdown(report), flags)
  }

  // Default: grade a target (advisory). exitCodeFor() only fails on grade F,
  // so a bare `autonomous-qa <target>` is silent-green for grades A-D even
  // with failing checks — a footgun if a CI pipeline gates on it. Warn every
  // time so gating on this command is a deliberate, informed choice, not a
  // discovered-in-an-incident surprise.
  const target = cmd
  console.error(
    'autonomous-qa: ADVISORY grade mode — exits 0 for any grade A-D, even with failing checks; ' +
      'only grade F exits non-zero. Do NOT gate CI on this command. ' +
      'CI gates must use `verify` / `suite` / `suite --iteration-data` (see docs/ci.md).',
  )
  const report = await verifyTarget(target, { mode: 'local', seed, delayMs: isLocalTarget(target) ? 0 : 150 })
  return emit(report, reportMarkdown(report), flags)
}

/**
 * Import an entry MODULE and resolve its Worker-style handler — a default
 * export that is a `{ fetch }` object or a bare `(request) => Response`, or a
 * named `fetch` export (the module namespace itself). Throws a clear,
 * actionable error when the module exports no usable handler (fall back to
 * `api.qa dev <localhost-url>` against a running dev server). Kept
 * dependency-light: a single dynamic `import()`, no bundler, no loader.
 */
async function loadHandler(entry: string): Promise<FetchHandler> {
  const href = pathToFileURL(resolve(process.cwd(), entry)).href
  let mod: Record<string, unknown>
  try {
    mod = (await import(href)) as Record<string, unknown>
  } catch (err) {
    throw new Error(
      `dev: could not import entry "${entry}": ${err instanceof Error ? err.message : String(err)}\n` +
        '(if the entry cannot be imported in-process, run `api.qa dev <localhost-url>` against a running dev server instead)',
    )
  }
  const candidate = (mod.default ?? mod) as unknown
  if (typeof candidate === 'function') return candidate as FetchHandler
  if (candidate && typeof (candidate as { fetch?: unknown }).fetch === 'function') {
    return candidate as FetchHandler
  }
  throw new Error(
    `dev: entry "${entry}" exports no fetch handler — expected a default export that is a ` +
      'Worker `{ fetch(request, env, ctx) }` or a bare `(request) => Response`, or a named `fetch` export.',
  )
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
  npx autonomous-qa dev <entry.js|localhost-url>      grade a surface PRE-DEPLOY, in-process
      [--spec <file>] [--expect-digest <sha256>]      mount a Worker entry module in memory
      [--seed <n>] [--json]                           (or grade a running local dev server by URL)
  npx autonomous-qa suite <file> --env <name>         reusable suite/collection mode
      [--iteration-data <dataset.csv|.json>]          run once per dataset row (data-driven)
      [--target <target>] [--expect-digest <sha256>] [--seed <n>]
      (target defaults to the selected environment's baseUrl var)
  npx autonomous-qa spec-digest <file>                print the sha256 pin for a spec/suite
  npx autonomous-qa rejudge                           re-judge a JSON report from stdin
  npx autonomous-qa mcp                               MCP server (stdio)

  flags: --json (raw report)
  CI reporters (Newman parity): --reporter cli|junit|json  (repeatable / comma-splittable)
      --reporter-out <path>            shared output path for the file reporter
      --reporter-junit-out <path>      JUnit XML output path (for GitHub/GitLab test reports)
      --reporter-json-out <path>       structured JSON output path
  EXIT CODES: verify / suite / suite --iteration-data exit NON-ZERO iff any
  requirement / probe / iteration fails (or the digest pin mismatches, or the
  target is unreachable/refused). Exit 0 only when everything passed — safe to
  gate a CI pipeline on.

  Attested runs live at https://api.qa/{domain} — local runs never sign.`
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`autonomous-qa: ${err instanceof Error ? err.message : err}`)
    process.exit(1)
  },
)
