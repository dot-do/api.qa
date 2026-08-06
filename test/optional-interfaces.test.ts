/**
 * THE OPTIONAL-DECLARED-INTERFACE MECHANISM.
 *
 * `appliesWhen: { cardDeclares: "interfaces.<key>" }` — a pinned requirement
 * that is verified only when the target's capability card DECLARES the optional
 * interface it verifies.
 *
 * ── Why almost every test in this file is a FAILING case ────────────────────
 *
 * An optionality mechanism is an EVASION mechanism if misapplied. If a
 * requirement can be skipped by not declaring something, then every clause
 * reachable that way stops being a MUST — a target opts out by omission and the
 * report still says PASSED. So the properties worth holding are almost all
 * negative:
 *
 *   1. **The guard refuses.** A spec that tries to gate a check api.qa has not
 *      registered as an ADDITIVE capability throws at PARSE, before a probe
 *      fires. Not a warning, not a lenient verdict — no verdict at all.
 *   2. **Only an omission INSIDE a readable card skips.** An unreachable card,
 *      a non-JSON card, a card that is not an object, a card whose `interfaces`
 *      is a string — every one of those APPLIES the requirement and fails
 *      closed. Absence of the document is not a statement; only absence in it is.
 *   3. **A present-but-empty declaration is a CLAIM, not an absence.** `null`,
 *      `false`, `0`, `""`, `[]`, `"yes"` all ARM the check and FAIL it. A card
 *      meaning "no" omits the key. This is what stops "declare it false, get a
 *      free skip".
 *   4. **A skip is legible as a skip.** A not-applicable requirement is
 *      distinguishable from a verified pass and from a never-produced check
 *      WITHOUT string-matching prose, and it renders as a JUnit `<skipped/>`.
 *
 * ── Independence ────────────────────────────────────────────────────────────
 *
 * Nothing here imports anything from the standard's repo. The registry under
 * test is api.qa's own; a spec is external JSON parsed at runtime and is
 * treated throughout as adversarial input written by a stranger.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  verifyPinnedSpec,
  parsePinnedSpec,
  parseSuite,
  readCardDeclaration,
} from '../src/pinned.js'
import {
  OPTIONAL_DECLARED_INTERFACES,
  OPTIONAL_INTERFACE_PATH_RE,
} from '../src/optional-interfaces.js'
import { GS1_RESOLVER_WELL_KNOWN_PATH } from '../src/gs1-resolver.js'
import { ROLE } from '../src/discovery.js'
import { junitXml, jsonReport } from '../src/reporters.js'
import { pinnedMarkdown } from '../src/render.js'
import type { Evidence } from '../src/types.js'
import type { Fetcher } from '../src/http.js'
import { GOOD, goodTargetRoutes, makeFetcher, withOverrides, type Routes } from './helpers.js'
import { axpReferenceRoutes, urlAwareFetcher } from './axp-fixture.js'
import { assertWellFormedXml } from './helpers.js'

const AXP_SPEC_PATH = new URL('../examples/ax/apis-ax-standard.spec.json', import.meta.url)

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

const WK_ROUTE = `GET ${GS1_RESOLVER_WELL_KNOWN_PATH}`

/** A GS1 resolver description file that satisfies the published schema. */
const VALID_DESCRIPTION_FILE = {
  resolverRoot: GOOD,
  supportedPrimaryKeys: ['01'],
}

const json = (value: unknown, contentType = 'application/json') => () => ({
  status: 200, contentType, body: JSON.stringify(value),
})

const OMIT = Symbol('omit')
/** Serve NO well-known at all (the route 404s). Not `undefined`, which a JS
 *  default parameter would silently turn back into the valid document. */
const NO_WELL_KNOWN = Symbol('no-well-known')

/**
 * The good target with `interfaces.digitalLink` set to `declaration` (or the
 * key left off entirely for OMIT), and a well-known route unless suppressed.
 */
function cardRoutes(
  declaration: unknown | typeof OMIT,
  wellKnown: Routes[string] | typeof NO_WELL_KNOWN = json(VALID_DESCRIPTION_FILE),
): Routes {
  const base = goodTargetRoutes()
  const card = JSON.parse(
    base['GET /.well-known/agents.json']!({ method: 'GET', accept: 'application/json' }).body!,
  ) as Record<string, any>
  if (declaration !== OMIT) card.interfaces.digitalLink = declaration
  return withOverrides(base, {
    'GET /.well-known/agents.json': json(card),
    ...(wellKnown === NO_WELL_KNOWN ? {} : { [WK_ROUTE]: wellKnown }),
  })
}

