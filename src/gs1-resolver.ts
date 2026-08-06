/**
 * GS1 Digital Link resolver description file — the constraint api.qa judges a
 * DECLARED Digital Link interface against.
 *
 * WHAT GS1 SAYS (https://ref.gs1.org/standards/resolver/): a GS1-Conformant
 * Resolver SHALL make a Resolver Description File available at
 * `/.well-known/gs1resolver` (RFC 8615), and "the presence or absence of this
 * file can be used to determine whether or not the URI points to a service
 * conformant to this standard". The file validates against a published JSON
 * Schema whose required members are exactly `resolverRoot` and
 * `supportedPrimaryKeys`.
 *
 * WHY THE SCHEMA IS NOT FETCHED AT VERIFICATION TIME. Two hard constraints
 * forbid it, and neither is negotiable:
 *
 *   1. A verdict is a pure function of (published contracts, observed
 *      behavior, pinned spec digest, seed, verifier version) — DESIGN.md. A
 *      third-party document that its publisher may edit at any moment is a
 *      sixth input nobody controls, and a replayed bundle would re-judge
 *      differently. That is the one property api.qa cannot trade away.
 *   2. `Observer.observe` refuses off-origin fetches by construction (SSRF).
 *      A verification run reaches the target's origin and nowhere else.
 *
 * So the published bytes are VENDORED and DIGEST-PINNED (see
 * GS1_DESCRIPTION_FILE_SCHEMA_SOURCE and test/fixtures/), and the constraint
 * this file actually evaluates is the hand-written `MiniSchema` translation
 * below. `test/digital-link.test.ts` walks the vendored bytes keyword by
 * keyword and fails if the translation drifts from them, or if this file
 * invents a constraint GS1 did not write — so "validated against GS1's
 * published schema" is a tested property, not an adjective.
 *
 * WHAT WE DELIBERATELY DO NOT ENFORCE, and why it is said out loud:
 *
 *   - `format: "uri"`. In draft-07 `format` is an ANNOTATION by default. A
 *     validator that rejects a non-URI `resolverRoot` on `format` grounds is
 *     STRICTER than the schema requires. api.qa does not enforce it here, and
 *     the check's detail string says so. (The resolver-root ORIGIN rule the
 *     check applies is a separate, explicitly-named semantic rule — not a
 *     smuggled `format` enforcement.)
 *   - `default: false` on `linkTypeDefaultCanBeLinkset`. An annotation; it
 *     never constrains an instance.
 *   - `contact.hasTelephone`. In GS1's published file this member sits as a
 *     SIBLING of `properties` inside the `contact` subschema, which is not a
 *     JSON Schema keyword position. GS1's own schema therefore does not
 *     validate `contact.hasTelephone`, and neither do we. Reproducing the
 *     published behaviour is the honest choice; inventing a stricter rule and
 *     calling it "the GS1 schema" would be a machine-readable false claim.
 *   - `additionalProperties` is ABSENT from the published schema, so extra
 *     members are permitted. A description file carrying vendor extensions
 *     validates. We do not close the object.
 *
 * Nothing here reads axp.org.ai. The wire is the input: a card that declares
 * the interface, and a document served at the well-known.
 */

import { validateSchema } from './schema.js'
import type { MiniSchema } from './types.js'
import type { SchemaViolation } from './schema.js'

/**
 * RFC 8615 well-known path the GS1 resolver standard fixes for the
 * description file. Origin-relative; the target's own origin is prepended.
 */
export const GS1_RESOLVER_WELL_KNOWN_PATH = '/.well-known/gs1resolver'

/**
 * Provenance of the vendored schema. `sha256` is over the bytes ref.gs1.org
 * ACTUALLY SERVED on `fetchedAt` — not over a reformatted copy — so the pin
 * proves byte-provenance and not merely semantic equivalence.
 * `test/fixtures/gs1-description-file-schema.json` holds those bytes and
 * `test/digital-link.test.ts` re-hashes them on every run.
 */
export const GS1_DESCRIPTION_FILE_SCHEMA_SOURCE = {
  url: 'https://ref.gs1.org/standards/resolver/description-file-schema',
  /** The `$id` inside the served document — the unversioned URL pins to 1.2.0. */
  $id: 'https://ref.gs1.org/standards/resolver/1.2.0/description-file-schema',
  dialect: 'http://json-schema.org/draft-07/schema#',
  sha256: '99d505c7aa2004cde3277651e8db0e019eab61d2746b2631ddab3fec8a13617e',
  bytes: 3593,
  fetchedAt: '2026-08-06',
} as const

/**
 * The closed `supportedPrimaryKeys` vocabulary, verbatim from the published
 * schema's `items.enum` (21 values, `"all"` first). Order preserved so the
 * faithfulness audit can compare it element-for-element.
 */
export const GS1_PRIMARY_KEY_AIS = [
  'all', '01', '8006', '8013', '8010', '410', '411', '412', '413', '414',
  '415', '417', '8017', '8018', '255', '00', '253', '401', '402', '8003', '8004',
] as const

