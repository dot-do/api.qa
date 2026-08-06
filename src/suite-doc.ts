/**
 * The SUITE / PINNED-SPEC DOCUMENT LAYER — pure parsing and validation of a
 * requirement list, with no dependency on the Observer, the network, or the
 * judge.
 *
 * WHY IT IS SEPARATE. `parseSuite` and `validateRequirements` began in
 * `pinned.ts`, whose only consumers were `verifyPinnedSpec` / `verifySuite`.
 * They now have two more: the OBSERVE side (`discovery.ts`, which runs a
 * card-declared suite) and the JUDGE side (`checks.ts`, which re-derives that
 * run from the bundle). Both of those modules are imported BY `pinned.ts`, so
 * importing it back would close a cycle. Extracting the pure document layer
 * breaks the cycle without forking a single validation rule — a card-declared
 * suite is held to the IDENTICAL id-uniqueness, derived-role-collision,
 * colon-in-id and non-vacuity guards a ratified PinnedSpec is.
 *
 * `pinned.ts` re-exports both functions, so its public API is unchanged.
 */

import type { PinnedRequirement, Suite } from './types.js'


/**
 * Validate an ordered requirement list — the id-uniqueness, derived-role-key
 * collision-freeness, and colon-in-id guards. Extracted so BOTH a PinnedSpec
 * and a reusable Suite (which is a PinnedSpec parameterized by an environment)
 * run the SAME checks over the SAME requirement shape — the suite format does
 * not fork the requirement contract, it reuses it.
 */
export function validateRequirements(requirements: PinnedRequirement[]): void {
  const doc = { requirements }
  // VACUOUS-PASS GUARD. `passed: results.every(r => r.verdict === 'pass')` is
  // `true` for an EMPTY array — an all() over nothing is vacuously true. A
  // PinnedSpec (or Suite) with zero requirements would therefore ALWAYS report
  // `passed: true` regardless of what the target does, including a totally
  // broken worker: `expect(anyWorker).toConform({spec: emptySpec})` would pass
  // every time. That is the exact class of silent-faked-success this verifier
  // exists to catch, so refuse it categorically, LOUDLY, at parse — before any
  // probe fires — rather than let an empty spec verify nothing while looking
  // like a green report.
  if (doc.requirements.length === 0) {
    throw new Error(
      'a PinnedSpec with no requirements verifies nothing; refusing to vacuously pass. ' +
        'Add at least one requirement (or delete this spec/suite rather than pin an empty one).',
    )
  }
  // Every requirement id MUST be a UNIQUE, NON-EMPTY STRING. The role key
  // (`pinned:<id>`) is what observe records evidence under and what the judge
  // looks up by `find(role === 'pinned:<id>')` (FIRST match). A PinnedSpec is
  // EXTERNAL JSON parsed at runtime, so the `id: string` TS type is a
  // compile-time fiction: a runtime id can be a number, boolean, null, missing,
  // or the empty string. Any of those, or a duplicate, would let two
  // requirements share one role — observe records under it by loop POSITION,
  // the judge resolves BOTH to the first match — a self-contradictory report
  // that re-opens the observe/judge divergence. Two numeric `1`s collapse to
  // `pinned:1`; two missing ids to `pinned:undefined`. So reject any id that is
  // not a unique non-empty string LOUDLY at parse, naming the offender — never
  // `continue`-skip it. (Numeric `1` and string `"1"` both become the same
  // role, so rejecting every non-string id also stops that cross-type
  // collision.)
  const seen = new Set<string>()
  for (const req of doc.requirements) {
    const id = (req as { id?: unknown }).id
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error(
        `invalid requirement id ${JSON.stringify(id)} in PinnedSpec — every requirement id must be ` +
          'a unique NON-EMPTY STRING. This spec is external JSON: a numeric/boolean/null/missing/empty ' +
          'id collapses to a shared role (pinned:<id>), making observe and the judge resolve different ' +
          'requirements — refusing to verify something incoherent',
      )
    }
    if (seen.has(id)) {
      throw new Error(
        `duplicate requirement id "${id}" in PinnedSpec — requirement ids must be unique ` +
          '(observe indexes evidence by position, the judge by id; a repeat makes them disagree)',
      )
    }
    seen.add(id)
  }

  // DERIVED-ROLE COLLISION GUARD. Raw-id uniqueness (above) is NOT enough: the
  // role key a requirement records/is-judged under is DERIVED, not the raw id,
  // and it is NON-INJECTIVE ACROSS KINDS:
  //   endpoint id X → the single role key  `pinned:X`              (observe/judge
  //                   both use `pinned:${id}`)
  //   probe    id Y → the role-key NAMESPACE `pinned:Y:<i>` (one per manifest
  //                   entry i), modeled here as the PREFIX `pinned:Y:`
  //   surface / ax-floor / check → record NO `pinned:` role at all, so they can
  //                   never collide on a derived role key.
  // So endpoint "x:0" derives `pinned:x:0`, which is ALSO probe "x"'s entry-0
  // role: both raw ids are distinct strings, the dup guard accepts the spec,
  // then the judge's find(role === 'pinned:x:0') resolves BOTH requirements to
  // the FIRST-recorded item — a probe judged against an endpoint's body (a
  // false-FAIL, or a vacuous false-PASS: a conformance requirement that never
  // judges the thing it names). Reject at parse if any two requirements' derived
  // role keys can collide — an endpoint's point key falling inside a probe's
  // namespace, or one probe namespace nested inside another.
  const reservations: RoleReservation[] = []
  for (const req of doc.requirements) {
    const kind = (req as { kind?: unknown }).kind
    const id = (req as { id: string }).id
    if (kind === 'endpoint') reservations.push({ id, kind: 'endpoint', point: `pinned:${id}` })
    else if (kind === 'probe') reservations.push({ id, kind: 'probe', prefix: `pinned:${id}:` })
  }
  for (let i = 0; i < reservations.length; i++) {
    for (let j = i + 1; j < reservations.length; j++) {
      const a = reservations[i]!
      const b = reservations[j]!
      const shared = roleKeysCollide(a, b)
      if (shared !== undefined) {
        throw new Error(
          `derived role-key collision in PinnedSpec: requirement "${a.id}" (${a.kind}) and ` +
            `requirement "${b.id}" (${b.kind}) both derive role key(s) under "${shared}". The role ` +
            'key is DERIVED (endpoint → pinned:<id>, probe → pinned:<id>:<i>), not the raw id, so ' +
            'two distinct raw ids can still share a role and make observe and the judge resolve ' +
            'different requirements — refusing to verify something incoherent',
        )
      }
    }
  }

  // Belt-and-suspenders: ':' is the role-key separator (`pinned:<id>[:<i>]`), so
  // a colon INSIDE a raw id is the only way a derived role key can ever be
  // ambiguous. The collision guard above already rejects the concrete colliding
  // cases; this closes the whole class categorically — including ids like "a:b"
  // that happen to collide with nothing yet still muddy role parsing.
  for (const req of doc.requirements) {
    const id = (req as { id: string }).id
    if (id.includes(':')) {
      throw new Error(
        `requirement id "${id}" in PinnedSpec contains the ':' role-key separator — a requirement ` +
          'id must not contain ":" (the derived role key is pinned:<id>[:<i>]; a colon in the raw ' +
          'id makes that key ambiguous). Rename the requirement.',
      )
    }
  }
}

