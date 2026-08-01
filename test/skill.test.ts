/**
 * `autonomous-qa skill` — distribution tests for the AXP skill.
 *
 * Three properties, all enforced on every `npm test` (and therefore on every
 * publish, since scripts/publish.sh runs the suite before `npm publish`):
 *
 *  1. SHIP INTEGRITY — the file `skill install` writes byte-matches the
 *     shipped `skill/SKILL.md`, `--check` detects drift, and the tarball
 *     actually carries the file (`files[]` includes "skill").
 *  2. CANON SYNC — when the canonical axp.org.ai repo is checked out as a
 *     sibling, the shipped copy (and the repo's plugin copy) byte-match its
 *     `skill/SKILL.md`. Skipped on machines without the sibling checkout.
 *  3. PUBLISH RAILS SECRET-SCAN — the skill content is a published artifact;
 *     it must contain no secrets and no internal references (local paths,
 *     usernames, private hostnames, internal jargon). The published skill is
 *     written for EXTERNAL users.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import {
  shippedSkillPath,
  skillText,
  installDest,
  installSkill,
  checkSkill,
  SKILL_NAME,
} from '../cli/skill.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const canonicalRepo = resolve(repoRoot, '..', 'axp.org.ai')
const canonicalSkill = join(canonicalRepo, 'skill', 'SKILL.md')
const canonicalPluginCopy = join(canonicalRepo, 'plugin', 'skills', SKILL_NAME, 'SKILL.md')

function withTempHome<T>(fn: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), 'aqa-skill-'))
  try {
    return fn(home)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

describe('skill: ship integrity', () => {
  it('ships skill/SKILL.md with the expected frontmatter identity', () => {
    const text = skillText()
    expect(shippedSkillPath()).toBe(join(repoRoot, 'skill', 'SKILL.md'))
    expect(text.startsWith('---\n')).toBe(true)
    expect(text).toMatch(/^name: axp$/m)
    expect(text).toContain('# AXP — the agent-experience standard')
  })

  it('package.json files[] carries the skill dir into the tarball', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      files?: string[]
    }
    expect(pkg.files).toContain('skill')
  })

  it('install writes a byte-identical copy to <home>/.claude/skills/axp/SKILL.md', () => {
    withTempHome((home) => {
      const status = installSkill(home)
      expect(status.dest).toBe(installDest(home))
      expect(status.dest).toBe(join(home, '.claude', 'skills', SKILL_NAME, 'SKILL.md'))
      expect(readFileSync(status.dest, 'utf8')).toBe(skillText())
      expect(status.inSync).toBe(true)
    })
  })

  it('--check reports missing, in-sync, and drifted states correctly', () => {
    withTempHome((home) => {
      expect(checkSkill(home)).toMatchObject({ installed: false, inSync: false })
      installSkill(home)
      expect(checkSkill(home)).toMatchObject({ installed: true, inSync: true })
      writeFileSync(installDest(home), skillText() + '\n<!-- local edit -->\n')
      expect(checkSkill(home)).toMatchObject({ installed: true, inSync: false })
    })
  })

  it('install is idempotent and repairs drift', () => {
    withTempHome((home) => {
      installSkill(home)
      writeFileSync(installDest(home), 'DRIFTED')
      installSkill(home)
      expect(checkSkill(home).inSync).toBe(true)
    })
  })
})

describe('skill: canon sync (axp.org.ai sibling checkout)', () => {
  it.skipIf(!existsSync(canonicalSkill))(
    'shipped copy byte-matches the canonical axp.org.ai skill/SKILL.md',
    () => {
      expect(skillText()).toBe(readFileSync(canonicalSkill, 'utf8'))
    },
  )

  it.skipIf(!existsSync(canonicalPluginCopy))(
    'axp.org.ai plugin/skills/axp copy byte-matches its canonical skill/SKILL.md',
    () => {
      expect(readFileSync(canonicalPluginCopy, 'utf8')).toBe(readFileSync(canonicalSkill, 'utf8'))
    },
  )
})

describe('skill: publish-rails secret scan (published artifact discipline)', () => {
  const text = skillText()

  // Secret-material shapes. Fixtures and published artifacts are scanned like
  // this everywhere; the skill is no exception.
  const secretPatterns: Array<[string, RegExp]> = [
    ['AWS access key', /AKIA[0-9A-Z]{16}/],
    ['OpenAI-style key', /\bsk-[A-Za-z0-9]{20,}/],
    ['Anthropic key', /\bsk-ant-/],
    ['GitHub token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/],
    ['Slack token', /\bxox[baprs]-/],
    ['private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
    ['bearer literal', /Bearer [A-Za-z0-9._-]{20,}/],
    ['npm token', /\bnpm_[A-Za-z0-9]{30,}/],
  ]

  it.each(secretPatterns)('contains no %s', (_label, pattern) => {
    expect(text).not.toMatch(pattern)
  })

  // Internal references: the published skill must read correctly for someone
  // with NO access to this machine or these repos.
  const internalPatterns: Array<[string, RegExp]> = [
    ['absolute local paths', /\/Users\//],
    ['home-relative project paths', /~\/(?:projects|platform)/],
    ['local usernames', /nathanclevenger|nateclev/i],
    ['personal emails', /@do\.industries|@driv\.ly/i],
    ['internal-repo pointers', /api\.lawyer|\bCONTEXT\.md\b|projects\/vis\b|projects\/law\b/],
    ['estate jargon', /\bestate\b/i],
    ['vendoring internals', /sync-core|vendor\.mjs|PINS\.json/],
  ]

  it.each(internalPatterns)('contains no %s', (_label, pattern) => {
    expect(text).not.toMatch(pattern)
  })

  it('doctrine anchors survived the de-internalization verbatim', () => {
    expect(text).toContain('converts **"trust us" into "run this."**')
    expect(text).toContain(
      'a claim with a published failing test is a P0; a claim with a published passing test is proven.',
    )
  })

  it('public reference points are present (spec, verifier, hosted verdicts)', () => {
    expect(text).toContain('https://axp.org.ai')
    expect(text).toContain('`autonomous-qa` on npm')
    expect(text).toContain('https://api.qa/<domain>')
    expect(text).toContain('npx autonomous-qa skill install')
  })
})
