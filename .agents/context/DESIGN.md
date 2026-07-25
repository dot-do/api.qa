# DESIGN.md — api.qa UI design system

The interface design system. **Not** the root `DESIGN.md`, which is the
architecture and threat-model document and is a different artifact entirely.

Generated from the code as it stands (July 2026) plus the UI audit. Where the
code and good practice disagree, both are recorded: **Current** is what ships
today, **Target** is the proposed ruling. Nothing here has been applied yet, so
this file is a baseline, not a description of a finished system.

---

## 0. Constraints that shape everything

- **No React, no Tailwind, no CSS files, no build step for styles.** All CSS is a
  template literal in `src/views.ts`, emitted inline in a `<style>` block.
- **No JavaScript ships.** `shell()` (`views.ts:198`) accepts an optional
  `script` and no caller passes one. Any design that needs JS is a new capability
  decision, not a styling choice.
- **Hard payload budget.** The landing page is 33,132 bytes, of which 14,915 is
  CSS. This is a live verifier whose value is being unbluffably correct; bundle
  weight is a product concern.
- **CSP-clean and self-contained.** No external hosts, no webfont links
  (`views.ts:188`). See §2 for the consequence.
- **Purity boundary.** Presentation lives in `views.ts` / `render.ts` only, never
  in the judge. Same report in, same HTML out.

---

## 1. Color

OKLCH throughout. Light "lab paper" is `:root`; dark rides
`prefers-color-scheme` (`views.ts:44`, `:75`). 29 tokens, 26 overridden in dark.

### Strategy

**Restrained**, correctly. Tinted neutrals plus one accent used sparingly, with
verdict colors carrying the only saturated moments. This is right for a product
register and should not be pushed louder.

Every neutral is tinted toward the brand hue (chroma 0.004–0.024). No `#000` or
`#fff` anywhere. Keep both properties.

### Core tokens

| Token | Light | Dark | Role |
|---|---|---|---|
| `--background` | `oklch(0.988 0.006 175)` | `oklch(0.165 0.021 220)` | page |
| `--foreground` | `oklch(0.205 0.021 210)` | `oklch(0.935 0.012 185)` | body text |
| `--card` | `oklch(0.998 0.004 175)` | `oklch(0.202 0.024 220)` | every raised surface (12 uses) |
| `--muted` | `oklch(0.958 0.010 185)` | `oklch(0.235 0.024 218)` | chips, ghost hover |
| `--muted-foreground` | `oklch(0.470 0.020 200)` | `oklch(0.660 0.022 195)` | secondary prose (26 uses) |
| `--border` | `oklch(0.905 0.013 190)` | `oklch(0.290 0.022 218)` | **29 uses — most-used token** |
| `--primary` | `oklch(0.560 0.118 185)` | `oklch(0.735 0.130 178)` | brand teal, 17 uses |
| `--accent` | `oklch(0.700 0.110 205)` | `oklch(0.760 0.110 205)` | 1 use |
| `--code-bg` / `--code-fg` | `0.190 0.024 220` / `0.910 0.014 190` | `0.135 0.020 222` / `0.900 0.016 190` | the fixed dark plate |

### Verdict tokens

| Token | Light | Dark |
|---|---|---|
| `--pass` | `oklch(0.560 0.140 158)` | `oklch(0.720 0.150 158)` |
| `--pass-soft` | `oklch(0.945 0.045 158)` | `oklch(0.290 0.055 158)` |
| `--fail` | `oklch(0.560 0.198 27)` | `oklch(0.680 0.190 27)` |
| `--fail-soft` | `oklch(0.950 0.045 27)` | `oklch(0.300 0.070 27)` |
| `--warn` | `oklch(0.580 0.140 70)` | `oklch(0.770 0.150 75)` |
| `--skip` | `oklch(0.640 0.018 200)` | `oklch(0.600 0.020 200)` |

`--warn` is the only token whose **hue shifts between themes** (70 → 75).
Unintentional; harmonize.

### The fixed dark plate

`pre.code` and `.invariant` are `--code-bg` in **both** themes, deliberately
(`views.ts:364`): the one sentence the product hangs on reads as engraved, not
themed. **Keep this.** It is the strongest single color decision in the system.

Its accent, `oklch(0.78 0.13 175)`, is currently a **literal repeated three
times** (`views.ts:179`, `:368`, `:370`). Target: promote to a theme-invariant
token, `--on-code-accent`.

### Rulings needed

- **Contrast.** `--primary` and `--pass` both sit at lightness 0.560 and produce
  six AA failures in light mode (3.74–4.23:1 against a 4.5 requirement).
  **Target: drop both to ~0.52.** One change, six fixes.
