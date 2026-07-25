# api.qa in the Default Provider Program — certification vs. routing

**Status: PROPOSED — operator-ratified direction, pending GC ratification.**
Tracker: `ax-96a` (protocol-side counterpart: `ax-29v`).
Nothing in this note is a commitment to offer, sell, or certify anything; it
propagates structural decisions so that design work does not build the wrong
seams. Sources:

- `~/projects/law/docs/brief/FRANCHISE-COMPLIANCE-BRIEF.md` — the Option C
  recommendation and the certification-mark constraints (15 U.S.C. § 1054,
  § 1064(5)).
- `~/projects/explore.startups.studio/docs/brainstorms/2026-07-25-franchise-matrix/SEED.md`
  — the business model (default-provider slots across the portfolio matrix).

## The ruling being propagated (proposed, pending GC)

**Certification and commerce must be separated.**

1. **Certification layer (open, neutral).** AX Protocol certification becomes
   an open program targeting a registered **certification mark** held by a
   **separate standards entity**. Per § 1064(5), the certifier may not use the
   mark on its own offerings (clause B) and may not discriminatorily refuse
   certification to anyone who maintains the standard (clause D). **No fee,
   royalty, or commercial term may be embedded in the certification layer or
   in the protocol spec.**
2. **Routing/procurement layer (commercial, exclusive).** Exclusivity and
   economics live in default-slot assignment: the studio is merchant of record
   for every slot brand; operators are white-label suppliers **paid**
   rev-share (money flows studio → operator, never operator → studio — that
   inversion is what keeps the program outside the franchise and
   business-opportunity definitions).
3. **api.qa's continuous graded conformance feeds slot enforcement as an SLA
   input** — grade ≥ threshold keeps the slot; below threshold → remediation
   → reassignment. But the grade itself is neutral, published, and available
   to anyone.

## 1. What this means for api.qa's product surface

Almost nothing changes — the existing design is already the right shape. The
value line in the README (free AEO grade, keyless, no signup; paid functional
testing + monitoring) survives intact. What the ruling adds is a *role
boundary*:

- **api.qa is the measurement instrument, not the certifier.** api.qa produces
  attested, replayable, deterministic grades (DESIGN.md core invariant). It
  does not grant, hold, or license any certification mark. "AX Certified"
  status — if GC approves the certification-mark route — is granted by the
  standards entity, *using* api.qa grades as evidence, under the entity's
  published objective criteria.
- **The free grade stays open to all — structurally, not as a policy
  choice.** § 1064(5)(D) makes non-discriminatory access a condition of the
  mark's validity. A gated or member-only grade would poison the certification
  layer it feeds. The free path (`curl https://api.qa/<domain>`) therefore
  keeps its no-401/no-402 guarantee, and *anyone* — slot holders, would-be
  slot holders, competitors, third parties — gets the same verifier, the same
  checks, the same published grade page.
- **The grade API becomes the neutral input other systems consume.** The slot
  enforcement machinery (studio procurement), the standards entity
  (certification decisions), and any third party (due diligence) all consume
  the *same* attested reports. api.qa serves evidence; consumers apply
  policy. No consumer's policy — including the studio's slot thresholds —
  leaks back into the verifier's judgment. This is the same held-out
  discipline the Goodhart threat model already mandates (DESIGN.md: the fleet
  being graded cannot write the test; now also: the *buyer* of the grade
  cannot write the test).
- **No commercial terms in the grading layer.** api.qa's paid tier prices
  *assurance work* (functional testing, monitoring, CI webhooks) — it never
  prices the grade, the certification, or the slot. A higher grade is not
  purchasable; a slot is not sold here; certification carries no api.qa fee
  embedded in it. Whatever the standards entity charges (if anything) and
  whatever the routing layer's rev-share terms are, neither appears in
  api.qa's product surface or pricing.

## 2. Grade-attestation interface for the routing layer (design sketch)

The slot-enforcement system needs to *subscribe* to grades rather than poll
grade pages. Proposed shape — **sketch only, not implementation**; the
existing Ed25519 attestation core is reused unchanged, so a webhook event is
just a delivery envelope around the already-attested report digest.

### Event kinds

| Event | Emitted when | Slot-enforcement meaning (consumer-side) |
|---|---|---|
| `grade.published` | Any attested run completes for a subscribed domain | Fresh evidence; update the SLA window |
| `grade.regressed` | Attested grade drops below the *previous attested* grade | Candidate SLA breach — consumer applies its own threshold/cure policy |
| `grade.restored` | Attested grade returns to/above the prior level | Cure evidence |
| `grade.stale` | No fresh attested run within the subscription's declared freshness window | Evidence expired — a T0 report may not represent T1 state (DESIGN.md attack 10) |

Note what is *absent*: there is no `slot.revoked`, no `threshold.breached`
with a studio-defined threshold baked in. api.qa reports facts about grades;
"below threshold → remediation → reassignment" is the routing layer's
contract logic, expressed in the *supplier agreement*, evaluated by the
*consumer* against neutral events. The threshold number never enters api.qa.

### Event payload (sketch)

```jsonc
{
  "event": "grade.regressed",
  "subject": "db4.ai",                       // the graded domain
  "report": {
    "grade": "B",                            // letter grade
    "axScore": 7,                            // 10-point AX score
    "previousGrade": "A",
    "evidenceDigest": "sha256:…",            // digest of the embedded evidence bundle
    "verifierVersion": "…",
    "seed": "…",                             // replay seed (per-run, recorded)
    "attestedAt": "2026-07-25T…Z",
    "reportUrl": "https://api.qa/db4.ai",    // the same public page everyone sees
    "signature": "ed25519:…"                 // over the canonical report digest
  }
}
```

