# PRODUCT.md — api.qa

UI/UX design context. Companion to the root `DESIGN.md`, which is the
architecture and threat-model document and is **not** about interface design.

> **Status: strawman.** Everything here is derived from artifacts already in the
> repo — `src/self.ts` (`icp.json` agent classes), `src/copy.ts` (ruled copy
> constants), root `DESIGN.md`, `README.md` — plus the July 2026 UI audit.
> Nothing was invented from a prompt. Lines marked **[ASSUMED]** are inferences
> that need a human ruling; everything else is sourced.

---

## Register

**Split, by surface.** This is not a single-register product and treating it as
one is how the current UI got two unrelated rhythms.

| Surface | Register | Why |
|---|---|---|
| `/` landing | **brand** | Design *is* the product. It has to make an argument to a skeptical reader before they trust anything. |
| `/{domain}`, `/self` report | **product** | Design *serves* the artifact. The verdict is the product; the page is the frame around it. |
| Monitors, series, offers (unbuilt) | **product** | Operational surfaces. |

The report page is also a **document people file and cite** — closer to a lab
report or an SSL Labs grade than to an app screen. It has a print stylesheet for
exactly this reason. Treat "does this survive being printed, screenshotted, and
pasted into a procurement thread" as a design constraint, not an edge case.

---

## Users

Taken verbatim from `src/self.ts:154` `selfIcpJson()`, which is the product's own
shipped self-classification. These are the four classes, in the product's words:

1. **builder** — "You just built or changed an API and need to know it works."
   Reads a grade, fixes the FAILs, re-runs. **The FAIL list is a punch list, not
   a judgment** — this is the emotional core of the report page. A builder
   arriving at a D grade needs to leave with a to-do list, not a verdict.

2. **fleet-orchestrator** — "You run a hill-climbing loop and need an acceptance
   gate the workers cannot edit." Cares about `passed: true` and a digest.
   Mostly reads JSON, not HTML — but when they do open a page, it is to prove
   something to a human.

3. **evaluator** — "You are deciding whether to integrate with a third-party
   API." Scanning someone *else's* grade. Needs to reach a go/no-go fast, and
   needs the evidence to be checkable, not just asserted.

4. **procurement** — "You settle 402 offers on behalf of a principal." Hits a
   boundary, needs a structured offer. Today `/offers/attested-run` answers them
   with raw JSON and a 402 status.

**A fifth, unlisted, and currently the most neglected: the skeptic.** Someone
sent them an api.qa link and they are looking for a reason not to believe it.
Most of the Tier 1 audit findings are things this reader finds in ninety seconds.
Design for them explicitly. **[ASSUMED — but strongly implied by the whole
threat-model posture of root DESIGN.md.]**

### Not for

Also verbatim from `icp.json` — this is real anti-scope, use it:
- load testing or fuzzing a target
- penetration testing or auth bypass
- "verifying targets you intend to game — the evidence bundle is public"

---

## The one-sentence product

The external, third-party verifier for agent-first APIs: it grades a domain from
that domain's own published contracts, deterministically, and signs the verdict
so the evidence is portable.

**The villain** (ruled, `copy.ts:27`): the human-first web — surfaces built for
eyes, gated by signups, that lie to machines.

**The core invariant** (root `DESIGN.md`): a verdict is a pure function of five
inputs, none of which the graded party can write.

---

## Voice and tone

### Ruled constants — do not edit without amending `copy.ts`

`src/copy.ts:7` declares these **"RULED VERBATIM — do not paraphrase, soften, or
'improve'"**: `TAGLINE`, `AXP_ANCHOR`, `JUDGED`, `ADMISSION`, `VILLAIN`.

**Known conflict, unresolved:** the house style forbids em dashes; three ruled
constants contain them. `copy.ts`'s verbatim contract and the em-dash rule cannot
both hold. **This needs an owner ruling before any copy pass.** The options are
(a) amend `copy.ts`'s contract and rewrite the constants, (b) exempt ruled
constants from the em-dash rule and fix only the 16 unruled occurrences, or
(c) keep all 19. Do not resolve this silently.

