/**
 * The OPTIONAL-DECLARED-INTERFACE registry — api.qa's own evasion guard.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 *
 * `appliesWhen` has two arms (see types.ts). The `cardDeclares` arm lets a
 * pinned requirement be SKIPPED when the target's capability card does not
 * declare a named optional interface. That is exactly the shape of an EVASION
 * MECHANISM: if any requirement could be gated on a card key, then every MUST
 * clause reachable that way stops being a MUST — a target opts out of it by
 * simply not writing the key.
 *
 * So the arm is not general. It is legal only for checks that appear in the
 * frozen map below, and only when bound to the exact card path this map pairs
 * with the check. Everything else THROWS at spec-parse time, before a single
 * probe fires (see `validateRequirements` in pinned.ts).
 *
 * ── Why the map is keyed by CHECK ID, and why it lives in api.qa ────────────
 *
 * A requirement `id` is a string the SPEC AUTHOR chooses; a `check` id is a
 * string API.QA owns and an author cannot mint. The document under attack is
 * the spec, so eligibility must be anchored in something the spec cannot
 * declare into existence. A flag on the requirement (`optional: true`) would be
 * a guard whose value is set by the party being guarded — no guard at all.
 *
 * And it lives HERE, in the verifier, never imported from the standard. api.qa
 * must be able to fail the standard's own authors; a registry generated from
 * `PROTOCOL.md` would make the verifier a mirror of the document it audits. The
 * standard carries its own structural mirror of this list in its own repo, and
 * the two agree by REVIEW and by two independent tests — never by a shared
 * module. If you are about to generate one from the other, stop.
 *
 * ── What belongs in this map ────────────────────────────────────────────────
 *
 * ONLY ADDITIVE CAPABILITIES: a check that verifies something a surface MAY
 * offer, whose absence is fully conforming. Never a check any always-required
 * clause binds. Adding an entry is a deliberate source change in this file, it
 * gets a code review, and — if the check is one a MUST clause binds — it turns
 * the standard's independent disjointness test red the moment the two lists are
 * compared. Two tripwires, no shared import.
 *
 * ── The asymmetry that makes the skip legitimate ────────────────────────────
 *
 * The `fromProbe` arm fails CLOSED on a missing source because a missing probe
 * response is an OBSERVATION FAILURE: the verifier asked and did not get an
 * answer, so it cannot tell "does not apply to me" from "I am broken" or "I am
 * evading". Absence of evidence is not evidence.
 *
 * The `cardDeclares` arm skips on absence because there THE CARD IS THE ANSWER.
 * A card that was fetched, parsed, and found well-formed, and that omits the
 * key, has affirmatively said "I do not offer this". Absence IN a retrieved
 * document is a datum; absence OF the document is not — which is why every case
 * where the card itself could not be read collapses back to the fail-closed
 * posture (see `readCardDeclaration` in pinned.ts).
 */

/**
 * The CLOSED registry of ADDITIVE, DECLARATION-ARMED capabilities.
 *
 * `checkId -> the ONE \`interfaces.<key>\` card path that arms it.`
 *
 * A check in this map MAY be pinned with `appliesWhen: { cardDeclares: … }`.
 * A check NOT in this map can NEVER be made conditional on a card key — which
 * is what makes it structurally impossible to opt out of an always-required
 * clause by omission.
 *
 * Note the direction of the guarantee: this map restricts what may be SKIPPED,
 * never what may be REQUIRED. An allowlisted check pinned WITHOUT `appliesWhen`
 * is legal and means "I demand this of everyone"; its `skip` then fails closed
 * under `must: 'pass'` exactly as any other skip does. That is the escape hatch,
 * and it needs no new machinery.
 */
export const OPTIONAL_DECLARED_INTERFACES: Readonly<Record<string, string>> = Object.freeze({
  /**
   * GS1 Digital Link resolver discovery indicator. Implemented (checks.ts).
   * The card key is the whole arming signal — NOT `axpClaimed`: an optional
   * interface is armed by its own declaration, not by the AXP opt-in.
   */
  'digital-link-resolver': 'interfaces.digitalLink',
  /**
   * A card-published, digest-pinned api.qa Suite the target asserts about
   * itself.
   *
   * ⚠ ELIGIBLE BUT NOT YET IMPLEMENTED. `runChecks` does not produce a
   * `published-test-suite` check today — it lands in a later, separate change.
   * The row is here because eligibility and admission are different things and
   * this is the standing demonstration of that: the registry says what MAY be
   * declaration-armed, the ratified spec says what IS pinned, and nothing pins
   * this. A spec that pins it anyway does not get a lenient verdict: against a
   * DECLARING card the requirement fails loudly with `unknown check
   * "published-test-suite"`, which is the correct direction of failure for a
   * verifier that is too old for the spec it was handed.
   */
  'published-test-suite': 'interfaces.testSuite',
})

/**
 * The card-path grammar: EXACTLY two dot-separated segments, the first
 * literally `interfaces`, the second a lowerCamelCase-shaped member name. No
 * array indices, no deeper nesting, no other container.
 *
 * Deliberately redundant with the registry binding rule — it holds even if the
 * registry above is later mis-edited, and it is the rule the standard states in
 * prose, so an implementer reading only this file gets the same answer.
 */
export const OPTIONAL_INTERFACE_PATH_RE = /^interfaces\.[A-Za-z][A-Za-z0-9]*$/

/** Human-readable list of every eligible check id, for a thrown message. */
export function eligibleOptionalChecks(): string[] {
  return Object.keys(OPTIONAL_DECLARED_INTERFACES).sort()
}