/** Serve a raw (possibly non-JSON, possibly non-object) body as the card. */
function rawCardRoutes(status: number, contentType: string, body: string): Routes {
  return withOverrides(goodTargetRoutes(), {
    'GET /.well-known/agents.json': () => ({ status, contentType, body }),
  })
}

/** The minimum spec that exercises the mechanism and nothing else. */
const DL_REQUIREMENT = {
  id: 'check-digital-link-resolver', kind: 'check', check: 'digital-link-resolver', must: 'pass',
  appliesWhen: { cardDeclares: 'interfaces.digitalLink' },
}

function specText(requirements: unknown[], name = 'optional-mechanism'): string {
  return JSON.stringify({ $type: 'PinnedSpec', name, version: '1', requirements })
}

const DL_SPEC = specText([DL_REQUIREMENT])

/** Run a spec, recording every URL the verifier actually fetched. */
async function run(spec: string, routes: Routes, fetcher?: Fetcher) {
  const calls: string[] = []
  const inner = fetcher ?? makeFetcher(routes)
  const report = await verifyPinnedSpec(GOOD, spec, {
    fetcher: async (url, init) => { calls.push(url); return inner(url, init) },
    delayMs: 0, seed: 7, mode: 'local',
  })
  const dl = report.requirements.find((r) => r.id === 'check-digital-link-resolver')!
  return { report, dl, calls }
}

/** A minimal Evidence item standing in for the observed capability card. */
function cardEvidence(over: Partial<Evidence> = {}): Evidence[] {
  return [{
    role: ROLE.agentsJson,
    url: `${GOOD}/.well-known/agents.json`,
    method: 'GET',
    status: 200,
    contentType: 'application/json',
    headers: {},
    body: '{}',
    elapsedMs: 1,
    ...over,
  }]
}

// ===========================================================================
// 1. THE REGISTRY — the thing that decides what may be skipped at all
// ===========================================================================

describe('the optional-declared-interface registry', () => {
  it('is frozen: a runtime edit cannot widen what may be skipped', () => {
    expect(Object.isFrozen(OPTIONAL_DECLARED_INTERFACES)).toBe(true)
    expect(() => {
      // @ts-expect-error — deliberately attacking the guard at runtime.
      OPTIONAL_DECLARED_INTERFACES['keyless-flow'] = 'interfaces.anything'
    }).toThrow()
    expect(OPTIONAL_DECLARED_INTERFACES['keyless-flow']).toBeUndefined()
  })

  it('every registered card path obeys the two-segment `interfaces.<key>` grammar', () => {
    for (const [check, path] of Object.entries(OPTIONAL_DECLARED_INTERFACES)) {
      expect(path, check).toMatch(OPTIONAL_INTERFACE_PATH_RE)
    }
  })

  it('binds each check to exactly ONE card path, and no two checks share a path', () => {
    const paths = Object.values(OPTIONAL_DECLARED_INTERFACES)
    expect(new Set(paths).size, paths.join(', ')).toBe(paths.length)
  })

  it('registers digital-link-resolver against interfaces.digitalLink — the retrofit that makes it pinnable', () => {
    expect(OPTIONAL_DECLARED_INTERFACES['digital-link-resolver']).toBe('interfaces.digitalLink')
  })

  /**
   * The whole point of the registry, asserted as a property rather than a
   * comment: none of the checks that always-required clauses bind may ever be
   * made conditional on a card key. If someone adds one of these to the
   * registry, this goes red before any spec is written.
   */
  it('registers NONE of the always-required structural checks', () => {
    const alwaysRequired = [
      'agents-json', 'llms-txt', 'openapi', 'icp-json',
      'machine-legible-home', 'card-interfaces-linked', 'probe-manifest',
      'conneg-accept', 'conneg-client-class', 'conneg-alternates', 'conneg-forced-face',
      'keyless-flow', 'offers-402', 'content-negotiation',
    ]
    for (const id of alwaysRequired) {
      expect(OPTIONAL_DECLARED_INTERFACES[id], `${id} must never be declaration-armed`).toBeUndefined()
    }
  })
})

// ===========================================================================
// 2. THE EVASION GUARD — every one of these must THROW at parse
// ===========================================================================

