# DESIGN.md — api.qa UI design system

The interface design system. **Not** the root `DESIGN.md`, which is the
architecture and threat-model document and is a different artifact entirely.

This describes the system as shipped in `src/views.ts`. When the code and this
file disagree after a change, the code is wrong — fix it, or amend this file
deliberately.

---

## 0. The concept

**A test certificate, not a SaaS app.**

The product is a measuring instrument that emits a document people file, cite,
print, and paste into procurement threads. So the page is built as a certificate:
hairline rules, square corners everywhere, hatched separator bands, one framed
sheet, and data set in monospace because the machine produced it.

Everything below follows from that. When a decision is unclear, ask what a
calibration certificate would do.

## 1. Constraints

- **No React, no Tailwind, no CSS files, no JavaScript.** All CSS is a template
  literal in `src/views.ts`, emitted inline. Anything needing JS is a capability
  decision, not a styling choice — see the mobile menu (§6) for how to avoid it.
- **Bundle budget.** This is a live verifier whose value is being correct; page
  weight is a product concern.
- **Purity boundary.** Presentation lives in `views.ts` / `render.ts`, never in
  the judge. Same report in, same HTML out.
- **No hand-authored glyphs.** Every icon comes from `src/icons.ts`, sourced from
  `lucide-static` (UI) and `simple-icons` (brand). Never paste a `<path d="…">`.

## 2. Typography

**IBM Plex Sans + IBM Plex Mono.** One superfamily, two roles, drawn by the same
hand so they relate rather than collide.

The split is semantic, and it is the rule to hold:

| Role | Face | Covers |
|---|---|---|
| **Prose** | Plex Sans | h1/h2/h3, body copy, ledes, card text |
| **Machine output** | Plex Mono | grades, scores, digests, seeds, verdicts, commands, the `api.qa` wordmark, nav links, eyebrows, every chip |

**Sans for what a person wrote, mono for what the machine produced.**

Tracking is tuned per face: `-.028em` on h1, `-.024em` on h2. These were `-.045em`
under the previous mono display face and are far too tight for Plex Sans.

The tagline's ruled capital X (`AX = Agent eXperience`) must never pass through
`text-transform: uppercase`. `TAGLINE_SHORT` is derived by splitting `TAGLINE`
rather than retyped, because `copy.ts` rules that string verbatim.

**Tradeoff, deliberate:** the fonts load from Google Fonts, adding two external
origins. To restore the zero-external-host property, self-host subset woff2 and
swap the `<link>` for `@font-face`.

## 3. Color

OKLCH throughout. Light "lab paper" is `:root`; dark rides `prefers-color-scheme`.

Core: `--paper` `--panel` `--ink` `--ink-soft` `--rule` `--rule-soft` `--teal`.
Semantic: `--pass` `--fail` `--warn` `--skip`, each with a `-soft` partner.

### The grade ramp

`--grade-aplus` … `--grade-f`. Monotonic in hue (green 158 → red 27), no two
grades sharing a value, every step ≥4.5:1 on `--panel`. Never reintroduce a
hard-coded literal here: the previous `D` was an inline `oklch()` that did not
flip with the theme and had the worst contrast in *both* modes.

### Theme-invariant tokens

Some surfaces must not theme. Declared once, never overridden:

- `--plate*` — terminals read as the same dark surface in both themes, the way a
  screenshot of a terminal would.
- `--scrim` — **a scrim is always a shadow.** Deriving it from `--ink` painted a
  white veil over the page in dark mode.

### The instrument field

`--field-a/b/c` are the gradient the hero and report credential float on, plus a
noise layer (an feTurbulence data URI, ~250 bytes, resolution-independent, no JS).

`--window-bg` / `--term-bg` are opaque on light paper and **translucent at night**
so the field reads through. The alpha is tuned, not chosen: below ~0.84 the field
bleeds through and small copy drops under 4.5:1.

### THE RULE THAT KEEPS GETTING RELEARNED

> **In dark mode, never let one surface separate from another by value alone.**

This failed four separate times during the redesign:

