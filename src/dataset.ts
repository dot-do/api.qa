/**
 * Data-driven suite runs — Newman's `--iteration-data` / a Postman data-driven
 * collection run, as a REUSE of the ratified-suite machinery (ax-e6b.28.1), not
 * a fork of it.
 *
 * Shape: one reusable Suite (pinned by the sha256 of its text) is executed ONCE
 * PER ROW of a dataset. For iteration `i`, that row's `{field: value}` map is
 * bound into the environment binding scope ON TOP of the selected environment's
 * vars (row fields override / extend env vars), then `verifySuite` runs with
 * those bindings. Every downstream mechanism — `{{var}}` interpolation, typed
 * whole-value vs embedded-string rules, capture-chaining, the undefined-var
 * fail-closed path, AND the SSRF gates (`normalizeTarget` on the resolved
 * target, `resolveEndpoint`'s same-origin re-gate on interpolated URLs) — is the
 * SAME code path a single suite run uses. A row is author-provided but UNTRUSTED
 * for SSRF: a row that sets `baseUrl` to a private/metadata/off-origin address
 * is refused for that iteration (that iteration fails closed, never fetched),
 * NOT fetched, exactly as a single run would refuse it.
 *
 * Iterations are INDEPENDENT: each `verifySuite` call rebuilds the binding scope
 * from env+row, so a capture in iteration `i` never leaks into iteration `i+1`.
 *
 * The aggregate is a per-iteration, per-probe pass/fail MATRIX plus a per-
 * iteration verdict and an OVERALL verdict (all iterations pass → pass; else
 * fail, with a count). Deterministic and pure over the individual runs.
 */

import { parseSuite, verifySuite, type SuiteReport, type VerifySuiteOpts } from './pinned.js'
import { sha256Hex } from './digest.js'
import type { Verdict } from './types.js'

/** A single dataset row: a `{fieldName: value}` map bound into the env scope. */
export type DatasetRow = Record<string, unknown>

/** A matrix cell: a probe's verdict, or `error` when the whole iteration was
 * refused before it could run (e.g. a private/off-origin row `baseUrl`). */
export type MatrixCell = Verdict | 'error'

export interface IterationResult {
  /** 0-based iteration index (dataset row order). */
  index: number
  /** The row bound into the env scope for this iteration. */
  row: DatasetRow
  /** Whether every probe in this iteration passed AND the iteration ran. */
  passed: boolean
  /** probeId → verdict for this iteration (`error` for all if it was refused). */
  verdicts: Record<string, MatrixCell>
  /** The underlying suite report, present when the iteration actually ran. */
  report?: SuiteReport
  /** Fail-closed reason when the iteration was refused before running (e.g. the
   * row's `baseUrl` failed `normalizeTarget`). No fetch happened. */
  error?: string
}

export interface DataDrivenReport {
  $type: 'DataDrivenSuiteReport'
  verifier: 'api.qa'
  verifierVersion: string
  mode: 'remote' | 'local'
  suite: { name: string; version: string; digest: string; environment: string }
  /** Column order of the matrix: the suite's ordered probe (requirement) ids. */
  probeIds: string[]
  /** One entry per dataset row, in row order. */
  iterations: IterationResult[]
  /** `matrix[i][j]` = iteration i's verdict for `probeIds[j]`. */
  matrix: MatrixCell[][]
  /** OVERALL verdict: true iff EVERY iteration passed. */
  passed: boolean
  passedCount: number
  failedCount: number
  total: number
}

// ---------------------------------------------------------------------------
// Dataset parsing (CSV or JSON, no heavy dependency)
// ---------------------------------------------------------------------------

export type DatasetFormat = 'csv' | 'json'

export interface ParseDatasetOpts {
  /** Force a format. When omitted, JSON is detected by a leading `[`/`{` (after
   * whitespace); anything else is parsed as CSV. */
  format?: DatasetFormat
}

