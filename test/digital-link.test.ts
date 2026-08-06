/**
 * The OPTIONAL, card-DECLARED GS1 Digital Link interface
 * (`interfaces.digitalLink`) and its check, `digital-link-resolver`.
 *
 * Three properties this file exists to hold:
 *
 *   1. **Undeclared is not a failure.** A card that omits the key SKIPs, is
 *      never fetched for, spends no budget, and its grade is untouched. If
 *      this ever regresses, every conforming surface in the estate starts
 *      failing for not implementing something optional.
 *   2. **Declared is judged strictly**, because a machine-readable claim is
 *      one a verifier will believe. Every failing case is here: 404, wrong
 *      content-type, unparseable JSON, schema violation, cross-origin claim,
 *      malformed declaration, a resolverRoot that names someone else, network
 *      failure.
 *   3. **"Validates against GS1's published schema" is a tested property.**
 *      The published bytes are vendored under test/fixtures at a pinned
 *      sha256, and the translated MiniSchema is audited keyword-by-keyword
 *      against them — including the two defects in GS1's own file, which are
 *      reproduced rather than silently tightened.
 *
 * AND AGAINST REALITY: `https://id.org.ai/.well-known/gs1resolver` returns 404
 * (observed 2026-08-06). If id.org.ai declared the interface today it would
 * FAIL this check — which is correct, and is exactly why the interface is
 * optional and undeclared. That is asserted below, not narrated in a comment:
 * deterministically from the recorded 404, and — under APIQA_LIVE_NET=1 —
 * against the live host.
 */

import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { Observer } from '../src/http.js'
import { observeTarget, ROLE, parseAgentsJson } from '../src/discovery.js'
import { runChecks } from '../src/checks.js'
import { axScoreOf, gradeOf } from '../src/grade.js'
import {
  GS1_DESCRIPTION_FILE_SCHEMA,
  GS1_DESCRIPTION_FILE_SCHEMA_SOURCE,
  GS1_PRIMARY_KEY_AIS,
  GS1_RESOLVER_WELL_KNOWN_PATH,
  GS1_SCHEMA_KEYWORDS_NOT_ENFORCED,
  GS1_SCHEMA_MISPLACED_MEMBERS,
  validateGs1DescriptionFile,
} from '../src/gs1-resolver.js'
import type { CheckResult, Evidence, EvidenceBundle } from '../src/types.js'
import { GOOD, goodTargetRoutes, makeFetcher, withOverrides, withoutRoutes, type Routes } from './helpers.js'

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

const WK_ROUTE = `GET ${GS1_RESOLVER_WELL_KNOWN_PATH}`

/** A description file that satisfies the published schema in full. */
const VALID_DOC = {
  resolverRoot: GOOD,
  supportedPrimaryKeys: ['01', '00', '414'],
  name: 'good.example resolver',
  supportedLinkType: [{ namespace: 'https://ref.gs1.org/voc/', prefix: 'gs1:' }],
  linkTypeDefaultCanBeLinkset: false,
  supportedContextValuesEnumerated: ['us', 'ca'],
  contact: { fn: 'good.example ops', hasAddress: { locality: 'Minneapolis', region: 'MN' } },
  jsonLdContextLocation: 'https://ref.gs1.org/voc/data/context.jsonld',
}

const json = (value: unknown, contentType = 'application/json') => () => ({
  status: 200,
  contentType,
  body: JSON.stringify(value),
})

/**
 * goodTargetRoutes with `interfaces.digitalLink` set to `declaration`, plus a
 * well-known route. Pass `declaration: OMIT` to leave the key off entirely —
 * the conforming-but-silent card.
 */
const OMIT = Symbol('omit')

function routesFor(
  declaration: unknown | typeof OMIT,
  wellKnown: Routes[string] | undefined = json(VALID_DOC),
  wellKnownRoute: string = WK_ROUTE,
): Routes {
  const base = goodTargetRoutes()
  const card = JSON.parse(
    base['GET /.well-known/agents.json']!({ method: 'GET', accept: 'application/json' }).body!,
  ) as Record<string, any>
  if (declaration !== OMIT) card.interfaces.digitalLink = declaration
  return withOverrides(base, {
    'GET /.well-known/agents.json': json(card),
    ...(wellKnown ? { [wellKnownRoute]: wellKnown } : {}),
  })
}