describe('the evasion guard refuses at PARSE, before any probe fires', () => {
  const throwsNaming = (requirements: unknown[], id: string, match: RegExp) => {
    expect(() => parsePinnedSpec(specText(requirements))).toThrow(match)
    // The message must NAME the offending requirement — a guard that says
    // "something is wrong" costs a spec author an afternoon.
    expect(() => parsePinnedSpec(specText(requirements))).toThrow(new RegExp(id))
  }

  it('REFUSES the card-declaration arm on kind:probe — behavioural probes are categorically un-gatable', () => {
    throwsNaming(
      [{ id: 'gated-probe', kind: 'probe', probe: 'keyless',
         appliesWhen: { cardDeclares: 'interfaces.digitalLink' },
         expect: { status: 200 } }],
      'gated-probe',
      /legal ONLY on kind:'check'/,
    )
  })

  /**
   * THE EVASION TEST. Each of these is an attempt to turn an always-required
   * clause into an opt-out by pointing it at a card key. All must throw.
   */
  it.each([
    'keyless-flow',
    'machine-legible-home',
    'probe-manifest',
    'card-interfaces-linked',
    'agents-json',
    'offers-402',
    'conneg-accept',
  ])('REFUSES to make the always-required check %s conditional on a card key', (check) => {
    throwsNaming(
      [{ id: `gate-${check}`, kind: 'check', check, must: 'pass',
         appliesWhen: { cardDeclares: 'interfaces.digitalLink' } }],
      `gate-${check}`,
      /NOT an api\.qa optional-declared interface/,
    )
  })

  it('the refusal prints the eligible set, so the author is not left guessing', () => {
    expect(() => parsePinnedSpec(specText([
      { id: 'x', kind: 'check', check: 'keyless-flow', must: 'pass',
        appliesWhen: { cardDeclares: 'interfaces.digitalLink' } },
    ]))).toThrow(/"digital-link-resolver"/)
  })

  it('REFUSES gating an eligible check on `probes` — the AXP opt-in signal is not an interface key', () => {
    throwsNaming(
      [{ id: 'cross-probes', kind: 'check', check: 'digital-link-resolver', must: 'pass',
         appliesWhen: { cardDeclares: 'probes' } }],
      'cross-probes',
      /not a legal optional-interface card path/,
    )
  })

  it('REFUSES cross-wiring: arming one optional check with ANOTHER interface key', () => {
    throwsNaming(
      [{ id: 'crosswired', kind: 'check', check: 'digital-link-resolver', must: 'pass',
         appliesWhen: { cardDeclares: 'interfaces.testSuite' } }],
      'crosswired',
      /api\.qa binds that check to "interfaces\.digitalLink"/,
    )
  })

  it.each([
    ['neither arm', {}],
    ['both arms', { fromProbe: 'pricing', path: 'model', equals: 'metered', cardDeclares: 'interfaces.digitalLink' }],
  ])('REFUSES an appliesWhen with %s (shape totality)', (_label, appliesWhen) => {
    throwsNaming(
      [{ id: 'shapeless', kind: 'check', check: 'digital-link-resolver', must: 'pass', appliesWhen }],
      'shapeless',
      /Exactly one arm is legal/,
    )
  })

  it.each([
    ['equals', { cardDeclares: 'interfaces.digitalLink', equals: true }],
    ['path', { cardDeclares: 'interfaces.digitalLink', path: 'x' }],
  ])('REFUSES cardDeclares mixed with `%s` — presence is the whole test', (_label, appliesWhen) => {
    throwsNaming(
      [{ id: 'mixed', kind: 'check', check: 'digital-link-resolver', must: 'pass', appliesWhen }],
      'mixed',
      /tests PRESENCE only/,
    )
  })

  it.each([
    'interfaces.a.b',
    'interfaces',
    'interfaces.0',
    'interfaces.',
    '.digitalLink',
    'Interfaces.digitalLink',
    'interfaces.digitalLink.wellKnown',
    'interfaces[0]',
  ])('REFUSES the malformed card path %s', (cardDeclares) => {
    throwsNaming(
      [{ id: 'badpath', kind: 'check', check: 'digital-link-resolver', must: 'pass',
         appliesWhen: { cardDeclares } }],
      'badpath',
      /not a legal optional-interface card path/,
    )
  })

  it.each([
    ['surface', { id: 'sfc', kind: 'surface', surface: 'agents.json', must: 'valid' }],
    ['ax-floor', { id: 'floor', kind: 'ax-floor', minScore: 8 }],
    ['endpoint', { id: 'ep', kind: 'endpoint', method: 'GET', path: '/api/status', expect: { status: 200 } }],
  ])('REFUSES an appliesWhen on kind:%s, which would silently condition nothing', (_kind, base) => {
    expect(() => parsePinnedSpec(specText([
      { ...base, appliesWhen: { fromProbe: 'pricing', path: 'model', equals: 'metered' } },
    ]))).toThrow(/only kind:'probe' and kind:'check'/)
  })

  it.each([
    ['a non-object', 'nope'],
    ['null', null],
    ['an array', []],
  ])('REFUSES an appliesWhen that is %s', (_label, appliesWhen) => {
    expect(() => parsePinnedSpec(specText([
      { id: 'notobj', kind: 'check', check: 'digital-link-resolver', must: 'pass', appliesWhen },
    ]))).toThrow(/not a JSON object|Exactly one arm/)
  })

  it.each([
    ['fromProbe is not a string', { fromProbe: 7, path: 'model', equals: 'metered' }],
    ['path is missing', { fromProbe: 'pricing', equals: 'metered' }],
    ['equals is missing', { fromProbe: 'pricing', path: 'model' }],
  ])('REFUSES a malformed observed-value arm (%s) instead of degrading it to "unobservable"', (_label, appliesWhen) => {
    expect(() => parsePinnedSpec(specText([
      { id: 'badprobearm', kind: 'check', check: 'offers-402', must: 'pass', appliesWhen },
    ]))).toThrow(/badprobearm/)
  })

  it('the guard runs for a SUITE too — parseSuite is not a side door around it', () => {
    const suite = JSON.stringify({
      $type: 'Suite', name: 's', version: '1',
      environments: { public: { vars: {} } },
      requirements: [
        { id: 'sneaky', kind: 'check', check: 'keyless-flow', must: 'pass',
          appliesWhen: { cardDeclares: 'interfaces.digitalLink' } },
      ],
    })
    expect(() => parseSuite(suite)).toThrow(/NOT an api\.qa optional-declared interface/)
  })

  it('ACCEPTS the one legal shape (the guard is a gate, not a wall)', () => {
    const spec = parsePinnedSpec(DL_SPEC)
    expect(spec.requirements).toHaveLength(1)
  })

  it('ACCEPTS an eligible check pinned WITHOUT appliesWhen — "I demand this of everyone" stays expressible', () => {
    expect(() => parsePinnedSpec(specText([
      { id: 'demanded', kind: 'check', check: 'digital-link-resolver', must: 'pass' },
    ]))).not.toThrow()
  })
})

