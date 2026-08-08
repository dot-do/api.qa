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
 *   npx autonomous-qa contract-diff <spec> <target>      did this deploy break the published contract?
 *       [--json] [--reporter ...]                         (exit NON-ZERO on any breaking op diff)
 *   npx autonomous-qa mock <spec> --port <n>             local deterministic mock server from a spec
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
import { skillText, checkSkill, installSkill, SKILL_NAME } from './skill.js'
import { verifyPinnedSpec, verifySuite } from '../src/pinned.js'
import { runEstateGate, formatScoreboard, type GateEntry } from '../src/gate.js'
import { parseDataset, verifySuiteDataDriven } from '../src/dataset.js'
import { reportMarkdown, pinnedMarkdown, suiteMarkdown, dataDrivenMarkdown, contractDiffMarkdown } from '../src/render.js'
import { runContractDiff } from '../src/contract-cli.js'
import { startMockServer } from '../src/mock-server.js'
import { DEFAULT_MOCK_SEED } from '../src/mock.js'
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
import { localExecRunner, type ExecRunOutcome } from '../src/exec/dialect.js'
import { parseExecSuiteDocument } from '../src/suite-doc.js'
import type { Suite, VerificationReport } from '../src/types.js'

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

  if (cmd === 'skill') {
    // skill — distribute the AXP skill (canonical source: the axp.org.ai repo
    // `skill/SKILL.md`; this package ships a byte-identical, test-pinned copy).
    // The CANONICAL installer is the standard's own package — `npx axp.org.ai
    // skill install`; this subcommand is the verifier-side mirror (same bytes).
    //   skill install   copy into ~/.claude/skills/axp/SKILL.md (idempotent)
    //   skill --check   drift check: exit 0 iff installed == shipped
    //   skill --print   shipped skill to stdout
    const sub = rest[0]
    if (flags.has('print') || sub === 'print') {
      process.stdout.write(skillText())
      return 0
    }
    if (flags.has('check') || sub === 'check') {
      const s = checkSkill()
      if (!s.installed) {
        console.error(`autonomous-qa: skill "${SKILL_NAME}" not installed at ${s.dest} — run: npx autonomous-qa skill install`)
        return 1
      }
      if (!s.inSync) {
        console.error(`autonomous-qa: skill "${SKILL_NAME}" at ${s.dest} DRIFTED from the shipped copy — run: npx autonomous-qa skill install`)
        return 1
      }
      console.log(`autonomous-qa: skill "${SKILL_NAME}" in sync at ${s.dest}`)
      return 0
    }
    if (sub === 'install') {
      const s = installSkill()
      console.log(`autonomous-qa: skill "${SKILL_NAME}" installed → ${s.dest}`)
      return 0
    }
    return die('skill needs a mode: `skill install`, `skill --check`, or `skill --print`')
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

  if (cmd === 'vitest') {
    // vitest <suite.json|module.mjs> — run an `api.qa/vitest@1` artifact
    // LOCALLY through the SAME shared subset harness the hosted verifier
    // executes (AXP A.8.6.2 parity is by construction: one module, byte-
    // identical, never a reimplementation). Local runs are ADVISORY (never
    // attested); the definition of done is the SAME digest passing hosted.
    //
    //   npx autonomous-qa vitest suite.json --target https://api.example
    //       [--env <name>] [--expect-digest sha256:<64hex>] [--seed <n>] [--json]
    //   npx autonomous-qa vitest dist/index.mjs --target https://api.example
    //       [--export suite] [--expect-digest sha256:<64hex>]
    //
    // Artifact KIND follows the card rule (A.8.5): a path ending `.mjs` (or
    // `--module`) is a module artifact; anything else is a suite document.
    // The digest gate is FAIL-CLOSED: with --expect-digest, bytes that do not
    // hash to the pin never instantiate.
    const file = rest[0]
    if (!file) return die('vitest needs an artifact: a suite document (.json) or a module (.mjs)')
    const text = readFileSync(file, 'utf8')
    const digest = `sha256:${await sha256Hex(text)}`
    const expect = flags.get('expect-digest')
    if (expect !== undefined && expect !== digest) {
      console.error(
        `autonomous-qa: vitest artifact digest mismatch: expected ${expect}, ${file} hashes to ${digest}. ` +
          'NOTHING was instantiated (digest fail-closed, A.8.6.3).',
      )
      return 1
    }
    const isModule = flags.has('module') || /\.mjs$/i.test(file)
    const envName = flags.get('env') ?? 'public'

    let doc: Suite | undefined
    if (!isModule) {
      try {
        doc = parseExecSuiteDocument(text)
      } catch (err) {
        console.error(`autonomous-qa: ${err instanceof Error ? err.message : String(err)}`)
        return 1
      }
      if (!Object.hasOwn(doc.environments, envName)) {
        return die(
          `vitest: environment "${envName}" is not defined by the suite (it defines ${Object.keys(doc.environments).join(', ') || 'none'})`,
        )
      }
    } else if (flags.has('env') && envName !== 'public') {
      return die('vitest: a module artifact defines no environments — only the implicit "public" exists (A.8.6.4)')
    }
    const env = doc?.environments[envName]
    const vars = { ...(env?.vars ?? {}) }
    const target = flags.get('target') ?? (typeof vars.baseUrl === 'string' ? (vars.baseUrl as string) : undefined)
    if (!target) return die('vitest needs a target: --target <origin> (or a string `baseUrl` var in the selected environment)')
    const runSeed = seed ?? (Math.floor(Math.random() * 0xffffffff) >>> 0)

    const outcome: ExecRunOutcome = await localExecRunner().run({
      artifactKind: isModule ? 'module' : 'document',
      testsSource: isModule ? text : doc!.tests!,
      ...(doc?.module !== undefined && { moduleSource: doc.module }),
      ...(flags.has('export') && { exportName: flags.get('export') }),
      origin: new URL(/^https?:\/\//.test(target) ? target : `https://${target}`).origin,
      vars,
      environment: envName,
      sandbox: env?.sandbox === true,
      seed: runSeed,
      declarativeRows: doc?.requirements.length ?? 0,
      digest,
    })

    // Declarative rows (document form) keep unchanged suite@1 engine
    // semantics — run them through the SAME verifySuite door the `suite` verb
    // uses, folded into one exit code (A.8.6.5's one result set).
    let rowsPassed = true
    let rowLines: string[] = []
    if (doc !== undefined && doc.requirements.length > 0) {
      const rowSuite = JSON.stringify({
        $type: 'Suite',
        name: doc.name,
        version: doc.version,
        environments: doc.environments,
        requirements: doc.requirements,
      })
      const rowReport = await verifySuite(rowSuite, envName, {
        mode: 'local',
        seed: runSeed,
        target,
        delayMs: isLocalTarget(target) ? 0 : 150,
      })
      rowsPassed = rowReport.passed
      rowLines = rowReport.requirements.map(
        (r) => `  ${r.verdict === 'pass' ? 'PASS' : 'FAIL'} row ${r.id}${r.verdict === 'pass' ? '' : ` — ${r.detail}`}`,
      )
    }

    if (flags.get('json') === 'true') {
      console.log(JSON.stringify({ runner: 'api.qa/vitest@1', digest, seed: runSeed, environment: envName, outcome, rowsPassed }, null, 2))
    } else {
      console.log(`# api.qa/vitest@1 — local run (advisory, never attested)`)
      console.log(`artifact ${file} (${isModule ? 'module' : 'document'}), digest ${digest}`)
      console.log(`target ${target}, environment "${envName}"${env?.sandbox === true ? ' (sandbox)' : ''}, seed ${runSeed}`)
      for (const line of rowLines) console.log(line)
      if (outcome.status === 'ran') {
        for (const r of outcome.results) {
          console.log(`  ${r.status === 'pass' ? 'PASS' : 'FAIL'} ${r.name} (${r.durationMs} ms)${r.reason ? ` — ${r.reason}` : ''}`)
        }
        console.log(
          `${outcome.results.filter((r) => r.status === 'pass').length}/${outcome.registered} tests passed ` +
            `(${outcome.elapsedWallMs} ms wall, limits ${outcome.appliedLimits.wallMs} ms wall / ${outcome.appliedLimits.cpuMs} ms CPU)`,
        )
      } else {
        console.log(`RUN ${outcome.status.toUpperCase()}: ${outcome.reason}`)
      }
    }
    const testsPassed = outcome.status === 'ran' && outcome.results.every((r) => r.status === 'pass')
    return testsPassed && rowsPassed ? 0 : 1
  }

  if (cmd === 'contract-diff') {
    // contract-diff <openapi-spec> <target> (ax-gyh): the highest-value CI gate
    // — "did this deploy break the published contract?". The spec is LOCAL (a
    // file, the published contract); the target is FETCHED live through the
    // SSRF-gated Observer (runContractDiff — no new un-gated fetch). Exit
    // NON-ZERO on ANY breaking operation diff (exitCodeFor over the report).
    const specFile = rest[0]
    const target = rest[1] ?? flags.get('target')
    if (!specFile || !target) return die('contract-diff needs <openapi-spec> <target>')
    const specText = readFileSync(specFile, 'utf8')
    // A localhost/private target URL opts into the private-host allowance the
    // same anchored-hostname way `dev <url>` does — never inferred from a
    // remote target (the SSRF invariant).
    const allowPrivate = isUrl(target) && isPrivateUrlHost(target)
    const report = await runContractDiff(specText, target, {
      seed,
      allowPrivate,
      delayMs: isLocalTarget(target) ? 0 : 150,
    })
    // A gate that verified NOTHING must never exit 0/PASSED (the CLI's own
    // silent-green fix): `breaking` is trivially 0 whenever no operation was
    // probed, so an un-diffable spec (wrong file, lost `paths`, unrecognized
    // shape) or a spec whose every declared operation is unprobeable would
    // otherwise print a clean PASSED report. die() loudly instead of emitting
    // a "clean" report; exitCodeFor() below is ALSO fixed (defense in depth
    // for any other caller of the raw report).
    if (!report.openapiValid) {
      return die(`contract-diff: ${specFile} has no valid OpenAPI contract to diff — refusing to report a clean pass`)
    }
    if (report.operationsProbed === 0) {
      return die(
        `contract-diff: zero probeable operations in ${specFile} against ${target} — refusing to report a clean pass`,
      )
    }
    return emit(report, contractDiffMarkdown(report), flags)
  }

  if (cmd === 'mock') {
    // mock <spec> --port <n> (ax-gyh): stand up a LOCAL deterministic mock HTTP
    // server from a published OpenAPI spec, so the offline loop `mock -> run
    // suite against it -> teardown` works in a network-isolated pipeline. The
    // mock only SERVES locally generated responses (no outbound fetch, no SSRF
    // surface). Long-running: it serves until the process is signalled.
    const specFile = rest[0]
    const portRaw = flags.get('port')
    if (!specFile || !portRaw || portRaw === 'true') return die('mock needs <spec> and --port <n>')
    const port = Number(portRaw)
    if (!Number.isInteger(port) || port < 0 || port > 65535) return die(`mock: invalid --port "${portRaw}" (expected 0–65535)`)
    const specText = readFileSync(specFile, 'utf8')
    let doc: unknown
    try {
      doc = JSON.parse(specText)
    } catch (err) {
      return die(`mock: spec is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
    }
    const started = await startMockServer(doc, port, seed !== undefined ? { seed } : {})
    console.error(
      `autonomous-qa: deterministic mock for ${specFile} → http://127.0.0.1:${started.port} ` +
        `(seed ${seed ?? DEFAULT_MOCK_SEED}); serves declared operations, 404s the rest. Ctrl-C to stop.`,
    )
    const stop = (): void => {
      void started.close().finally(() => process.exit(0))
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
    // Serve until signalled — never resolve, so the process stays alive.
    return new Promise<number>(() => {})
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

  if (cmd === 'gate') {
    // gate --estate <config.json> (ax-laf): run the pinned gate across a SET of
    // surfaces and turn the whole estate into ONE pass/fail + a scoreboard. The
    // exit code is NON-ZERO iff any REQUIRED surface failed its pinned spec or
    // errored — the estate-wide silent-green guard. Reuses gradePinned() /
    // grade() per entry (src/gate.ts); grading is never reimplemented here.
    const configFile = flags.get('estate') ?? rest[0]
    if (!configFile) return die('gate needs an estate config: --estate <config.json>')
    let config: { entries?: unknown }
    try {
      config = JSON.parse(readFileSync(configFile, 'utf8')) as { entries?: unknown }
    } catch (err) {
      return die(`gate: could not read estate config "${configFile}": ${err instanceof Error ? err.message : String(err)}`)
    }
    if (!Array.isArray(config.entries) || config.entries.length === 0) {
      return die(`gate: estate config "${configFile}" has no entries[]`)
    }
    // Spec paths in the config are resolved relative to the config file's dir.
    const baseDir = dirname(resolve(configFile))
    const entries: GateEntry[] = config.entries.map((raw, i) => {
      const e = raw as Record<string, unknown>
      const surface = typeof e.surface === 'string' ? e.surface : `entry-${i}`
      const target = e.target
      if (typeof target !== 'string') {
        throw new Error(`gate: entry ${surface} has no string "target" (a URL; in-process handlers use the programmatic runEstateGate())`)
      }
      const specText = typeof e.spec === 'string' ? readFileSync(resolve(baseDir, e.spec), 'utf8') : undefined
      return {
        surface,
        target,
        specText,
        required: e.required !== false,
        allowPrivate: e.allowPrivate === true || (isUrl(target) && isPrivateUrlHost(target)),
        expectedDigest: typeof e.expectDigest === 'string' ? e.expectDigest : undefined,
        seed,
        note: typeof e.note === 'string' ? e.note : undefined,
      }
    })
    const result = await runEstateGate(entries)
    console.log(formatScoreboard(result))
    return result.exitCode
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
  npx autonomous-qa vitest <suite.json|module.mjs>    run an api.qa/vitest@1 executable suite LOCALLY
      --target <origin> [--env <name>] [--export <n>] through the SAME shared subset harness the hosted
      [--expect-digest <sha256:…>] [--seed <n>]       verifier executes (local==hosted by construction);
      [--module] [--json]                             EXITS NON-ZERO iff any test or row fails
  npx autonomous-qa contract-diff <spec> <target>    did this deploy break the published contract?
      [--json] [--reporter ...] [--seed <n>]          EXITS NON-ZERO on any breaking operation diff
      (spec is the published OpenAPI file; target is fetched live, SSRF-gated)
  npx autonomous-qa mock <spec> --port <n>            local deterministic mock server from an OpenAPI spec
      [--seed <n>]                                    serves declared operations; undeclared paths 404
  npx autonomous-qa gate --estate <config.json>       run the pinned gate across a SET of surfaces
      [--seed <n>] [--reporter ...]                   ONE scoreboard; EXITS NON-ZERO if any required surface fails
  npx autonomous-qa spec-digest <file>                print the sha256 pin for a spec/suite
  npx autonomous-qa skill install                     install the AXP skill → ~/.claude/skills/axp/
      [--check drift vs shipped | --print to stdout]  (verifier-side mirror of the canonical
                                                       installer: npx axp.org.ai skill install)
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
  // process.exitCode, never process.exit(): a piped stdout flushes
  // asynchronously, and exit() drops whatever the pipe hasn't accepted yet —
  // a report larger than the pipe buffer would reach CI truncated. Setting
  // exitCode lets Node drain stdio, then exit with the same status.
  (code) => { process.exitCode = code },
  (err) => {
    console.error(`autonomous-qa: ${err instanceof Error ? err.message : err}`)
    process.exitCode = 1
  },
)