async function judge(routes: Routes, origin = GOOD) {
  const calls: string[] = []
  const inner = makeFetcher(routes, origin)
  const observer = new Observer({
    fetcher: async (url, init) => {
      calls.push(url)
      return inner(url, init)
    },
    delayMs: 0,
  })
  const bundle = await observeTarget(origin, observer, 7)
  const checks = runChecks(bundle)
  const { grade } = gradeOf(axScoreOf(checks), checks)
  return { bundle, checks, grade, calls }
}

const dl = (checks: CheckResult[]) => checks.find((c) => c.id === 'digital-link-resolver')!

// ---------------------------------------------------------------------------
// 1. The vendored schema — provenance
// ---------------------------------------------------------------------------

const FIXTURE_PATH = new URL('./fixtures/gs1-description-file-schema.json', import.meta.url)
const FIXTURE_BYTES = readFileSync(FIXTURE_PATH)
const PUBLISHED = JSON.parse(FIXTURE_BYTES.toString('utf8')) as Record<string, any>

describe("GS1's published description-file schema is vendored, not fetched", () => {
  it('the vendored bytes hash to the pinned sha256 — byte provenance, not merely semantic equivalence', () => {
    expect(createHash('sha256').update(FIXTURE_BYTES).digest('hex')).toBe(
      GS1_DESCRIPTION_FILE_SCHEMA_SOURCE.sha256,
    )
    expect(FIXTURE_BYTES.byteLength).toBe(GS1_DESCRIPTION_FILE_SCHEMA_SOURCE.bytes)
  })

  it('the vendored document identifies itself as the pinned draft-07 schema', () => {
    expect(PUBLISHED.$id).toBe(GS1_DESCRIPTION_FILE_SCHEMA_SOURCE.$id)
    expect(PUBLISHED.$schema).toBe(GS1_DESCRIPTION_FILE_SCHEMA_SOURCE.dialect)
    expect(PUBLISHED.required).toEqual(['resolverRoot', 'supportedPrimaryKeys'])
  })

  it('no source file reaches ref.gs1.org at verification time', () => {
    // Determinism (DESIGN.md) and the SSRF gate both forbid it: a verdict may
    // not depend on a third-party document its publisher can edit. The only
    // permitted mention of the host is in prose/provenance, never a fetch.
    for (const file of ['../src/gs1-resolver.ts', '../src/checks.ts', '../src/discovery.ts']) {
      const src = readFileSync(new URL(file, import.meta.url), 'utf8')
      expect(src).not.toMatch(/(fetch|observe)\s*\([^)]*ref\.gs1\.org/)
    }
  })
})

// ---------------------------------------------------------------------------
// 2. The translation is faithful to the published bytes — keyword by keyword
// ---------------------------------------------------------------------------

/**
 * Walk the published draft-07 schema against the MiniSchema translation and
 * report every divergence in BOTH directions: a published constraint the
 * translation drops without an entry in the not-enforced ledger, and a
 * constraint the translation invents that GS1 never wrote.
 */