// ===========================================================================
// 3. readCardDeclaration — the three-way, unit level
// ===========================================================================

describe('readCardDeclaration: absent and unreadable are DIFFERENT, and readPath cannot tell them apart', () => {
  const read = (body: string | null, over: Partial<Evidence> = {}) =>
    readCardDeclaration(cardEvidence({ body, ...over }), 'interfaces.digitalLink')

  it('DECLARED when the key is present with any value at all', () => {
    for (const v of ['{}', 'null', 'false', '0', '""', '[]', '"yes"', '{"wellKnown":"/x"}']) {
      const st = read(`{"interfaces":{"digitalLink":${v}}}`)
      expect(st.state, v).toBe('declared')
    }
  })

  it('ABSENT when a well-formed card omits the key — the only row that earns a skip', () => {
    expect(read('{"interfaces":{"http":{}}}').state).toBe('absent')
  })

  it('ABSENT when a well-formed card has no `interfaces` member at all', () => {
    expect(read('{"name":"x"}').state).toBe('absent')
  })

  it.each([
    ['the card was never fetched', () => readCardDeclaration([], 'interfaces.digitalLink')],
    ['the fetch failed', () => read(null, { status: null, error: 'ECONNREFUSED' })],
    ['the card answered 404', () => read('{}', { status: 404 })],
    ['the body is not JSON', () => read('<html>nope</html>')],
    ['the body is a JSON array', () => read('[]')],
    ['the body is a JSON scalar', () => read('"a card"')],
    ['the body is JSON null', () => read('null')],
    ['an intermediate segment is a string', () => read('{"interfaces":"none"}')],
    ['an intermediate segment is an array', () => read('{"interfaces":[]}')],
    ['an intermediate segment is null', () => read('{"interfaces":null}')],
  ])('UNREADABLE when %s — there is no statement to read', (_label, f) => {
    expect(f().state).toBe('unreadable')
  })

  it('an unreadable state carries a WHY, so the fail-closed line is diagnosable', () => {
    const st = read('{"interfaces":"none"}')
    expect(st.state).toBe('unreadable')
    expect(st.state === 'unreadable' && st.why).toMatch(/not an object/)
  })
})

// ===========================================================================
// 4. THE UNDECLARED-BEHAVIOUR TABLE, end to end through a pinned spec
// ===========================================================================

