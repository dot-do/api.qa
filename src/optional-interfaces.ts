/**
 * The CLOSED registry of ADDITIVE, DECLARATION-ARMED capabilities.
 *
 * `checkId -> the ONE `interfaces.<key>` card path that arms it.`
 *
 * A check in this map is one that verifies a capability a surface MAY offer.
 * A check NOT in this map can never be made conditional on a card key — which
 * is what makes it structurally impossible to opt out of AXP Clauses 1-7 by
 * omission. Adding an entry here is a deliberate api.qa source change, and it
 * immediately turns the axp.org.ai disjointness test red if the check is one
 * a MUST clause binds. Two independent tripwires, no shared import.
 *
 * ⚠ THE ASYMMETRY THIS REGISTRY DEFENDS. An optionality mechanism is an EVASION
 * mechanism if misapplied: if a requirement can be skipped by not declaring
 * something, then any MUST clause reachable that way stops being a MUST. The
 * registry is the answer — it says which requirements are ELIGIBLE to be
 * declaration-armed, and it is owned by the VERIFIER, not by the spec document
 * under scrutiny. A spec author chooses requirement ids; they cannot mint a
 * check id, because a check id only exists if `runChecks` produces it. That is
 * why the key here is the CHECK and not the requirement.
 *
 * ELIGIBILITY IS NOT ADMISSION. A row here means a ratified spec MAY gate this
 * check on that card key. It does not mean any spec does. `published-test-suite`
 * is deliberately the standing example: registered as eligible, pinned by
 * nothing.
 *
 * ⚠ INDEPENDENCE. This constant is api.qa's own. The standard keeps its own
 * `axp:optional-interfaces` block in PROTOCOL.md Appendix A.8. The two agree by
 * review and by two independent tests — NEVER by one importing the other.
 * api.qa importing axp.org.ai is the one thing this repo pair forbids.
 */
export const OPTIONAL_DECLARED_INTERFACES: Readonly<Record<string, string>> = Object.freeze({
  'digital-link-resolver': 'interfaces.digitalLink',
  'published-test-suite': 'interfaces.testSuite',
})

/**
 * The grammar an optional-interface card path must match: exactly two segments,
 * the first literally `interfaces`, no array indices. Deliberately redundant
 * with the registry's own values so it still holds if the map is mis-edited.
 */
export const OPTIONAL_INTERFACE_PATH = /^interfaces\.[A-Za-z][A-Za-z0-9]*$/
