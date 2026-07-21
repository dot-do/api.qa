/**
 * Copy constants — the verbatim narrative assets of the agent-first
 * StoryBrand arc (bead ax-78n). Centralized so the HTML register (views.ts)
 * and the agent register (self.ts: llms.txt + minimal HTML) render the same
 * ruled formulas and can never drift apart.
 *
 * These strings are RULED VERBATIM — do not paraphrase, soften, or "improve":
 * - TAGLINE: capital X in eXperience, always. Never 'Agent Experience'.
 * - AXP_ANCHOR: every first protocol mention on a register uses the full
 *   anchored form, never a bare 'AXP', never the long name alone.
 * - JUDGED / ADMISSION: the guide-authority and binary-admission formulas.
 */

/** The canonical thesis, verbatim wherever the thesis is stated. */
export const TAGLINE = 'AX = Agent eXperience — what UX and DX were for humans, AX is for agents.'

/** First-mention protocol anchor. Subsequent mentions on the same register may say AXP. */
export const AXP_ANCHOR = 'AXP — the Agent eXperience Protocol (https://apis.ax/axp)'

/** Guide-authority formula: api.qa is the independent verifier. */
export const JUDGED = 'judged by api.qa, never self-graded'

/** Binary admission language. Never softened into a marketing hedge. */
export const ADMISSION = 'passed: true at a ratified digest, or nothing'

/** The villain: the human-first web. Shared across all properties. */
export const VILLAIN =
  'the human-first web — surfaces built for eyes, gated by signups, that lie to machines (walls of HTML, faked 200s, prices discovered after the bill)'