/**
 * The published draft-07 schema, translated into the dependency-free
 * `MiniSchema` this repo already validates with. FAITHFUL, not stricter:
 * every constraint here exists in the published bytes, and every published
 * constraint that is not here is listed in GS1_SCHEMA_KEYWORDS_NOT_ENFORCED
 * with a reason.
 */
export const GS1_DESCRIPTION_FILE_SCHEMA: MiniSchema = {
  type: 'object',
  required: ['resolverRoot', 'supportedPrimaryKeys'],
  properties: {
    resolverRoot: { type: 'string' },
    supportedPrimaryKeys: {
      type: 'array',
      items: { type: 'string', enum: [...GS1_PRIMARY_KEY_AIS] },
    },
    name: { type: 'string' },
    supportedLinkType: {
      type: 'array',
      // GS1's `items` declares NO `type` and NO `required` — an empty object,
      // and indeed a non-object, validates. Reproduced deliberately: adding
      // `type: 'object'` here would fail documents GS1's own schema accepts.
      items: {
        properties: {
          namespace: { type: 'string' },
          prefix: { type: 'string', pattern: '^[a-zA-Z_][A-Za-z0-9_-]*?:$' },
        },
      },
    },
    linkTypeDefaultCanBeLinkset: { type: 'boolean' },
    supportedContextValuesEnumerated: { type: 'array', items: { type: 'string' } },
    supportedContextValuesExternal: {
      type: 'array',
      items: {
        type: 'object',
        properties: { nameOfList: { type: 'string' }, url: { type: 'string' } },
      },
    },
    contact: {
      type: 'object',
      properties: {
        fn: { type: 'string' },
        hasAddress: {
          type: 'object',
          properties: {
            streetAddress: { type: 'string' },
            locality: { type: 'string' },
            region: { type: 'string' },
            'postal-code': { type: 'string' },
          },
        },
      },
    },
    extensionProfile: { type: 'string' },
    jsonLdContextLocation: { type: 'string' },
  },
}

/**
 * Draft-07 keywords the translation above CARRIES. The faithfulness audit
 * requires every one of these, wherever it appears in the published bytes, to
 * survive into `GS1_DESCRIPTION_FILE_SCHEMA` unchanged.
 */
export const GS1_SCHEMA_KEYWORDS_ENFORCED = ['type', 'properties', 'required', 'items', 'enum', 'pattern'] as const

/**
 * Members of the published bytes the translation deliberately DROPS, each
 * with the reason. The audit fails if the published schema grows a keyword
 * that is neither enforced nor listed here — i.e. silent under-enforcement is
 * a test failure, not a shrug.
 */
export const GS1_SCHEMA_KEYWORDS_NOT_ENFORCED: Record<string, string> = {
  $schema: 'dialect declaration — metadata, constrains no instance',
  $id: 'schema identity — metadata, constrains no instance',
  description: 'annotation',
  decription:
    "GS1's own typo for `description` (contact.hasAddress.postal-code) — an annotation under either spelling",
  format:
    'draft-07 `format` is an ANNOTATION by default; enforcing it would make api.qa stricter than the schema it cites. The check says so in its detail rather than being silently stricter.',
  default: 'draft-07 `default` is an annotation; it never constrains an instance',
}

/**
 * Members that appear in the published bytes at a position where they are NOT
 * a JSON Schema keyword, keyed by the schema path they sit at. GS1's own
 * validator ignores them; so do we, and we name them so nobody mistakes the
 * omission for an oversight.
 */
export const GS1_SCHEMA_MISPLACED_MEMBERS: Record<string, string> = {
  '$.contact.hasTelephone':
    "sits as a SIBLING of `properties` inside the `contact` subschema in GS1's published file — not a JSON Schema keyword position. GS1's schema does not validate contact.hasTelephone; reproducing that is honest, tightening it silently would not be.",
}

/**
 * Validate a parsed description file against the translated schema. Pure and
 * total: any JSON value in, a (possibly empty) violation list out. Never
 * throws, never fetches.
 */
export function validateGs1DescriptionFile(doc: unknown): SchemaViolation[] {
  return validateSchema(doc, GS1_DESCRIPTION_FILE_SCHEMA)
}

/**
 * Render violations as one actionable clause naming the failing property
 * paths — `$.resolverRoot: required property missing` — capped so a badly
 * broken document cannot flood a detail string.
 */
export function renderGs1Violations(violations: SchemaViolation[], max = 4): string {
  const shown = violations.slice(0, max).map((v) => `${v.path}: ${v.message}`)
  const extra = violations.length > max ? ` (+${violations.length - max} more)` : ''
  return shown.join('; ') + extra
}

/**
 * Origin of an ABSOLUTE URL string, or `undefined` when it does not parse.
 * Distinct from checks.ts's local `originOf`, which returns the input string
 * on a parse failure — here the difference between "no origin" and "some
 * origin" is exactly what the cross-origin rule turns on, so it must be
 * unambiguous.
 */
export function urlOriginOrUndefined(url: string): string | undefined {
  try {
    return new URL(url).origin
  } catch {
    return undefined
  }
}