Consumer verification is the existing public path: check the signature,
`rejudge` the embedded evidence, confirm the grade reproduces. A webhook
event a consumer cannot re-derive from the public report is a bug — the
subscription is a *convenience* over published data, never privileged data.
That property is what keeps the interface neutral: the studio's slot
enforcer receives nothing a competitor could not fetch.

### Delivery + subscription (sketch)

- **Pull:** `GET /v1/reports/<domain>` (attested report history, paginated) —
  public, keyless, same freshness semantics as the grade page.
- **Push:** webhook subscription (domain list + endpoint + freshness window).
  Subscriptions are a paid *monitoring* feature (scheduled recurring runs are
  what cost money — consistent with the existing paid-tier line), but the
  *content* delivered is identical to the public record.
- **Freshness is the consumer's demand:** the subscription declares the
  window; `grade.stale` fires when it lapses. Slot SLAs that require
  continuous conformance are implemented as "monitoring subscription + stale
  = breach of the *supplier agreement's* evidence clause," not as api.qa
  policy.

## 3. The self-dealing constraint (named openly)

**The tension:** api.qa itself occupies the QA slot in the matrix. The
verifier that produces the grades is also a graded provider in the very
program the grades enforce. Left unstructured, that is exactly the
§ 1064(5)(B) self-use bar (a certifier marketing services the mark certifies)
plus an obvious neutrality objection ("the referee plays for the house
team").

**The proposed answer (pending GC):**

- The **certification mark is held by the separate standards entity**, which
  operates nothing it certifies. api.qa does not hold the mark, does not
  grant certification, and never applies the mark to its own offerings.
- **api.qa competes as a graded provider like anyone else.** Its grade is
  produced by the same public checks, published on the same public surface,
  and — critically — is already *self-referentially verifiable*: the
  SELF-TEST discipline (api.qa grades itself through its own published
  contracts) plus attested replayability means any third party can re-run the
  judge over the evidence and confirm api.qa's own grade without trusting
  api.qa. Determinism is the neutrality mechanism; governance (repo/key held
  by the studio, outside any build fleet — DESIGN.md attack 8) is the
  backstop.
- **The QA slot is subject to the same SLA consumption as every other slot.**
  If a conforming third-party verifier existed and api.qa's grade fell below
  the slot threshold, the routing layer's remediation/reassignment mechanics
  apply to api.qa identically. The slot is not definitionally api.qa's.
- Residual honestly stated: while api.qa is the *only* AXP verifier, "anyone
  can be graded" is true but "anyone can grade" is not. The standards
  entity's criteria should contemplate additional accredited verifiers so
  the measurement role itself is not a permanent house monopoly. Open
  question for the operator below.

## 4. Naming and mark-usage rules (pre-GC discipline)

Until GC ratifies the structure, api.qa's public surface and copy must not
pre-empt the legal design:

- **Do not use** "AX Certified," "certified," "certification," or any
  mark-like badge language for grades. A grade is a *measurement* ("api.qa
  grade: A · AX score 9/10"), never a certification. No badge artwork that
  implies a mark.
- **Do not use** "franchise" anywhere on the public surface; the program name
  is **"Default Provider Program"** (per the compliance brief § 4 — the word
  is both a legal conclusion and, in registration states, an advertisement of
  one).
- **No fee, royalty, territory, or slot-pricing language** on any api.qa
  page, and no earnings/routed-demand-volume claims. (This extends the
  existing house pre-launch rule: no example-pricing language buyer-visible.)
- **Descriptive statements are fine:** "db4.ai holds the database slot in the
  studio's default stack, graded continuously by api.qa" describes
  procurement facts. "Buy the slot" / "become certified" do not appear.
- The § 1054/§ 1064(5) constraints are *design inputs now* even though no
  mark is registered yet: build nothing that assumes api.qa grants
  certification, gates the grade, or bundles commercial terms with
  conformance — reversing any of those later would be a product break, not a
  copy edit.

## 5. Open questions (for the operator / GC)

1. **Accredited-verifier posture:** does the standards entity's charter
   contemplate additional AXP verifiers beyond api.qa (breaking the
   "referee = house" residual fully), or is single-verifier + attested
   replayability the accepted answer for v1?
2. **Threshold placement:** confirm the slot threshold/cure windows live
   exclusively in supplier agreements (routing layer) and never in api.qa
   config — including that api.qa should refuse feature requests like
   "notify only below B" that would smuggle a specific threshold into the
   neutral event stream. (Consumer-side filtering is fine.)
3. **Webhook tier:** is charging for monitoring subscriptions consistent
   with "no commercial terms in the certification layer" when the standards
   entity itself is a subscriber? (Proposed answer: yes — the fee prices
   recurring verification work, not the grade — but GC should bless it.)
4. **Event vocabulary:** does slot enforcement need a
   remediation-acknowledgment event (operator says "fixing it") flowing
   *through* api.qa, or does remediation state live entirely in the routing
   layer? (Proposed: entirely routing-layer; api.qa stays facts-only.)
5. **Freshness floor:** what is the minimum re-verification cadence a slot
   SLA may demand before probe budget/cooldown limits (DESIGN.md attack 9)
   become the binding constraint?

## Cross-references

- `DESIGN.md` — threat model; core invariant; attacks 8 (verifier
  governance), 9 (probe budget), 10 (time-shift / freshness).
- `SELF-TEST.md` — the self-referential grading discipline §3 relies on.
- `README.md` — the free/paid value line this note preserves.
- ax repo: `docs/design/2026-07-25-default-provider-program-governance.md` —
  the protocol-side counterpart (spec stays commercial-term-free; standards
  entity; metering/receipt and lifecycle-hook sketches).