- **`.track .tag` is 1.35:1 in dark** — effectively invisible. It paints
  `--accent-foreground` (near-black in dark) on a translucent accent
  (`views.ts:400`). Correct in light, inverts wrongly in dark. This is a bug, not
  a tuning question.
- **`--ring` is byte-identical to `--primary`** in both themes. It survives on
  cards only because `outline-offset:2px` clears it. Target: give `--ring` an
  independent value with guaranteed contrast against `--card`, `--background`,
  **and** `--primary`.
- **Dead tokens**: `--card-foreground` (≡ `--foreground`) and `--input` (there are
  no form elements anywhere). Remove or use.

### The grade ramp — currently not a ramp

`GRADE_COLOR`, `views.ts:581`:

| Grade | Current | L / C / H | Contrast on card (light) |
|---|---|---|---|
| A+ | `--pass` | 0.560 / 0.140 / 158 | 4.28 |
| A | `--pass` | 0.560 / 0.140 / 158 | 4.28 |
| B | `--primary` | 0.560 / 0.118 / 185 | 4.23 |
| C | `--warn` | 0.580 / 0.140 / 70 | 4.37 |
| D | `oklch(0.64 0.17 45)` **literal** | 0.640 / 0.170 / 45 | **3.57** |
| F | `--fail` | 0.560 / 0.198 / 27 | 5.11 |

Four defects: A+ and A are byte-identical; A→B moves *away* from red and loses
chroma, so a downgrade reads as a brand shift; B→C snaps 115° in one jump (3.4×
the average perceptual step); D is the only hard-coded literal on a themed
surface, does not flip with the theme, and has the worst contrast in **both**
modes.

**Target:** a dedicated 6-step `--grade-{aplus,a,b,c,d,f}` token set, monotonic
in hue from green to red, monotonic in chroma, roughly even in OKLab ΔE, with
every step meeting 4.5:1 on `--card` in both themes. A+ and A must differ.

---

## 2. Typography

### Families

```
--font-sans: 'Inter', system-ui, -apple-system, BlinkMacSystemFont,
             'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif
--font-mono: ui-monospace, 'JetBrains Mono', 'SF Mono', 'Cascadia Code',
             Menlo, Consolas, monospace
```

**Known tension:** the stack names Inter first, but no webfont ships by design
(CSP-clean, `views.ts:188`). Inter resolves only for people who happen to have it
installed; everyone else gets `system-ui`. Every letter-spacing value in the file
(`-0.011em` body, `-0.03em` headings, `-.05em` seal) is tuned for Inter's metrics
and applied to a font that is usually not Inter.

**Ruling needed:** either self-host Inter as a subset woff2 (costs bytes, keeps
CSP clean), or drop Inter from the stack and retune tracking for `system-ui`.
Do not leave it as-is.

### Scale

**Current: 29 distinct sizes; only 3 of 28 adjacent steps clear 1.25.** Eighteen
values live between .68rem and 1.22rem — a 1.79× span with a geometric mean step
of **1.033**. Real collisions include `.92/.93/.94rem` on three components
(0.16px apart) and `1.05/1.06rem` (0.16px apart).

Body copy has **no anchor**: `body` never sets a font-size, and the dominant
prose size is `.9rem`. So `.lede` at 1.075rem is only 1.17× actual body — and it
is set in `--muted-foreground`, i.e. *lower contrast* than the body it
introduces. It does not read as a lede.

**Target — a 7-step scale, 1.25 ratio, anchored at 1rem body:**

| Step | Size | Use |
|---|---|---|
| `--text-xs` | 0.75rem | eyebrows, chips, table headers, mono facts |
| `--text-sm` | 0.875rem | secondary prose, captions, ledger detail |
| `--text-base` | 1rem | **body — set it on `body`** |
| `--text-lg` | 1.25rem | lede, card headings |
| `--text-xl` | 1.5rem | section subheads |
| `--text-2xl` | 2rem | section h2 |
| `--text-3xl` | clamp to ~3.5rem | hero h1, grade seals |

Display sizes (`.bigseal` 4rem, `.gradeseal` 2.9rem, `.rep-score` 2.6rem) stay
bespoke; they are objects, not text.

### Measure

**There is no `--measure` token and the report page has no measure at all.**
`.wrap` is a 72rem layout container, not a text width. Uncapped prose on the page
people read most carefully: `.note` ≈148ch, `.rep-sec .sub` ≈150ch, `.chk p`
≈148ch — all roughly double the cap.

Elsewhere there are six uncoordinated ad-hoc caps: 22 / 34 / 42 / 44 / 46 / 52rem.