### The register the product earns

Technical, exact, unhedged. This product's entire claim is that it does not
flatter anyone, so the copy must not flatter either.

- **Binary, not graded.** `ADMISSION` is "passed: true at a ratified digest, or
  nothing." Never soften a boundary into a hedge.
- **State mechanisms, not benefits.** "The pin lives with the orchestrator, not
  the workers' repos" beats "enterprise-grade security."
- **Name the attack.** Every mechanism in root `DESIGN.md` exists because of a
  specific named attack. Copy that habit: say what someone would try, then say
  why it fails.
- **Admit residuals.** Root `DESIGN.md` has a "What the design does *not* claim"
  section and marks seams honestly. That candor is a brand asset. Keep it.

### Discipline the current copy lacks

The audit found the page states its four core ideas **three to five times each**,
including a near-verbatim restatement of the invariant band's load-bearing
sentence in a smaller font two sections later. Repetition reads as insecurity —
precisely wrong for a product whose posture is "check it yourself."

**Say each thing once, in the strongest available position.**

---

## Anti-references

What this must not look like:

1. **The SaaS landing template.** Hero metric + three icon cards + gradient
   accent + testimonial row. Nothing about this product is generic and the page
   should not be reachable by that grammar.
2. **A dashboard.** Monitors and series pages are coming, and the reflex will be
   dark-blue-and-sparklines observability chrome. The report page is a
   *credential*, not a telemetry view; the series page should feel like the same
   document family.
3. **A test runner.** Green checks and red Xs in a CI list. The output here is a
   graded document with a signature, not a build log.
4. **A trust badge farm.** Seals and shields used decoratively. This product has
   exactly one seal and it means something specific.
5. **Its own marketing.** The hero currently shows a hand-typed A+ credential on
   a page that says "never self-graded" four times. Never fake the artifact.

### The category reflex to avoid

First-order: "developer tool → dark terminal aesthetic." Second-order: "developer
tool that isn't a dark terminal → editorial-typographic serif." The current
answer is neither, and it is better than both: **light "lab paper" as the
default**, with the one load-bearing sentence set on a fixed dark plate that does
not theme. Keep that. It reads as a scientific instrument rather than as a
product, which is exactly the claim.

---

## Strategic principles

1. **Never fake the artifact.** Any credential shown anywhere is either real,
   built from a committed fixture of a real run, or visibly labelled as an
   example. This is the one rule that cannot be traded away.

2. **The page must pass its own checklist.** api.qa grades other APIs on content
   negotiation, keyless first value, and honest surfaces. Every one of those is
   currently a defect on api.qa's own routes. **Any UI change that would fail
   api.qa's own AX checklist is disqualified.**

3. **Both registers, always.** Every surface answers agents (markdown/JSON) and
   humans (HTML) correctly. A designed page that only serves browsers is
   half-built; 19 of 22 routes currently only serve agents.

4. **Keyless first value is a design constraint.** No gate, no modal, no
   "sign up to see the full report." The free path never 401s or 402s.

5. **Evidence is reachable from every claim.** If the page asserts something, the
   thing that proves it is one click or one visible command away.

6. **Light is the default; dark is a real second theme.** Not an afterthought —
   the audit found the worst contrast failure in the product is dark-only.
   **[ASSUMED: that light stays the default. Most reviewers see dark first
   because their OS is dark, so there is a real argument for inverting. Needs a
   ruling.]**

7. **A grade must survive leaving the browser.** Printed, screenshotted, pasted.
   Today it does not — the print path can produce a near-blank sheet.

8. **Degrade to nothing, never to broken.** No mobile menu is worse than no nav
   links. An unstyled 404 is worse than a plain one.

---

## Success criteria

A skeptical evaluator lands on `api.qa/{some-domain}` from a link, and within
about a minute can: read the grade, understand what it is derived from, find one
thing that would change it, and verify the verdict without trusting us.

A builder lands on their own D and leaves with a punch list they believe.

Neither of them finds anything on the page that contradicts the page.
