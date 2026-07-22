/**
 * The ESTATE GATE — run api.qa's pinned-spec gate across a SET of surfaces and
 * turn the whole set into ONE pass/fail with a scoreboard, for a CI job or a
 * local pre-deploy sweep.
 *
 * This is a thin, reusable orchestration layer over the merged local runner
 * (src/local.ts): it does NOT reimplement grading. For each (surface, target,
 * pinnedSpec) entry it calls:
 *
 *   - `gradePinned(target, specText)` → the AUTHORITATIVE gate signal for that
 *     surface (`passed`), the same verdict the deployed api.qa would return for
 *     the pinned contract. This is what the exit code is computed from.
 *   - `grade(target)` → the advisory AX letter grade + score, purely
 *     INFORMATIONAL for the scoreboard (best-effort: a failure here never
 *     changes the gate verdict, only annotates the row).
 *
 * A `target` is anything the local runner accepts: a deployed/dev URL string,
 * a localhost dev-server URL (with `allowPrivate: true`), or an in-process
 * Worker handler / `{ fetch }` module dispatched in memory. The SSRF invariant
 * is entirely inherited from src/local.ts — this layer adds no fetch of its own.
 *
 * EXIT CODE (the one property that matters — a gate that exits 0 on a failure is
 * a silent green): `exitCode` is 1 iff any REQUIRED entry either (a) has a
 * pinned spec its target failed, or (b) errored (unreachable, digest mismatch,
 * bad handler). An entry with no spec is advisory-only and can only fail the
 * gate by erroring. Non-required entries never change the exit code.
 */

import { grade, gradePinned, type GradeTarget } from './local.js'
import type { Grade } from './types.js'

export interface GateEntry {
  /** Human name for the surface (e.g. `page.ax`, `apis.ax`). */
  surface: string
  /** URL string, localhost dev URL, or in-process handler / `{ fetch }`. */
  target: GradeTarget
  /** The pinned-spec TEXT. Omit for an advisory-only (informational) row. */
  specText?: string
  /** Does a failure of this entry fail the whole gate? Default true. */
  required?: boolean
  /** OPT-IN private/localhost allowance for a dev-server URL target. */
  allowPrivate?: boolean
  /** The anti-Goodhart pin: spec text MUST hash to this or the entry errors. */
  expectedDigest?: string
  /** Replay seed (default: fresh per run). */
  seed?: number
  /** A human label for the target column (defaults to the URL or a handler tag). */
  displayTarget?: string
  /** Free-form note carried onto the row (e.g. how the surface was stood up). */
  note?: string
}

export interface GateRow {
  surface: string
  target: string
  /** Advisory AX letter grade, or null if the advisory pass errored. */
  grade: Grade | null
  /** Advisory AX score (points), or null. */
  score: number | null
  max: number | null
  /** Pinned-spec verdict: true/false, or null when the entry has no spec. */
  passesPinnedSpec: boolean | null
  hasSpec: boolean
  required: boolean
  /** The failing requirement ids, when a pinned spec did not pass. */
  failedRequirements: string[]
  /** A fatal error (unreachable, digest mismatch, bad handler), or null. */
  error: string | null
  note?: string
}

export interface GateResult {
  rows: GateRow[]
  /** 1 iff any REQUIRED entry failed its pinned spec or errored; else 0. */
  exitCode: number
  /** Surfaces that failed the gate (required + failed/errored). */
  failed: string[]
}

function displayFor(entry: GateEntry): string {
  if (entry.displayTarget) return entry.displayTarget
  if (typeof entry.target === 'string') return entry.target
  return '<in-process handler>'
}

/**
 * Grade one entry: pinned verdict (authoritative) + advisory grade
 * (informational, best-effort). A thrown error from the pinned pass is the
 * gate-failing signal; a thrown error from the advisory pass only nulls the
 * grade columns.
 */
async function runEntry(entry: GateEntry): Promise<GateRow> {
  const required = entry.required !== false
  const hasSpec = typeof entry.specText === 'string'
  const row: GateRow = {
    surface: entry.surface,
    target: displayFor(entry),
    grade: null,
    score: null,
    max: null,
    passesPinnedSpec: hasSpec ? false : null,
    hasSpec,
    required,
    failedRequirements: [],
    error: null,
    note: entry.note,
  }

  const opts = { allowPrivate: entry.allowPrivate === true, seed: entry.seed }

  // Authoritative gate signal first: the pinned verdict. A throw here
  // (unreachable, digest pin mismatch, invalid spec) is a hard gate failure.
  if (hasSpec) {
    try {
      const pinned = await gradePinned(entry.target, entry.specText!, {
        ...opts,
        expectedDigest: entry.expectedDigest,
      })
      row.passesPinnedSpec = pinned.passed
      row.failedRequirements = pinned.requirements.filter((r) => r.verdict === 'fail').map((r) => r.id)
    } catch (err) {
      row.error = err instanceof Error ? err.message : String(err)
      return row
    }
  }

  // Advisory letter grade — informational only. Never changes the verdict.
  try {
    const advisory = await grade(entry.target, opts)
    row.grade = advisory.grade
    row.score = advisory.axScore.points
    row.max = advisory.axScore.max
  } catch (err) {
    // Keep the pinned verdict; annotate that the advisory pass could not run.
    if (!row.error) row.note = `${row.note ? row.note + '; ' : ''}advisory grade unavailable: ${err instanceof Error ? err.message : String(err)}`
  }

  return row
}

/**
 * Run the whole estate. Entries are graded sequentially (deterministic output,
 * and dev servers behind localhost targets are typically single-tenant). The
 * exit code is the AND of every required entry's gate signal.
 */
export async function runEstateGate(entries: GateEntry[]): Promise<GateResult> {
  const rows: GateRow[] = []
  for (const entry of entries) rows.push(await runEntry(entry))

  const failed = rows
    .filter((r) => r.required && (r.error !== null || (r.hasSpec && r.passesPinnedSpec === false)))
    .map((r) => r.surface)

  return { rows, exitCode: failed.length > 0 ? 1 : 0, failed }
}

/** Render the scoreboard as a markdown table + a verdict line. */
export function formatScoreboard(result: GateResult): string {
  const header = '| surface | target | grade | score | pinned spec | required |'
  const sep = '| --- | --- | --- | --- | --- | --- |'
  const lines = result.rows.map((r) => {
    const gradeCell = r.grade ?? '—'
    const scoreCell = r.score === null ? '—' : `${r.score}/${r.max}`
    const pinnedCell = r.error
      ? `ERROR: ${r.error}`
      : !r.hasSpec
        ? 'n/a (advisory)'
        : r.passesPinnedSpec
          ? 'PASS'
          : `FAIL (${r.failedRequirements.join(', ') || 'no requirement passed'})`
    return `| ${r.surface} | ${r.target} | ${gradeCell} | ${scoreCell} | ${pinnedCell} | ${r.required ? 'yes' : 'no'} |`
  })
  const verdict =
    result.exitCode === 0
      ? '\n**GATE PASSED** — every required surface conforms to its pinned spec.'
      : `\n**GATE FAILED** — required surface(s) failed: ${result.failed.join(', ')}.`
  const notes = result.rows.filter((r) => r.note).map((r) => `- ${r.surface}: ${r.note}`)
  return [header, sep, ...lines].join('\n') + (notes.length ? '\n\nNotes:\n' + notes.join('\n') : '') + '\n' + verdict
}