1. The invariant band — a dark plate on dark paper became a muddy slab.
2. The terminal dissolving into the field's dark corner at **1.16:1**.
3. Translucency bleeding the field through text, dropping it to **3.05:1**.
4. The panel edge separating at **1.60:1** with no border.

The usable value range at night is compressed. Separation needs a second
channel — a border, elevation, a derived edge, or lifted field stops. Light mode
will not warn you, because there the same pairings have enormous headroom.

## 4. Layout

- **One sheet**, `max-width: 1320px`, `border-inline`. The page is a document.
- **Square corners.** No border-radius anywhere except the terminal's traffic dots.
- **Hatched bands** separate sections. Hatching means "no reading here" — use it
  only as a separator, never decoratively.
- **1px grid gap over a ruled ground** draws hairlines for free. Used by `.mech`,
  `.tracks`, `.tiers`, `.inputs`. Prefer it to per-cell borders.
- **Fluid padding** via `clamp()` so a phone does not spend ~530px on padding.
- Every layout child gets `min-width: 0`. Grid and flex items default to
  `min-width: auto`, so one unbreakable digest floors a track above the viewport
  and pushes the document into horizontal scroll.

### Breakpoints

`860px` (grids collapse), `820px` (nav → mobile menu), `760px` (stats), `640px`
(hero credential), `560px` (report tables). Keep to these; don't invent new ones.

## 5. The instrument well

The hero's signature object and the report's credential share one treatment:

- Two windows, **exactly 50/50**, **no gap, no seam, no frame** — the surface
  change from paper card to dark terminal is the division.
- They float inside a padded, noise-textured gradient field, even inset on all
  four sides, with the padding equal to what the gap would have been.
- The pair is one object. If a frame is ever needed again, derive it from light
  (white/black at ~12% alpha), never a token grey — a grey rule reads as a border,
  a light-derived edge reads as the panel catching light.

## 6. The mobile menu, without JavaScript

Driven by `:target`. Three properties fall out of that choice:

- **No JS**, so the zero-JavaScript property survives.
- **Auto-close for free** — every item is an in-page anchor, so choosing one moves
  the target off `#menu`.
- **Overlay, not push** — the panel is absolutely positioned; document height is
  identical open and closed.

`#menu` precedes the nav in the DOM purely so a sibling combinator can reach the
trigger. Being absolutely positioned, its DOM order does not affect where it
renders.

**One control, two states.** The hamburger becomes an X in place, rotating via a
keyframe as it swaps. There is no separate close row — the trigger, the scrim,
and any menu item all dismiss it.

## 7. Motion

`--ease-out: cubic-bezier(0.16, 1, 0.3, 1)`, `--dur-fast: 120ms`,
`--dur-base: 220ms`. Ease-out always; no bounce, no elastic.

**Name the timing function per property.** CSS shorthand does not carry one
across a list — an omitted curve silently falls back to `ease`, an ease-in-out.
That bug shipped in the previous system.

Never animate layout properties. `prefers-reduced-motion` is honored globally, so
every addition lands inside it automatically.

## 8. Accessibility

WCAG 2.2 AA. Current state: **zero contrast failures in either theme.**

Already correct, don't regress: global `:focus-visible` with `outline-offset`,
every `<svg>` `aria-hidden`, all focusables are real anchors with `href`, one
`<h1>`, `lang="en"`, `scroll-padding-top` clearing the sticky nav, and
`tabindex="0"` on scrollable code blocks so they're keyboard-reachable.

## 9. Print

The report page is a document people file. The print block force-resets `:root`
to light tokens — without it a dark-mode reader prints near-white on white — and
sets `print-color-adjust: exact` on the meter, chips, failed rows and code
blocks, which are background-only and otherwise print invisible. Plus
`break-inside: avoid` on checks and the credential, and href expansion on links.

## 10. Selector hygiene

Hand-written CSS with no compiler. Unscoped descendant selectors reach further
than they look — this bit three times:

- `.fcol a` swallowed the footer brand lockup (`display:block` + muted color).
- `.score span` captured the `/10` nested inside `<b>` and stacked it.
- `.check`-style helpers leaking across pages.

**Use `>` when you mean a direct child.** When in doubt, scope tighter.