function auditTranslation(
  published: Record<string, any>,
  mini: Record<string, any> | undefined,
  path: string,
  problems: string[],
): void {
  if (mini === undefined) {
    problems.push(`${path}: published subschema has no counterpart in the translation`)
    return
  }
  for (const [key, value] of Object.entries(published)) {
    const at = `${path}.${key}`
    if (key === 'properties') {
      const miniProps = (mini.properties ?? {}) as Record<string, any>
      for (const [prop, sub] of Object.entries(value as Record<string, any>)) {
        auditTranslation(sub as Record<string, any>, miniProps[prop], `${path}.${prop}`, problems)
      }
      for (const prop of Object.keys(miniProps)) {
        if (!(prop in (value as Record<string, any>))) {
          problems.push(`${path}.${prop}: translation declares a property the published schema does not`)
        }
      }
    } else if (key === 'items') {
      auditTranslation(value as Record<string, any>, mini.items, `${path}[]`, problems)
    } else if (key === 'type' || key === 'required' || key === 'enum' || key === 'pattern') {
      if (JSON.stringify(mini[key]) !== JSON.stringify(value)) {
        problems.push(`${at}: translation has ${JSON.stringify(mini[key])}, published has ${JSON.stringify(value)}`)
      }
    } else if (at in GS1_SCHEMA_MISPLACED_MEMBERS) {
      // Present in the published bytes at a NON-keyword position. GS1's own
      // validator ignores it; so do we, deliberately and on the record.
      if (mini[key] !== undefined) problems.push(`${at}: translation enforces a misplaced member GS1 does not`)
    } else if (key in GS1_SCHEMA_KEYWORDS_NOT_ENFORCED) {
      if (mini[key] !== undefined) problems.push(`${at}: translation enforces a keyword listed as not-enforced`)
    } else {
      problems.push(`${at}: published keyword is neither enforced nor listed in GS1_SCHEMA_KEYWORDS_NOT_ENFORCED`)
    }
  }
  for (const key of Object.keys(mini)) {
    if (key === 'properties' || key === 'items') continue
    if (!(key in published)) {
      problems.push(`${path}.${key}: translation invents a constraint the published schema does not carry`)
    }
  }
}

describe('the MiniSchema translation is faithful to the published bytes', () => {
  it('drops nothing unaccounted-for and invents nothing', () => {
    const problems: string[] = []
    auditTranslation(PUBLISHED, GS1_DESCRIPTION_FILE_SCHEMA as unknown as Record<string, any>, '$', problems)
    expect(problems).toEqual([])
  })

  it('carries the full 21-value supportedPrimaryKeys vocabulary in published order', () => {
    expect([...GS1_PRIMARY_KEY_AIS]).toEqual(PUBLISHED.properties.supportedPrimaryKeys.items.enum)
    expect(GS1_PRIMARY_KEY_AIS).toHaveLength(21)
  })

  it("reproduces GS1's misplaced `contact.hasTelephone` rather than silently tightening it", () => {
    // In the published file hasTelephone sits as a SIBLING of `properties`
    // inside the contact subschema — not a keyword position. GS1's schema
    // therefore does not validate it, and neither may we.
    expect(PUBLISHED.properties.contact.hasTelephone).toBeDefined()
    expect(PUBLISHED.properties.contact.properties.hasTelephone).toBeUndefined()
    expect(Object.keys(GS1_SCHEMA_MISPLACED_MEMBERS)).toContain('$.contact.hasTelephone')
    // …and the practical consequence: a wrong-typed hasTelephone still validates.
    expect(validateGs1DescriptionFile({ ...VALID_DOC, contact: { fn: 'x', hasTelephone: 12345 } })).toEqual([])
  })

  it('permits additional members — the published schema sets no additionalProperties', () => {
    expect(PUBLISHED.additionalProperties).toBeUndefined()
    expect(validateGs1DescriptionFile({ ...VALID_DOC, extensions: { anything: true }, pins: [] })).toEqual([])
  })

  it('accepts a supportedLinkType item with no members — published `items` declares no type and no required', () => {
    expect(PUBLISHED.properties.supportedLinkType.items.type).toBeUndefined()
    expect(PUBLISHED.properties.supportedLinkType.items.required).toBeUndefined()
    expect(validateGs1DescriptionFile({ ...VALID_DOC, supportedLinkType: [{}] })).toEqual([])
  })
})

