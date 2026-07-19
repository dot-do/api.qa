/**
 * AX score + letter grade — the SSL Labs move. Ten binary items from the
 * R-k checklist score 0-10; honesty checks cap the grade rather than adding
 * points: a target that publishes false contracts can be complete and still
 * grade C, because the whole point is that agents can TRUST the surface.
 */

import type { AxScore, CheckResult, Grade } from './types.js'

export function axScoreOf(checks: CheckResult[]): AxScore {
  const items = checks
    .filter((c) => c.axItem !== undefined)
    .sort((a, b) => a.axItem! - b.axItem!)
    .map((c) => ({ item: c.axItem!, id: c.id, title: c.title, verdict: c.verdict }))
  return { points: items.filter((i) => i.verdict === 'pass').length, max: 10, items }
}

export function gradeOf(score: AxScore, checks: CheckResult[]): { grade: Grade; notes: string[] } {
  const notes: string[] = []
  let grade = byPoints(score.points)

  const honesty = checks.filter((c) => c.axItem === undefined && c.verdict === 'fail')
  if (honesty.length > 0) {
    const capped = minGrade(grade, 'C')
    if (capped !== grade) {
      notes.push(`grade capped at C: published contract contradicted by behavior (${honesty.map((c) => c.id).join(', ')}) — a lying surface is worse than a missing one`)
    }
    grade = capped
  }
  if (grade === 'A+' && score.points < 10) grade = 'A'
  if (score.points === 10 && honesty.length === 0) grade = 'A+'
  return { grade, notes }
}

function byPoints(points: number): Grade {
  if (points >= 10) return 'A+'
  if (points >= 9) return 'A'
  if (points >= 7) return 'B'
  if (points >= 5) return 'C'
  if (points >= 3) return 'D'
  return 'F'
}

const ORDER: Grade[] = ['F', 'D', 'C', 'B', 'A', 'A+']

function minGrade(a: Grade, b: Grade): Grade {
  return ORDER.indexOf(a) <= ORDER.indexOf(b) ? a : b
}