describe('an UNREADABLE card never buys a free skip (it is an observation failure)', () => {
  it.each([
    ['the card 404s', () => withOverrides(goodTargetRoutes(), {
      'GET /.well-known/agents.json': () => ({ status: 404, contentType: 'application/json', body: '{}' }),
    })],
    ['the card body is not JSON', () => rawCardRoutes(200, 'application/json', '<html>not a card</html>')],
    ['the card body is a JSON array', () => rawCardRoutes(200, 'application/json', '[]')],
    ['the card body is a JSON scalar', () => rawCardRoutes(200, 'application/json', '"a card"')],
    ['`interfaces` is the string "none"', () => rawCardRoutes(200, 'application/json',
      JSON.stringify({ name: 'x', interfaces: 'none' }))],
  ])('APPLIES the requirement and FAILS when %s', async (_label, mk) => {
    const { report, dl } = await run(DL_SPEC, mk())
    expect(dl.verdict).toBe('fail')
    expect(dl.notApplicable).toBeUndefined()
    expect(dl.detail).toMatch(/fail closed/)
    expect(report.passed).toBe(false)
  })

  it('APPLIES and FAILS when the card fetch itself errors', async () => {
    const routes = goodTargetRoutes()
    const inner = makeFetcher(routes)
    const fetcher: Fetcher = async (url, init) => {
      if (new URL(url).pathname === '/.well-known/agents.json') throw new TypeError('fetch failed: network down')
      return inner(url, init)
    }
    const { dl } = await run(DL_SPEC, routes, fetcher)
    expect(dl.verdict).toBe('fail')
    expect(dl.detail).toMatch(/fail closed/)
  })

  it('the fail-closed detail says WHY the card was unreadable, not just that it was', async () => {
    const { dl } = await run(DL_SPEC, rawCardRoutes(200, 'application/json', '[]'))
    expect(dl.detail).toMatch(/JSON array/)
  })
})

describe('an OMITTED key on a readable card is a deliberate statement, and it skips', () => {
  it('passes as NOT APPLICABLE, with a structured marker (no prose-matching required)', async () => {
    const { report, dl, calls } = await run(DL_SPEC, cardRoutes(OMIT))
    expect(dl.verdict).toBe('pass')
    expect(dl.notApplicable).toEqual({ reason: 'not-declared', source: 'interfaces.digitalLink' })
    expect(dl.detail).toMatch(/omission is conformance/)
    expect(report.passed).toBe(true)
    // Nothing was fetched for the undeclared interface — no budget, no probe.
    expect(calls.some((u) => u.includes(GS1_RESOLVER_WELL_KNOWN_PATH))).toBe(false)
  })

  it('an EMPTY `interfaces: {}` is still an omission of THIS key — not applicable', async () => {
    const routes = rawCardRoutes(200, 'application/json', JSON.stringify({ name: 'x', interfaces: {} }))
    const { dl } = await run(DL_SPEC, routes)
    expect(dl.verdict).toBe('pass')
    expect(dl.notApplicable?.reason).toBe('not-declared')
  })

  it('cites the card as its evidence — a not-applicable line must say what it read', async () => {
    const { dl } = await run(DL_SPEC, cardRoutes(OMIT))
    expect(dl.evidence).toContain(ROLE.agentsJson)
  })
})

describe('a PRESENT-BUT-EMPTY declaration is a CLAIM, and the armed check fails it', () => {
  it.each([
    ['null', null],
    ['false', false],
    ['0', 0],
    ['the empty string', ''],
    ['an array', []],
    ['a string', 'yes'],
    ['true', true],
  ])('declaring `interfaces.digitalLink` as %s ARMS the requirement and FAILS it', async (_label, declaration) => {
    const { report, dl } = await run(DL_SPEC, cardRoutes(declaration))
    expect(dl.verdict).toBe('fail')
    expect(dl.notApplicable).toBeUndefined()
    expect(dl.detail).toMatch(/not a JSON object/)
    expect(report.passed).toBe(false)
  })

  it('declaring an EMPTY OBJECT arms it and fetches the RFC 8615 default well-known', async () => {
    const { report, dl, calls } = await run(DL_SPEC, cardRoutes({}))
    expect(calls.some((u) => u.endsWith(GS1_RESOLVER_WELL_KNOWN_PATH))).toBe(true)
    expect(dl.notApplicable).toBeUndefined()
    expect(dl.verdict).toBe('pass')
    expect(report.passed).toBe(true)
  })

  it('declaring an empty object with NO well-known served fails — the claim is checked, not believed', async () => {
    const { dl } = await run(DL_SPEC, cardRoutes({}, NO_WELL_KNOWN))
    expect(dl.verdict).toBe('fail')
    expect(dl.detail).toMatch(/did not answer 2xx/)
  })
})

describe('the escape hatch: an eligible check pinned WITHOUT appliesWhen still demands it of everyone', () => {
  it('a non-declaring card FAILS an ungated digital-link-resolver requirement', async () => {
    const spec = specText([
      { id: 'check-digital-link-resolver', kind: 'check', check: 'digital-link-resolver', must: 'pass' },
    ])
    const { report, dl } = await run(spec, cardRoutes(OMIT))
    expect(dl.verdict).toBe('fail')
    expect(dl.notApplicable).toBeUndefined()
    expect(report.passed).toBe(false)
  })
})