describe('validateGs1DescriptionFile catches what the published schema actually constrains', () => {
  it('the minimal document — the two required members and nothing else — is valid', () => {
    expect(validateGs1DescriptionFile({ resolverRoot: GOOD, supportedPrimaryKeys: ['01'] })).toEqual([])
  })

  it('a missing required member is reported at its property path', () => {
    const v = validateGs1DescriptionFile({ supportedPrimaryKeys: ['01'] })
    expect(v).toEqual([{ path: '$.resolverRoot', message: 'required property missing' }])
  })

  it('a supportedPrimaryKeys value outside the closed AI vocabulary is reported at its index', () => {
    const v = validateGs1DescriptionFile({ resolverRoot: GOOD, supportedPrimaryKeys: ['01', '99'] })
    expect(v).toHaveLength(1)
    expect(v[0]!.path).toBe('$.supportedPrimaryKeys[1]')
    expect(v[0]!.message).toMatch(/not in enum/)
  })

  it('a CURIE prefix without its colon fails the published pattern', () => {
    const v = validateGs1DescriptionFile({
      ...VALID_DOC,
      supportedLinkType: [{ namespace: 'https://ref.gs1.org/voc/', prefix: 'gs1' }],
    })
    expect(v).toHaveLength(1)
    expect(v[0]!.path).toBe('$.supportedLinkType[0].prefix')
    expect(v[0]!.message).toMatch(/does not match pattern/)
  })

  it('a wrong-typed member is reported with the expected and actual type', () => {
    const v = validateGs1DescriptionFile({ ...VALID_DOC, linkTypeDefaultCanBeLinkset: 'yes' })
    expect(v).toEqual([{ path: '$.linkTypeDefaultCanBeLinkset', message: 'expected boolean, got string' }])
  })

  it('a non-object document fails at the root', () => {
    expect(validateGs1DescriptionFile([VALID_DOC])[0]!.message).toMatch(/expected object, got array/)
  })

  it('draft-07 `format: "uri"` is NOT enforced — a non-URI resolverRoot is schema-valid', () => {
    // Deliberate, and named in GS1_SCHEMA_KEYWORDS_NOT_ENFORCED. The check's
    // separate resolverRoot-origin rule is what actually catches this, and it
    // says so in its own words — see the semantic tests below.
    expect(validateGs1DescriptionFile({ resolverRoot: 'not a url', supportedPrimaryKeys: ['01'] })).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 3. Undeclared is not a failure — the property everything else rests on
// ---------------------------------------------------------------------------

describe('a card that does NOT declare the interface', () => {
  it('SKIPs, is never fetched for, and its grade is untouched', async () => {
    const { checks, calls, grade, bundle } = await judge(routesFor(OMIT, json(VALID_DOC)))
    expect(dl(checks).verdict).toBe('skip')
    expect(dl(checks).detail).toMatch(/OPTIONAL/)
    // The well-known is SERVED here and still never requested: presence on the
    // wire is not the trigger, the card's declaration is.
    expect(calls.some((u) => u.includes('gs1resolver'))).toBe(false)
    expect(bundle.items.some((e) => e.role === ROLE.gs1Resolver)).toBe(false)
    expect(grade).toBe('A+')
    for (const c of checks) expect(c.verdict, `${c.id}: ${c.detail}`).not.toBe('fail')
  })

  it('is unaffected by the well-known being absent altogether', async () => {
    const { checks, grade } = await judge(withoutRoutes(routesFor(OMIT), WK_ROUTE))
    expect(dl(checks).verdict).toBe('skip')
    expect(grade).toBe('A+')
  })

  it('parseAgentsJson leaves digitalLink undefined when the key is absent', () => {
    expect(parseAgentsJson({ interfaces: { http: {} } }, GOOD).digitalLink).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 4. Declared and correct
// ---------------------------------------------------------------------------

describe('a card that declares the interface and serves a valid description file', () => {
  it('PASSes, and the detail names what was and was not verified', async () => {
    const { checks, calls } = await judge(routesFor({}))
    const c = dl(checks)
    expect(c.verdict, c.detail).toBe('pass')
    expect(c.detail).toMatch(/valid against GS1's published description-file schema/)
    expect(c.detail).toMatch(/never fetched at verification time/)
    expect(c.detail).toMatch(/NOT enforced: draft-07 `format: "uri"`/)
    expect(c.detail).toMatch(/NOT covered: RFC 9264 linkset responses/)
    expect(calls.filter((u) => u.includes('gs1resolver'))).toHaveLength(1)
  })

  it('scores no AX point — it is an additive readiness dimension, not one of the ten', async () => {
    const { checks } = await judge(routesFor({}))
    expect(dl(checks).axItem).toBeUndefined()
  })

  it('is independent of the AXP opt-in — the fixture declares no probe manifest and still PASSes', async () => {
    const { checks } = await judge(routesFor({}))
    expect(checks.find((c) => c.id === 'card-interfaces-linked')!.verdict).toBe('skip')
    expect(dl(checks).verdict).toBe('pass')
  })

  it('honours a card-declared same-origin wellKnown at a non-default path', async () => {
    const routes = withoutRoutes(
      routesFor({ wellKnown: '/resolver-description' }, json(VALID_DOC), 'GET /resolver-description'),
      WK_ROUTE,
    )
    const { checks, calls } = await judge(routes)
    expect(dl(checks).verdict, dl(checks).detail).toBe('pass')
    expect(calls.some((u) => u.endsWith('/resolver-description'))).toBe(true)
  })

  it('accepts a matching card-declared resolverRoot', async () => {
    const { checks } = await judge(routesFor({ resolverRoot: `${GOOD}/` }))
    expect(dl(checks).verdict, dl(checks).detail).toBe('pass')
  })
})

// ---------------------------------------------------------------------------
// 5. Declared and wrong — every failing case, which is the point
// ---------------------------------------------------------------------------

describe('declared-but-broken FAILs with an actionable message', () => {
  it('404 at the well-known → fail naming the status', async () => {
    const { checks } = await judge(withoutRoutes(routesFor({}), WK_ROUTE))
    const c = dl(checks)
    expect(c.verdict).toBe('fail')
    expect(c.detail).toMatch(/did not answer 2xx — status 404/)
    expect(c.detail).toContain('/.well-known/gs1resolver')
  })

  it('a non-2xx that is not 404 → fail naming that status', async () => {
    const { checks } = await judge(routesFor({}, () => ({ status: 503, contentType: 'application/json', body: '{}' })))
    expect(dl(checks).detail).toMatch(/status 503/)
  })

  it('unparseable JSON → fail saying the body did not parse', async () => {
    const { checks } = await judge(
      routesFor({}, () => ({ status: 200, contentType: 'application/json', body: '{"resolverRoot": ' })),
    )
    const c = dl(checks)
    expect(c.verdict).toBe('fail')
    expect(c.detail).toMatch(/body did not parse as JSON/)
  })

  it('a non-JSON content-type → fail naming the served type', async () => {
    const { checks } = await judge(
      routesFor({}, () => ({ status: 200, contentType: 'text/html', body: JSON.stringify(VALID_DOC) })),
    )
    const c = dl(checks)
    expect(c.verdict).toBe('fail')
    expect(c.detail).toMatch(/content-type "text\/html"/)
  })

  it('a missing required member → fail naming the schema property that failed', async () => {
    const { checks } = await judge(routesFor({}, json({ supportedPrimaryKeys: ['01'] })))
    const c = dl(checks)
    expect(c.verdict).toBe('fail')
    expect(c.detail).toMatch(/fails GS1's published description-file schema/)
    expect(c.detail).toMatch(/\$\.resolverRoot: required property missing/)
  })

  it('a primary key outside the closed vocabulary → fail naming the offending index', async () => {
    const { checks } = await judge(
      routesFor({}, json({ resolverRoot: GOOD, supportedPrimaryKeys: ['01', 'gtin'] })),
    )
    expect(dl(checks).detail).toMatch(/\$\.supportedPrimaryKeys\[1\]: not in enum/)
  })

  it('a resolverRoot naming another origin → fail (the document was copied from someone else)', async () => {
    const { checks } = await judge(routesFor({}, json({ ...VALID_DOC, resolverRoot: 'https://other.example' })))
    const c = dl(checks)
    expect(c.verdict).toBe('fail')
    expect(c.detail).toMatch(/resolverRoot names origin https:\/\/other\.example but the description file was served from https:\/\/good\.example/)
  })

  it('a resolverRoot that is not a URL at all → fail, and the message says format is unenforced', async () => {
    const { checks } = await judge(routesFor({}, json({ ...VALID_DOC, resolverRoot: 'good.example' })))
    const c = dl(checks)
    expect(c.verdict).toBe('fail')
    expect(c.detail).toMatch(/is not an absolute URL/)
    expect(c.detail).toMatch(/draft-07 leaves unenforced/)
  })

  it('a card resolverRoot that disagrees with the document → fail naming both', async () => {
    const { checks } = await judge(routesFor({ resolverRoot: 'https://elsewhere.example' }))
    const c = dl(checks)
    expect(c.verdict).toBe('fail')
    expect(c.detail).toMatch(/the two claims disagree/)
    expect(c.detail).toContain('https://elsewhere.example')
  })

  it('a network failure at the well-known → fail saying the fetch failed, not that the file is invalid', async () => {
    const base = routesFor({})
    const inner = makeFetcher(base)
    const observer = new Observer({
      fetcher: async (url, init) => {
        if (url.includes('gs1resolver')) throw new TypeError('fetch failed: connection reset')
        return inner(url, init)
      },
      delayMs: 0,
    })
    const checks = runChecks(await observeTarget(GOOD, observer, 7))
    const c = dl(checks)
    expect(c.verdict).toBe('fail')
    expect(c.detail).toMatch(/fetch failed \(/)
    expect(c.detail).toMatch(/connection reset/)
  })
})

describe('a card may not claim another origin\'s resolver', () => {
  it('an absolute off-origin wellKnown → fail, and NOTHING is fetched from that origin', async () => {
    const { checks, calls } = await judge(
      routesFor({ wellKnown: 'https://resolver.evil.example/.well-known/gs1resolver' }),
    )
    const c = dl(checks)
    expect(c.verdict).toBe('fail')
    expect(c.detail).toMatch(/must not claim another origin's resolver/)
    expect(c.detail).toContain('https://resolver.evil.example')
    expect(calls.some((u) => u.includes('evil.example'))).toBe(false)
  })

  it('a private/metadata wellKnown is refused without a byte on the wire', async () => {
    const { checks, calls } = await judge(routesFor({ wellKnown: 'http://169.254.169.254/.well-known/gs1resolver' }))
    expect(dl(checks).verdict).toBe('fail')
    expect(calls.some((u) => u.includes('169.254.169.254'))).toBe(false)
  })

  it('a wellKnown that is not a URL → fail, unfetched', async () => {
    // absolutize() leaves un-parseable junk as-is; the check refuses it by
    // name rather than fetching something it cannot reason about.
    const { checks } = await judge(routesFor({ wellKnown: 'http://' }))
    expect(dl(checks).verdict).toBe('fail')
    expect(dl(checks).detail).toMatch(/does not resolve to a URL|not a publicly-routable/)
  })
})

describe('a present-but-defective declaration is a FAIL, never an absence', () => {
  for (const [label, value, shown] of [
    ['a bare true', true, 'boolean'],
    ['a string', 'https://good.example/', 'string'],
    ['an array', [{ wellKnown: '/x' }], 'array'],
    ['an explicit null', null, 'null'],
  ] as Array<[string, unknown, string]>) {
    it(`${label} → fail, and the message says how to declare nothing instead`, async () => {
      const { checks, calls } = await judge(routesFor(value))
      const c = dl(checks)
      expect(c.verdict).toBe('fail')
      expect(c.detail).toContain(`(got ${shown})`)
      expect(c.detail).toMatch(/OMIT the key entirely/)
      // A shape no verifier can check is not fetched for.
      expect(calls.some((u) => u.includes('gs1resolver'))).toBe(false)
    })
  }
})

// ---------------------------------------------------------------------------
// 6. Against reality — id.org.ai returns 404 today
// ---------------------------------------------------------------------------

const ID_ORG_AI = 'https://id.org.ai'

function bundleWithDeclaredInterface(origin: string, wellKnown: Evidence): EvidenceBundle {
  const card = {
    name: 'id.org.ai',
    interfaces: { http: { root: { method: 'GET', url: `${origin}/` } }, digitalLink: {} },
  }
  return {
    target: origin,
    fetchedAt: '2026-08-06T00:00:00.000Z',
    seed: 1,
    items: [
      {
        role: ROLE.agentsJson,
        url: `${origin}/.well-known/agents.json`,
        method: 'GET',
        status: 200,
        contentType: 'application/json',
        headers: {},
        body: JSON.stringify(card),
        elapsedMs: 1,
      },
      wellKnown,
    ],
  }
}

describe('reality: the estate\'s own resolver would FAIL if it declared the interface', () => {
  it('id.org.ai\'s recorded 404 (2026-08-06) fails a declared Digital Link interface', () => {
    // Recorded verbatim 2026-08-06: HTTP/2 404, content-type application/json,
    // content-length 81, server cloudflare.
    const observed404: Evidence = {
      role: ROLE.gs1Resolver,
      url: `${ID_ORG_AI}${GS1_RESOLVER_WELL_KNOWN_PATH}`,
      method: 'GET',
      status: 404,
      contentType: 'application/json',
      headers: {},
      body: '{"error":"not_found","error_description":"The requested endpoint does not exist"}',
      elapsedMs: 42,
    }
    const c = dl(runChecks(bundleWithDeclaredInterface(ID_ORG_AI, observed404)))
    expect(c.verdict).toBe('fail')
    expect(c.detail).toMatch(/did not answer 2xx — status 404/)
    expect(c.detail).toContain(`${ID_ORG_AI}${GS1_RESOLVER_WELL_KNOWN_PATH}`)
  })

  // Opt-in (APIQA_LIVE_NET=1) because a unit suite must not depend on the
  // internet. One request, read-only. It asserts a CONDITIONAL, not a wish:
  // whatever id.org.ai answers today, the check's verdict must match it — 2xx
  // and schema-valid ⇒ pass, anything else ⇒ fail.
  it('a REAL in-the-wild description file validates — barcoding.dev, served 200 on 2026-08-06', () => {
    // A validator that has only ever seen its own fixtures is a validator
    // nobody has tested. This is the live estate resolver's actual document,
    // vendored verbatim: it carries `extensions`, `conneg`, `delegation` and
    // `pins` (legal — the published schema sets no additionalProperties) and a
    // `profile` member inside supportedLinkType (likewise legal).
    const doc = JSON.parse(readFileSync(new URL('./fixtures/barcoding-dev-gs1resolver.json', import.meta.url), 'utf8'))
    expect(validateGs1DescriptionFile(doc)).toEqual([])
    expect(doc.supportedLinkType[0].profile).toBeDefined()
    expect(doc.extensions).toBeDefined()
  })

  it.skipIf(process.env.APIQA_LIVE_NET !== '1')(
    'LIVE: id.org.ai/.well-known/gs1resolver — the verdict tracks what the host actually answers',
    async () => {
      const observer = new Observer({ delayMs: 0 })
      const ev = await observer.observe(ROLE.gs1Resolver, `${ID_ORG_AI}${GS1_RESOLVER_WELL_KNOWN_PATH}`, {
        accept: 'application/json',
      })
      const c = dl(runChecks(bundleWithDeclaredInterface(ID_ORG_AI, { ...ev, role: ROLE.gs1Resolver })))
      const served = ev.status !== null && ev.status >= 200 && ev.status < 300
      const valid = served && validateGs1DescriptionFile(JSON.parse(ev.body ?? 'null')).length === 0
      expect(c.verdict, `live status=${ev.status} ct=${ev.contentType} detail=${c.detail}`).toBe(
        valid ? 'pass' : 'fail',
      )
      // Recorded 2026-08-06: 404. If this ever stops being a fail, the
      // resolver shipped — and the interface may then be declared.
      if (!served) expect(c.detail).toMatch(/did not answer 2xx/)
    },
    20_000,
  )

  it.skipIf(process.env.APIQA_LIVE_NET !== '1')(
    'LIVE: barcoding.dev/.well-known/gs1resolver still validates against the pinned schema',
    async () => {
      const observer = new Observer({ delayMs: 0 })
      const ev = await observer.observe(ROLE.gs1Resolver, `https://barcoding.dev${GS1_RESOLVER_WELL_KNOWN_PATH}`, {
        accept: 'application/json',
      })
      expect(ev.status, `live status=${ev.status}`).toBe(200)
      expect(validateGs1DescriptionFile(JSON.parse(ev.body ?? 'null'))).toEqual([])
    },
    20_000,
  )
})