/**
 * Parse a dataset into an ordered list of row objects.
 *
 * JSON: a top-level ARRAY of row OBJECTS. Each element keeps its JSON types (a
 *   number stays a number, so typed whole-value interpolation preserves it).
 * CSV (RFC 4180, minimally correct): the first record is the HEADER of field
 *   names; each subsequent record is one row. Fields may be double-quoted to
 *   contain commas, CRLF/LF newlines, and escaped quotes (`""`). CSV cells are
 *   always STRINGS — the format is untyped, so (like Newman) no coercion is
 *   done; author a JSON dataset when a field must bind as a number/boolean.
 */
export function parseDataset(text: string, opts: ParseDatasetOpts = {}): DatasetRow[] {
  const format = opts.format ?? (/^\s*[[{]/.test(text) ? 'json' : 'csv')
  return format === 'json' ? parseJsonDataset(text) : parseCsvDataset(text)
}

function parseJsonDataset(text: string): DatasetRow[] {
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch (err) {
    throw new Error(`dataset is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!Array.isArray(doc)) {
    throw new Error('JSON dataset must be an ARRAY of row objects (Newman --iteration-data shape)')
  }
  return doc.map((row, i) => {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error(`JSON dataset row ${i} must be an object of {fieldName: value}, got ${describe(row)}`)
    }
    return { ...(row as Record<string, unknown>) }
  })
}

/**
 * RFC 4180-minimal CSV parser: a small correct state machine (not a regex).
 * Handles quoted fields containing commas, LF/CRLF newlines, and doubled
 * quotes (`""` → a literal `"`). A trailing blank line is ignored. Every data
 * record must have the same field count as the header.
 */
function parseCsvDataset(text: string): DatasetRow[] {
  const records = parseCsvRecords(text)
  if (records.length === 0) throw new Error('CSV dataset is empty (no header row)')
  const header = records[0]!
  const seen = new Set<string>()
  for (const h of header) {
    if (h.length === 0) throw new Error('CSV header has an empty field name')
    if (seen.has(h)) throw new Error(`CSV header has a duplicate field name "${h}"`)
    seen.add(h)
  }
  const rows: DatasetRow[] = []
  for (let r = 1; r < records.length; r++) {
    const rec = records[r]!
    if (rec.length !== header.length) {
      throw new Error(
        `CSV data row ${r} has ${rec.length} field(s), expected ${header.length} to match the header`,
      )
    }
    const row: DatasetRow = {}
    for (let c = 0; c < header.length; c++) row[header[c]!] = rec[c]!
    rows.push(row)
  }
  return rows
}

/** Tokenize CSV text into records of string fields (RFC 4180 minimal). */
function parseCsvRecords(text: string): string[][] {
  const records: string[][] = []
  let field = ''
  let record: string[] = []
  let inQuotes = false
  let sawAny = false // any char in the current field/record (to detect real emptiness)
  let i = 0
  const n = text.length
  const pushField = () => {
    record.push(field)
    field = ''
  }
  const pushRecord = () => {
    pushField()
    records.push(record)
    record = []
    sawAny = false
  }
  while (i < n) {
    const ch = text[i]!
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i++
        continue
      }
      field += ch
      i++
      continue
    }
    if (ch === '"') {
      inQuotes = true
      sawAny = true
      i++
      continue
    }
    if (ch === ',') {
      sawAny = true
      pushField()
      i++
      continue
    }
    if (ch === '\r') {
      // CRLF or lone CR ends the record.
      pushRecord()
      if (text[i + 1] === '\n') i += 2
      else i++
      continue
    }
    if (ch === '\n') {
      pushRecord()
      i++
      continue
    }
    field += ch
    sawAny = true
    i++
  }
  // Flush the final record unless the input ended exactly on a newline (i.e. the
  // trailing field/record is genuinely empty — a common trailing-newline case).
  if (inQuotes) throw new Error('CSV dataset has an unterminated quoted field')
  if (sawAny || field.length > 0) pushRecord()
  return records
}

// ---------------------------------------------------------------------------
// Data-driven run
// ---------------------------------------------------------------------------

export interface VerifySuiteDataDrivenOpts extends VerifySuiteOpts {}

/**
 * Run a reusable Suite ONCE PER ROW of a dataset, binding each row into the env
 * scope, and aggregate a per-iteration/per-probe matrix + overall verdict.
 *
 * The suite digest pin and the environment name are validated ONCE up front
 * (fail closed before any iteration): a wrong pin, an unknown environment, or a
 * malformed suite refuses the whole run without fetching. Each iteration then
 * delegates to `verifySuite` with `rowBindings: row`; a row that fails the SSRF
 * gate before running (e.g. a private `baseUrl`) is caught and marked a
 * fail-closed `error` iteration — the hostile target is never fetched — while
 * the remaining rows still run.
 */
export async function verifySuiteDataDriven(
  suiteText: string,
  envName: string,
  rows: DatasetRow[],
  opts: VerifySuiteDataDrivenOpts = {},
): Promise<DataDrivenReport> {
  const mode = opts.mode ?? 'remote'
  const digest = await sha256Hex(suiteText)

  // Anti-Goodhart gate, once, before any iteration.
  if (opts.expectedDigest && opts.expectedDigest !== digest) {
    throw new Error(
      `suite digest mismatch: expected ${opts.expectedDigest}, supplied text hashes to ${digest}. ` +
        'The pinned suite is not the one this text represents — refusing to verify.',
    )
  }

  const suite = parseSuite(suiteText)
  if (!Object.hasOwn(suite.environments, envName)) {
    const defined = Object.keys(suite.environments)
    throw new Error(
      `unknown environment "${envName}" — suite "${suite.name}" defines ` +
        `${defined.length ? defined.map((nm) => `"${nm}"`).join(', ') : '(no environments)'}`,
    )
  }
  if (rows.length === 0) throw new Error('dataset has no rows — nothing to iterate')

  const probeIds = suite.requirements.map((r) => r.id)

  const iterations: IterationResult[] = []
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!
    try {
      const report = await verifySuite(suiteText, envName, {
        ...opts,
        mode,
        // Pin already checked once up front; do not recompute/re-gate per row.
        expectedDigest: undefined,
        // The row layered on top of the environment's vars for THIS iteration.
        rowBindings: row,
      })
      const byId = new Map(report.requirements.map((c) => [c.id, c.verdict] as const))
      const verdicts: Record<string, MatrixCell> = {}
      for (const id of probeIds) verdicts[id] = byId.get(id) ?? 'error'
      iterations.push({ index, row, passed: report.passed, verdicts, report })
    } catch (err) {
      // Fail closed: the iteration was refused before it could run (e.g. the
      // row's baseUrl failed normalizeTarget). Nothing was fetched. Every probe
      // is an `error` cell; the iteration counts as failed.
      const verdicts: Record<string, MatrixCell> = {}
      for (const id of probeIds) verdicts[id] = 'error'
      iterations.push({
        index,
        row,
        passed: false,
        verdicts,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const matrix: MatrixCell[][] = iterations.map((it) => probeIds.map((id) => it.verdicts[id]!))
  const passedCount = iterations.filter((it) => it.passed).length
  const failedCount = iterations.length - passedCount

  return {
    $type: 'DataDrivenSuiteReport',
    verifier: 'api.qa',
    verifierVersion: iterations.find((it) => it.report)?.report?.verifierVersion ?? '',
    mode,
    suite: { name: suite.name, version: suite.version, digest, environment: envName },
    probeIds,
    iterations,
    matrix,
    passed: failedCount === 0,
    passedCount,
    failedCount,
    total: iterations.length,
  }
}

function describe(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v
}