// ===========================================================================
// 5. THE RETROFIT — digital-link-resolver is now PINNABLE
// ===========================================================================

describe('the retrofit: digital-link-resolver as a pinned, declaration-armed requirement', () => {
  it('NON-DECLARING target → passes as not applicable, and nothing about it was verified', async () => {
    const { report, dl } = await run(DL_SPEC, cardRoutes(OMIT))
    expect(report.passed).toBe(true)
    expect(dl.verdict).toBe('pass')
    expect(dl.notApplicable?.reason).toBe('not-declared')
  })

  it('DECLARING target + truthful well-known → a REAL pass, not a laundered skip', async () => {
    const { report, dl } = await run(DL_SPEC, cardRoutes({ wellKnown: GS1_RESOLVER_WELL_KNOWN_PATH }))
    expect(report.passed).toBe(true)
    expect(dl.verdict).toBe('pass')
    // The distinction that makes the mechanism honest: this pass carries NO
    // not-applicable marker, so an agent can tell it apart from the row above.
    expect(dl.notApplicable).toBeUndefined()
    expect(dl.detail).toMatch(/passed/)
  })

  it.each<[string, Routes[string] | typeof NO_WELL_KNOWN]>([
    ['the well-known 404s', NO_WELL_KNOWN],
    ['the well-known is not JSON', () => ({ status: 200, contentType: 'text/html', body: '<html/>' })],
    ['the well-known body does not parse', () => ({ status: 200, contentType: 'application/json', body: '{oops' })],
    ['the description file violates the GS1 schema', json({ resolverRoot: GOOD })],
    ['the description file names another origin', json({ resolverRoot: 'https://elsewhere.example', supportedPrimaryKeys: ['01'] })],
  ])('DECLARING target + %s → FAILS the pinned requirement', async (_label, wellKnown) => {
    const { report, dl } = await run(DL_SPEC, cardRoutes({}, wellKnown))
    expect(dl.verdict).toBe('fail')
    expect(dl.notApplicable).toBeUndefined()
    expect(report.passed).toBe(false)
  })

  it('a card claiming ANOTHER origin\'s resolver fails without the verifier fetching it', async () => {
    const { dl, calls } = await run(DL_SPEC, cardRoutes({ wellKnown: 'https://elsewhere.example/.well-known/gs1resolver' }))
    expect(dl.verdict).toBe('fail')
    expect(dl.detail).toMatch(/NOT the target origin|refused/)
    expect(calls.some((u) => u.startsWith('https://elsewhere.example'))).toBe(false)
  })
})

// ===========================================================================
// 6. THE AXP-SHAPED SPEC, end to end: 21 → 22 requirements
// ===========================================================================

/**
 * The vendored apis-ax-axp@2.2.0 requirement list with the declaration-armed
 * requirement appended — the shape the standard's own ratification will take.
 *
 * This is api.qa proving the mechanism carries a REAL conformance spec, not a
 * toy. It deliberately does NOT edit the vendored spec file: the canonical
 * bytes (and therefore the digest) are the standard's to ratify, and api.qa
 * front-running that would put two different documents in circulation under one
 * version number. api.qa's vendored copy re-syncs after the standard ratifies.
 */
function axpSpecPlusDigitalLink(): string {
  const doc = JSON.parse(readFileSync(AXP_SPEC_PATH, 'utf8')) as { requirements: unknown[] }
  const at = doc.requirements.findIndex((r) => (r as { id: string }).id === 'probe-manifest-valid')
  doc.requirements.splice(at + 1, 0, DL_REQUIREMENT)
  return JSON.stringify(doc)
}

