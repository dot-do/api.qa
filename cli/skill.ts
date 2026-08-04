/**
 * `autonomous-qa skill` — distribute the AXP skill from the package that owns
 * verification.
 *
 * The canonical source of truth is `skill/SKILL.md` in the axp.org.ai repo;
 * this package ships a byte-identical copy in its `skill/` directory (pinned
 * by test/skill.test.ts, which also secret-scans the content on every
 * `npm test` — i.e. on every publish, since scripts/publish.sh runs the
 * suite before `npm publish`).
 *
 * Split out of cli/index.ts (which unconditionally runs `main()` at import
 * time, so it is not safe to import from tests) — same pattern as
 * cli/target.ts.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

export const SKILL_NAME = 'axp'

/**
 * Locate the shipped `skill/SKILL.md` by walking up from THIS module — the
 * module sits at `cli/skill.ts` in the repo but `dist/cli/skill.js` in the
 * published tarball, so the depth to the package root differs by one; a
 * bounded upward walk covers both without hardcoding either.
 */
export function shippedSkillPath(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, 'skill', 'SKILL.md')
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error('skill: shipped skill/SKILL.md not found in package (corrupt install?)')
}

/** Read the shipped skill content (what `--print` writes to stdout). */
export function skillText(): string {
  return readFileSync(shippedSkillPath(), 'utf8')
}

/** Where `install` writes: `<home>/.claude/skills/axp/SKILL.md`. */
export function installDest(home: string = homedir()): string {
  return join(home, '.claude', 'skills', SKILL_NAME, 'SKILL.md')
}

export interface SkillStatus {
  source: string
  dest: string
  installed: boolean
  /** true iff the installed file byte-matches the shipped copy. */
  inSync: boolean
}

/** Drift check for `--check`: compares installed bytes against shipped bytes. */
export function checkSkill(home: string = homedir()): SkillStatus {
  const source = shippedSkillPath()
  const dest = installDest(home)
  if (!existsSync(dest)) return { source, dest, installed: false, inSync: false }
  const inSync = readFileSync(dest, 'utf8') === readFileSync(source, 'utf8')
  return { source, dest, installed: true, inSync }
}

/** `install`: copy the shipped skill into place (overwrites; idempotent). */
export function installSkill(home: string = homedir()): SkillStatus {
  const source = shippedSkillPath()
  const dest = installDest(home)
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, readFileSync(source, 'utf8'))
  return { source, dest, installed: true, inSync: true }
}