/**
 * One requirement's reservation in the DERIVED role-key space. An `endpoint`
 * reserves a single POINT (`pinned:<id>`); a `probe` reserves a whole NAMESPACE
 * (`pinned:<id>:<i>` for every manifest entry i), modeled as the PREFIX
 * `pinned:<id>:`.
 */
interface RoleReservation {
  id: string
  kind: 'endpoint' | 'probe'
  point?: string
  prefix?: string
}

/**
 * Return the shared role key (a descriptive string) if two reservations' derived
 * role-key spaces intersect, else undefined. A point falls inside a namespace
 * when it starts with the namespace prefix; two namespaces collide when one
 * prefix is a prefix of the other (nested). Two points can only match on an
 * identical raw id, which the dup guard already rejects.
 */
function roleKeysCollide(a: RoleReservation, b: RoleReservation): string | undefined {
  if (a.point !== undefined && b.point !== undefined) {
    return a.point === b.point ? a.point : undefined
  }
  if (a.point !== undefined && b.prefix !== undefined) {
    return a.point.startsWith(b.prefix) ? a.point : undefined
  }
  if (b.point !== undefined && a.prefix !== undefined) {
    return b.point.startsWith(a.prefix) ? b.point : undefined
  }
  if (a.prefix !== undefined && b.prefix !== undefined) {
    if (a.prefix.startsWith(b.prefix)) return `${a.prefix}<i>`
    if (b.prefix.startsWith(a.prefix)) return `${b.prefix}<i>`
  }
  return undefined
}


/**
 * Parse + validate a reusable Suite. Reuses `validateRequirements` (the SAME
 * id-uniqueness / derived-role-collision / colon guards a PinnedSpec runs) so
 * the suite format does not fork the requirement contract. Additionally checks
 * the `environments` map shape: each entry must be `{ vars: { ... } }`.
 */
export function parseSuite(text: string): Suite {
  const doc = JSON.parse(text) as Suite
  if (doc.$type !== 'Suite' || !Array.isArray(doc.requirements)) {
    throw new Error('not a Suite: expected {"$type":"Suite","environments":{...},"requirements":[...]}')
  }
  const envs = doc.environments as unknown
  if (envs === null || typeof envs !== 'object' || Array.isArray(envs)) {
    throw new Error('Suite.environments must be an object mapping env name -> { vars: { <k>: <v> } }')
  }
  for (const [name, env] of Object.entries(envs as Record<string, unknown>)) {
    const vars = (env as { vars?: unknown } | null)?.vars
    if (env === null || typeof env !== 'object' || Array.isArray(env) ||
        vars === null || typeof vars !== 'object' || Array.isArray(vars)) {
      throw new Error(`Suite environment "${name}" must be an object of the form { "vars": { <k>: <v> } }`)
    }
  }
  validateRequirements(doc.requirements)
  return doc
}