describe('the AXP admission spec with the declaration-armed requirement appended', () => {
  const spec = axpSpecPlusDigitalLink()

  it('is 22 requirements, and parses — the guard does not reject the real spec', () => {
    const parsed = parsePinnedSpec(spec)
    expect(parsed.requirements).toHaveLength(22)
    expect(parsed.requirements.filter((r) => 'appliesWhen' in r && (r as any).appliesWhen?.cardDeclares))
      .toHaveLength(1)
  })

  it('a conformant NON-DECLARING target passes 22/22, with the new requirement not applicable', async () => {
    const report = await verifyPinnedSpec(GOOD, spec, {
      fetcher: urlAwareFetcher(axpReferenceRoutes()), delayMs: 0, seed: 11, mode: 'local',
    })
    const failed = report.requirements.filter((r) => r.verdict !== 'pass')
    expect(failed.map((r) => `${r.id}: ${r.detail}`)).toEqual([])
    expect(report.requirements).toHaveLength(22)
    const dl = report.requirements.find((r) => r.id === 'check-digital-link-resolver')!
    expect(dl.notApplicable).toEqual({ reason: 'not-declared', source: 'interfaces.digitalLink' })
    // NOTHING that was conforming yesterday started failing.
    expect(report.passed).toBe(true)
  })

  it('a conformant DECLARING target that honours the claim passes 22/22, the new one for REAL', async () => {
    const routes = withOverrides(
      axpReferenceRoutes({ model: 'free' }, (card) => { card.interfaces.digitalLink = {} }),
      { [WK_ROUTE]: json(VALID_DESCRIPTION_FILE) },
    )
    const report = await verifyPinnedSpec(GOOD, spec, {
      fetcher: urlAwareFetcher(routes), delayMs: 0, seed: 11, mode: 'local',
    })
    const failed = report.requirements.filter((r) => r.verdict !== 'pass')
    expect(failed.map((r) => `${r.id}: ${r.detail}`)).toEqual([])
    const dl = report.requirements.find((r) => r.id === 'check-digital-link-resolver')!
    expect(dl.notApplicable).toBeUndefined()
  })

  /**
   * SHIP THE FAILING CASE. This is the population whose verdict the retrofit
   * actually changes: a target that DECLARES the optional interface and does
   * not honour it loses admission. If this test is absent, the retrofit is
   * tested only where it cannot fail.
   */
  it('a conformant DECLARING target with a BROKEN well-known FAILS 21/22 — and only on that requirement', async () => {
    const routes = axpReferenceRoutes({ model: 'free' }, (card) => { card.interfaces.digitalLink = {} })
    const report = await verifyPinnedSpec(GOOD, spec, {
      fetcher: urlAwareFetcher(routes), delayMs: 0, seed: 11, mode: 'local',
    })
    const failed = report.requirements.filter((r) => r.verdict !== 'pass')
    expect(failed.map((r) => r.id)).toEqual(['check-digital-link-resolver'])
    expect(report.requirements.filter((r) => r.verdict === 'pass')).toHaveLength(21)
    expect(report.passed).toBe(false)
  })

  it('the untouched 21 behave identically with and without the new requirement (no collateral)', async () => {
    const base = readFileSync(AXP_SPEC_PATH, 'utf8')
    const fetcher = urlAwareFetcher(axpReferenceRoutes())
    const before = await verifyPinnedSpec(GOOD, base, { fetcher, delayMs: 0, seed: 11, mode: 'local' })
    const after = await verifyPinnedSpec(GOOD, spec, { fetcher, delayMs: 0, seed: 11, mode: 'local' })
    const strip = (rs: typeof before.requirements) =>
      rs.filter((r) => r.id !== 'check-digital-link-resolver').map((r) => `${r.id}=${r.verdict}`)
    expect(strip(after.requirements)).toEqual(strip(before.requirements))
  })
})

// ===========================================================================
// 7. REPORTING — a skip must be legible AS a skip
// ===========================================================================