**Target:** `--measure: 68ch` for body prose, `--measure-tight: 52ch` for display.
Apply to every prose block. Express in `ch`, not `rem`.

### Rules that stay

`text-wrap:balance` on headings, `font-variant-numeric: tabular-nums` globally
(correct for a product full of digests and scores), `-webkit-font-smoothing:
antialiased`.

---

## 3. Spacing and rhythm

**Current: 50 distinct rem values; 36 of 50 (72%) fall off a 0.25rem grid.** Card
padding alone uses 14 different values. `table.ax th` is `.7rem` and `td` is
`.72rem` in the same table — 0.32px apart.

**Target — a 4px base scale**, and nothing off it:

```
--space-1: .25rem   --space-2: .5rem    --space-3: .75rem   --space-4: 1rem
--space-5: 1.5rem   --space-6: 2rem     --space-7: 3rem     --space-8: 4rem
--space-9: 5.5rem
```

Card padding collapses to three tiers: **compact** `--space-3 --space-4`
(ledger rows, table cells), **default** `--space-5` (cards, tracks, tiers),
**feature** `--space-6 --space-7` (hero cards, final CTA).

The horizontal-greater-than-vertical padding instinct is right and should be
kept, but as **one** ratio, not the current seven different deltas.

### Section rhythm — the comment is wrong

`views.ts:155` says "deliberately uneven." Because padding does not collapse, the
alternating `.section` (5.5rem) / `.section-tight` (3.5rem) produces **exactly
9.0rem between five consecutive section boundaries.** The variation is real
inside each block and invisible between them, which is where a reader perceives
rhythm.

Meanwhile the report page uses neither class — `.rep-sec` is a flat 2.4rem
throughout, giving a uniform 4.8rem gutter, roughly half the landing page's.
**Two pages, two unrelated rhythms.**

**Target:** define rhythm as the *gap between* sections, not the padding within.
Vary it deliberately — tighter where sections are continuous, wider at a change
of subject. Unify the two pages onto one system.

### Radius

`--radius: 0.7rem`, with derived steps at `-.15rem`, `+.1rem`, `+.3rem`,
`+.4rem`. Plus `99px` pills (9 uses) and `50%` circles.

**Defect:** inline code chips use `4px` (`views.ts:410`), `5px`
(`views.ts:648`), `4px` (`render.ts:158`), and `8px` (`self.ts:334`) — four radii
for one visual role across three renderers. Target: one `--radius-chip`.

### Elevation

`--shadow-sm` / `--shadow-md` / `--shadow-lg`, all tinted (`oklch(0.30 0.02 210)`
light, near-black dark).

**Defect:** the landing page elevates every framed surface; the report page's
three main surfaces (`.checks`, `table.ax`, `.attest`) are all flat. Only the two
hero cards agree. The pages read as two elevation systems sharing a token set.
Target: one ruling — flat frames with hairline borders, or elevated cards — and
apply it to both.

---

## 4. Components

### The surface base that does not exist

Ten components independently re-declare `background: var(--card)` +
`border: 1px solid var(--border)` + a radius + a shadow, across 4 radii and 4
shadow levels: `.announce`, `.cred`, `.feat`, `.checklist`, `.track`, `.tier`,
`.cta-final`, `.rep-card`, `table.ax`, `.checks`, `.attest`.

**Target:** one `.surface` base with `.surface--raised` / `.surface--flat`
modifiers.

### The chip family that does not exist

Five variants of one idea, no shared base: `.pill` (verdict), `.badge`
(metadata), `.track .tag` (audience label), `.announce b` (announcement), and
`.tier.featured::after` (ribbon). `.pill` and `.badge` are 0.04rem apart in size
and appear **in the same card** on the report page.

**Target:** one `.chip` base, variants by intent — `verdict`, `meta`, `label`.

### Semantic collision — fix before anything else

`.pill.pass` means **"this check passed"** on report pages. On the landing page
it renders identically on all ten checklist rows, where it just means "this item
is worth a point" (`views.ts:507`). The same green PASS chip teaches two
different things, and a visitor who reads the checklist then opens a real report
has been taught the wrong one.

The landing row does not need a chip at all — the section header already says
every item is scored 0 or 1.

### Interaction state coverage

**Current:** hover exists on exactly four selectors — `.btn-primary`,
`.btn-ghost`, `.nav-links a`, `.foot a`. `:active` exists only on `.btn`. There
is **no disabled styling anywhere**.