describe('a not-applicable requirement is distinguishable from a pass and from a not-run', () => {
  it('the THREE-WAY holds at the requirement level', async () => {
    const notApplicable = (await run(DL_SPEC, cardRoutes(OMIT))).dl
    const verified = (await run(DL_SPEC, cardRoutes({}))).dl
    const violated = (await run(DL_SPEC, cardRoutes({}, NO_WELL_KNOWN))).dl

    expect([notApplicable.verdict, notApplicable.notApplicable !== undefined]).toEqual(['pass', true])
    expect([verified.verdict, verified.notApplicable !== undefined]).toEqual(['pass', false])
    expect([violated.verdict, violated.notApplicable !== undefined]).toEqual(['fail', false])
  })

  it('a NEVER-PRODUCED check is still a hard fail, never a not-applicable', async () => {
    // `published-test-suite` is REGISTERED as eligible but api.qa does not
    // produce it yet. Against a DECLARING card the requirement must fail
    // loudly — a verifier too old for the spec it was handed says so.
    const spec = specText([
      { id: 'suite-req', kind: 'check', check: 'published-test-suite', must: 'pass',
        appliesWhen: { cardDeclares: 'interfaces.testSuite' } },
    ])
    const base = goodTargetRoutes()
    const card = JSON.parse(base['GET /.well-known/agents.json']!({ method: 'GET', accept: 'application/json' }).body!) as Record<string, any>
    card.interfaces.testSuite = { url: '/suite.json' }
    const report = await verifyPinnedSpec(GOOD, spec, {
      fetcher: makeFetcher(withOverrides(base, { 'GET /.well-known/agents.json': json(card) })),
      delayMs: 0, seed: 7, mode: 'local',
    })
    const r = report.requirements.find((x) => x.id === 'suite-req')!
    expect(r.verdict).toBe('fail')
    expect(r.notApplicable).toBeUndefined()
    expect(r.detail).toMatch(/unknown check/)
  })

  it('the OBSERVED-VALUE arm gets a marker too, and keeps its wording byte-for-byte', async () => {
    const spec = specText([
      { id: 'pricing-declared', kind: 'probe', probe: 'pricing',
        expect: { status: 200, paths: [{ path: 'model', oneOf: ['free', 'metered'] }] } },
      { id: 'gated-offers', kind: 'check', check: 'offers-402', must: 'pass',
        appliesWhen: { fromProbe: 'pricing', path: 'model', equals: 'metered' } },
    ])
    const report = await verifyPinnedSpec(GOOD, spec, {
      fetcher: urlAwareFetcher(axpReferenceRoutes()), delayMs: 0, seed: 3, mode: 'local',
    })
    const gated = report.requirements.find((r) => r.id === 'gated-offers')!
    expect(gated.verdict).toBe('pass')
    expect(gated.notApplicable).toEqual({ reason: 'observed-value', source: 'probes.pricing model' })
    expect(gated.detail).toBe(
      'not applicable: probes.pricing model = "free" (requirement applies only when it equals "metered") — passes as not applicable',
    )
  })

  it('a gated kind:probe carries the observed-value marker as well', async () => {
    const spec = specText([
      { id: 'pricing-declared', kind: 'probe', probe: 'pricing',
        expect: { status: 200, paths: [{ path: 'model', oneOf: ['free', 'metered'] }] } },
      { id: 'ceiling', kind: 'probe', probe: 'overCeiling',
        appliesWhen: { fromProbe: 'pricing', path: 'model', equals: 'metered' },
        expect: { status: [402], paths: [{ path: 'type', equals: 'OFFER' }] } },
    ])
    const report = await verifyPinnedSpec(GOOD, spec, {
      fetcher: urlAwareFetcher(axpReferenceRoutes()), delayMs: 0, seed: 5, mode: 'local',
    })
    expect(report.requirements.find((r) => r.id === 'ceiling')!.notApplicable?.reason).toBe('observed-value')
  })
})

describe('the CI reporters render the third state', () => {
  it('JUnit emits <skipped/> for a not-applicable requirement, and counts it as skipped not passed', async () => {
    const { report } = await run(DL_SPEC, cardRoutes(OMIT))
    const xml = junitXml(report)
    assertWellFormedXml(xml)
    expect(xml).toMatch(/<testcase [^>]*check-digital-link-resolver[^>]*><skipped\/><\/testcase>/)
    expect(xml).toMatch(/skipped="1"/)

    const jr = jsonReport(report)
    expect(jr.totals.skipped).toBe(1)
    expect(jr.totals.passed).toBe(jr.totals.tests - 1)
    expect(jr.suites[0]!.cases.find((c) => c.id === 'check-digital-link-resolver')!.status).toBe('skip')
  })

  it('a REAL pass is still a JUnit pass — the skip mapping keys on the marker, not the check id', async () => {
    const { report } = await run(DL_SPEC, cardRoutes({}))
    const xml = junitXml(report)
    expect(xml).toMatch(/skipped="0"/)
    expect(xml).not.toMatch(/<skipped\/>/)
  })

  it('the JSON report keeps the not-applicable DETAIL, so a skip is not an unexplained blank', async () => {
    const { report } = await run(DL_SPEC, cardRoutes(OMIT))
    const c = jsonReport(report).suites[0]!.cases.find((x) => x.id === 'check-digital-link-resolver')!
    expect(c.detail).toMatch(/omission is conformance/)
  })

  it('the markdown report counts three states and marks the row n/a, not PASS', async () => {
    const { report } = await run(DL_SPEC, cardRoutes(OMIT))
    const md = pinnedMarkdown(report)
    expect(md).toMatch(/0 passed · 1 not applicable · 0 failed/)
    expect(md).toMatch(/\| n\/a \|/)
    expect(md).not.toMatch(/\| PASS \|/)
  })

  it('`PinnedReport.passed` is UNCHANGED by the marker — no free-model target flips to failed', async () => {
    const { report } = await run(DL_SPEC, cardRoutes(OMIT))
    expect(report.passed).toBe(true)
    expect(report.requirements.every((r) => r.verdict === 'pass')).toBe(true)
  })
})