Missing hover on things that are links: `.brand` (the logo, twice per page),
`.announce` (holds the page thesis, points off-site), `.rep-crumb a` (the
breadcrumb on every report page), and an inline anchor styled entirely by an
inline `style` attribute with no class (`views.ts:504`).

**Target:** every interactive element gets hover + active + focus. Every link
that is not obviously a link gets an affordance.

### Known component defects

- **`sealSvg()` emits no `width`/`height`** (`views.ts:195`); the only sizing rule
  is scoped to `.brand` (`views.ts:148`). Measured: the credential badge seal
  renders at **53×53px** against the brand seal's 20×20.
- **`.gradeseal` (96px) and `.bigseal` (132px)** are the same object at two sizes
  with independently hand-tuned constants. Any change must be made twice. Target:
  one component, size as a variable.
- **`pre.code` has `overflow-x:auto` with no `tabindex="0"`** — keyboard users
  cannot scroll the code blocks. No copy affordance either, on a product whose
  primary CTA is a curl command.
- **`.hero-actions` is defined for the hero but used only in the final CTA.** The
  hero contains zero buttons; the most polished component never appears above the
  fold.
- **`navHtml(active)` takes an `active` param but never marks a current link** —
  no `aria-current`, no active class.

### Components worth preserving exactly

- **`.feat-grid`'s 1px-gap-over-border trick** (`views.ts:375`) — a 1px grid gap
  over a `--border` background draws hairline rules for free. Elegant; reuse it.
- **`.gradeseal`'s radial origin at `50% 42%`** — puts the bright core behind the
  glyph's cap-height rather than its optical middle. Well judged.
- **`.cred-foot`'s dashed rule** — the perforated tear-off stub that makes the
  card read as a certificate. The best idea in the component.

---

## 5. Motion

**Current: one `transition` in the entire codebase** (`views.ts:134`), zero
`@keyframes`, and a single 1px hover lift as the only visible movement.

Three of the four properties on that transition line omit their timing function
and silently fall back to `ease` (an ease-in-out) rather than the specified
`cubic-bezier(.2,.8,.2,1)`. The most visible motion in the product runs on the
wrong curve.

### Target

```
--ease-out:      cubic-bezier(0.16, 1, 0.3, 1)     /* expo-out, the default */
--ease-out-soft: cubic-bezier(0.33, 1, 0.68, 1)    /* short UI feedback */
--dur-fast:   120ms    /* hover, focus */
--dur-base:   220ms    /* state change */
--dur-slow:   420ms    /* entrance, reveal */
```

Rules: ease-out always, no bounce, no elastic. Never animate layout properties
(the current code already respects this). Always name the timing function
per-property; never rely on shorthand fallback.

### Where motion should exist and does not

Ranked by how much it would earn:

1. **`.axmeter` / `.rep-meter`** — a 10-segment gauge that renders fully filled.
   A staggered fill is the single most obvious win in the product.
2. **`.gradeseal` / `.bigseal`** — the grade is the money shot and it just
   appears. A scale-and-settle on the seal, once, on load.
3. **`.chk` rows and `.pill` verdicts** — a subtle stagger as the ledger enters.
4. **Focus and hover** across everything currently un-eased (`.nav-links a` and
   `.foot a` snap instantly today).

`prefers-reduced-motion` is already honored globally (`views.ts:124`), so there
is a safe harness to build into. **Every addition must be inside it.**

**Constraint:** entrance animation without JavaScript means CSS-only — either
`animation` on load, or `@starting-style` / scroll-driven animations where
support allows. Adding JS is a product decision (see §0), not a styling one.

---

## 6. Responsive

**Current breakpoints — all max-width, all single-step collapses:**

| Query | What changes |
|---|---|
| 860px | `.hero-grid` and `.feat-grid` → 1 column |
| 820px | `.tracks` and `.price-grid` → 1 column |
| 720px | `.nav-links` → `display:none` (**no replacement**) |
| 640px | `.rep-main` → 1 column, centered |
| 600px | `.ck-row` → 2 columns, verdict chip hidden |
| 560px | `.attest .kv` → 1 column |

Six breakpoints at six values, no intermediate 2-column state anywhere, and a
40px dead band at 821–860px where the hero is still multi-column but tracks and
pricing have already collapsed.

**There are zero `min-width` queries and zero container queries in the codebase.**

### Target

Three named breakpoints, and use them consistently:

```
--bp-sm: 640px    /* phone → small tablet */
--bp-md: 900px    /* tablet → laptop */
--bp-lg: 1280px   /* laptop → desktop */
```

Plus a real **large-screen** story above 1280px, which does not exist today:
`.wrap` is pinned at 72rem forever, so content is 45% of a 2560px viewport and
33.5% of an ultrawide. All four `clamp()` type ramps are exhausted by 1111px —
*below* the container's own 1152px cap — so nothing scales at any width a
large-screen discussion is about.

### Mobile defects to fix

- **Page-level horizontal scroll at 375px** (414 vs 375). Root cause is
  `.track code` (`views.ts:410`) with no `overflow-wrap`; the string at
  `views.ts:533` has no break opportunity and floors the grid column above the
  viewport. Fix with `overflow-wrap:anywhere` on inline code and `min-width:0` on
  grid items — not with an ancestor `overflow-x:hidden`.
- **`.hero-grid` resolves a 608px column at a 375px viewport**, hidden by
  `.hero{overflow-x:hidden}` so hero content is silently cut off.
- **`.nav-in` has a hard `height:60px`**; the CTA wraps to two lines and measures
  65px, crossing the nav's bottom border. Target: min-height plus `flex-wrap`, or
  a shorter label on small screens.
- **No mobile navigation at all.** Four destinations vanish below 720px. With no
  JS, the honest options are a `<details>` disclosure, a CSS checkbox toggle, or
  moving the links into a always-visible scrollable row.
- **The report AX table has no mobile rule.** At 375px the fixed `2.5rem` and
  `6rem` columns eat 42% of the width, and `table.ax` is `overflow:hidden` so
  there is no escape. The landing page's equivalent does adapt.
- **Vertical rhythm never reduces** — 88px section padding on a phone, ~530px of
  pure padding total.

### Large-screen defect

`.hero::before` (`views.ts:324`) paints against the full-bleed `.hero`, so its
`at 25%` / `at 82%` origins resolve against **viewport** width while content
stays pinned and centered. The glows leave the content column at ~1800px and
~2304px and bloom in dead margin. `.cta-final::before` (`views.ts:432`) does this
correctly, anchored inside a `.wrap`-capped card. **Copy the CTA pattern.**

---

## 7. Accessibility

### Already correct — do not regress

- `:focus-visible` global with `outline-offset:2px`, measuring **8.07–8.98:1**
  against every surface it currently lands on.
- `prefers-reduced-motion` honored globally.
- Every `<svg>` carries `aria-hidden`. All 25 focusables are real anchors with
  `href` — no div-buttons. One `<h1>`. `lang="en"`.

### Gaps

- **No `<main>` landmark** anywhere, and no skip link.
- **Heading skip**: the footer's `.foot-col h4` (`views.ts:166`) jumps h2 → h4.
- **No `scroll-padding-top`, no `scroll-behavior`.** The nav is sticky at 61px, so
  all three in-page anchors land under it — `#checklist` has only 56px of top
  padding, so its eyebrow lands *behind* the bar. Two-property fix.
- **Only 3 `id`s exist on the landing page**, and the report page has **zero** —
  yet its footer links to `#how`, `#checklist`, `#pricing`. Three dead links on
  the most-linked page type.
- Verdict is conveyed by **color plus text label**, which is correct — but
  `.rep-meter` segments carry only a `title` attribute, which is hover-only and
  not keyboard reachable.

**Standard: WCAG 2.2 AA.** Six light-mode failures and one severe dark-mode
failure currently stand (§1).

---

## 8. Print

The report page is a document people file. `@media print` exists
(`views.ts:661`) with five rules and **zero print hardening** — no
`print-color-adjust`, no `break-inside`, no `@page`.

What breaks today:
- **Dark mode is never reset**, so a dark-mode reader prints near-white on white.
- **The repro `curl` command prints invisible in both themes** — `pre.code` pairs
  a fixed dark background (stripped by the browser) with near-white text (not
  stripped).
- **The AX meter is pure background-color** — ten invisible gaps.
- **The failed-row tint vanishes**, so a reader must scan all 24 pills.
- No pagination control; a check article or the attestation list can split
  mid-item. No printed canonical URL.

**Target:** a print block that force-resets `:root` to light tokens, sets
`print-color-adjust: exact` on the seal, meter, pills, failed rows and code
blocks, adds `break-inside: avoid` to `.chk` / `.attest` / `.rep-card`, and
prints the canonical verdict URL.

---

## 9. Applying this

1. Everything above is a **baseline plus proposal**. Nothing has been applied.
2. Three items need an owner ruling before implementation: the Inter question
   (§2), the em-dash / `copy.ts` conflict (see `PRODUCT.md`), and whether light
   stays the default theme.
3. When this file and the code disagree after a change, **the code is wrong** —
   update the code, or amend this file deliberately.
4. Full defect list with `file:line` citations and reproduction: the July 2026 UI
   audit brief.
