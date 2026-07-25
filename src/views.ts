/**
 * Browser-facing views — the polished HTML mounts of api.qa.
 *
 * WHY this is a self-contained string layer and not React SSR: this is a
 * Cloudflare Worker built with plain `tsc` + wrangler/esbuild, with no React
 * runtime, no Tailwind pipeline, no JavaScript shipped at all, and a hard
 * bundle-size budget on a LIVE deployed verifier.
 *
 * DESIGN DIRECTION — the certificate.
 * The product is a measuring instrument that emits a document people file and
 * cite, so the page is built as a test certificate rather than as a SaaS app:
 * hairline rules, square corners, hatched separator bands, and a strict
 * typographic split — IBM Plex Sans for prose, IBM Plex Mono for anything the
 * machine produced (grades, digests, seeds, verdicts, commands). Full rationale
 * in .agents/context/DESIGN.md.
 *
 * DESIGN.md purity boundary: presentation lives here and in render.ts, never in
 * the pure judge. These functions read a finished report; they never observe or
 * grade. Same report in → same HTML out.
 */

import type { VerificationReport, Grade, Verdict } from './types.js'
import { TAGLINE, AXP_ANCHOR, JUDGED, ADMISSION, VILLAIN } from './copy.js'
import { sealIcon, githubIcon, menuIcon, closeIcon, GITHUB_TITLE } from './icons.js'

/**
 * The tagline's head clause, for viewports where the full ruled line wraps to
 * three lines inside an announcement chip.
 *
 * DERIVED from TAGLINE, never retyped: copy.ts:7 rules that string verbatim, so
 * a second hand-written copy would be exactly the drift copy.ts exists to
 * prevent. Splitting on the em dash yields "AX = Agent eXperience", preserving
 * the ruled capital X. Note it is never `text-transform: uppercase`d anywhere —
 * uppercasing would silently destroy that ruled capital.
 */
const TAGLINE_SHORT = TAGLINE.split('—')[0]?.trim() || TAGLINE

export function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

function tokensCss(): string {
  return `
:root{
  --paper: oklch(0.930 0.004 175);
  --panel: oklch(0.968 0.003 175);
  --ink: oklch(0.205 0.021 210);
  --ink-soft: oklch(0.445 0.018 200);
  --rule: oklch(0.845 0.008 190);
  --rule-soft: oklch(0.890 0.006 190);
  /* 0.520 measured 4.06:1 as inline link text once --paper moved to a warmer,
     darker lab grey. Text is the binding constraint on this token. */
  --teal: oklch(0.470 0.110 185);
  --teal-ink: oklch(0.992 0.006 180);
  --pass: oklch(0.500 0.135 158);
  --pass-soft: oklch(0.945 0.045 158);
  --fail: oklch(0.545 0.195 27);
  --fail-soft: oklch(0.950 0.045 27);
  --warn: oklch(0.545 0.130 70);
  --warn-soft: oklch(0.955 0.045 70);
  --skip: oklch(0.520 0.018 200);
  --hatch: oklch(0.205 0.021 210 / 0.16);

  /* Grade ramp — monotonic in hue (green 158 -> red 27), no two grades sharing
     a value, every step >=4.5:1 on --panel. */
  --grade-aplus: oklch(0.500 0.145 158);
  --grade-a: oklch(0.515 0.138 150);
  --grade-b: oklch(0.535 0.130 128);
  --grade-c: oklch(0.545 0.135 75);
  --grade-d: oklch(0.550 0.165 45);
  --grade-f: oklch(0.545 0.195 27);

  /* The plate is theme-INVARIANT: terminals read as the same dark surface in
     both themes, the way a screenshot of a terminal would. */
  /* Deep enough to stay a distinct surface on DARK paper too: at 0.190 the
     snippet measured 1.01:1 against a 0.185 paper and vanished. */
  --plate: oklch(0.128 0.022 222);
  --plate-ink: oklch(0.910 0.014 190);
  --plate-dim: oklch(0.680 0.016 195);
  --plate-rule: oklch(0.280 0.020 220);
  --plate-dot: oklch(0.400 0.014 210);
  --plate-accent: oklch(0.800 0.130 175);
  --plate-pass: oklch(0.800 0.145 160);

  /* Instrument field: the gradient the hero windows float on. */
  --field-a: oklch(0.640 0.108 178);
  --field-b: oklch(0.440 0.078 195);
  --field-c: oklch(0.360 0.058 205);
  --window-bg: var(--panel);
  --term-bg: var(--plate);

  /* Theme-INVARIANT: a scrim derived from --ink paints a white veil in dark
     mode, because --ink is near-white there. A scrim is always a shadow. */
  --scrim: oklch(0.16 0.012 210 / 0.58);
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
  --dur-fast: 120ms;
  --dur-base: 220ms;
  --mono: 'IBM Plex Mono', ui-monospace, 'SF Mono', 'Cascadia Mono', Menlo, Consolas, monospace;
  --sans: 'IBM Plex Sans', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
}
@media (prefers-color-scheme: dark){
  :root{
    --paper: oklch(0.185 0.014 210);
    --panel: oklch(0.225 0.016 212);
    --ink: oklch(0.930 0.010 185);
    --ink-soft: oklch(0.680 0.016 195);
    --rule: oklch(0.320 0.016 212);
    --rule-soft: oklch(0.270 0.014 212);
    --teal: oklch(0.760 0.128 178);
    --teal-ink: oklch(0.185 0.014 210);
    --pass: oklch(0.760 0.145 160);
    --pass-soft: oklch(0.320 0.055 158);
    --fail: oklch(0.700 0.180 27);
    --fail-soft: oklch(0.320 0.070 27);
    --warn: oklch(0.790 0.140 70);
    --warn-soft: oklch(0.330 0.060 70);
    --skip: oklch(0.640 0.020 200);
    --hatch: oklch(0.930 0.010 185 / 0.13);
    --grade-aplus: var(--pass);
    --grade-a: oklch(0.775 0.140 150);
    --grade-b: oklch(0.800 0.135 128);
    --grade-c: oklch(0.815 0.140 75);
    --grade-d: oklch(0.760 0.165 45);
    --grade-f: var(--fail);
    /* Lifted so the windows never converge with the field they float on: at the
       previous values the terminal separated from the dark stop at 1.16:1 and
       visually dissolved into it. */
    --field-a: oklch(0.645 0.110 178);
    --field-b: oklch(0.455 0.080 197);
    --field-c: oklch(0.390 0.062 207);
    /* Translucent at night so the field reads through the windows. Alpha is
       tuned, not chosen: below ~0.84 the field bleeds through the text and
       small copy drops under 4.5:1. */
    --window-bg: color-mix(in srgb, var(--panel) 86%, transparent);
    --term-bg: color-mix(in srgb, var(--plate) 84%, transparent);
  }
}`
}

// ---------------------------------------------------------------------------
// Base
// ---------------------------------------------------------------------------

function baseCss(): string {
  return `
*,*::before,*::after{box-sizing:border-box}
/* scroll-padding clears the sticky nav; without it every in-page anchor lands
   underneath the bar. */
html{-webkit-text-size-adjust:100%;scroll-padding-top:5rem}
@media (prefers-reduced-motion: no-preference){html{scroll-behavior:smooth}}
body{margin:0;background:var(--paper);color:var(--ink);
  font-family:var(--sans);font-size:15px;line-height:1.6;
  font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
a{color:inherit;text-decoration:none}
p{margin:0}
:focus-visible{outline:2px solid var(--teal);outline-offset:2px}
@media (prefers-reduced-motion: reduce){
  *,*::before,*::after{transition-duration:.01ms !important;animation-duration:.01ms !important}
}
/* Grid and flex items default to min-width:auto, so one unbreakable token (a
   digest, a CLI flag) can floor a track above the viewport and push the whole
   document into horizontal scroll. Opt every layout child out. */
.windows>*,.mech>*,.tracks>*,.tiers>*,.stats>*,.rep-main>*,.fgrid>*,.inputs>*{min-width:0}
code,.mono,.rep-host,.rep-crumb{font-family:var(--mono);overflow-wrap:anywhere}

/* Headings take the sans; anything the machine produced stays mono. */
h1,h2,h3{font-family:var(--sans);margin:0;text-wrap:balance}
h1{font-weight:700;letter-spacing:-.028em;line-height:1.06;font-size:clamp(2.2rem,7vw,3.4rem)}
h2{font-weight:700;letter-spacing:-.024em;line-height:1.1;font-size:clamp(1.4rem,3.4vw,2.15rem)}
h1 em,h2 em{font-style:normal;color:var(--teal)}

/* The page is a certificate: one framed sheet, everything ruled inside it. */
.sheet{max-width:1320px;margin:0 auto;border-inline:1px solid var(--rule);min-height:100vh;background:var(--paper)}
.pad{padding-inline:clamp(1rem,3.5vw,2.5rem)}
/* Hatching marks a region that carries no reading — separators only. */
/* The stripe stop is SOFT on purpose. A hard stop (var(--hatch) 0 1px,
   transparent 1px ...) gives the rasteriser nothing to antialias against, so on
   a rotated axis at fractional device-pixel ratios individual stripes drop out
   and the spacing reads ragged — most visible on phones. Ramping to transparent
   over ~1px lets it antialias and the pattern stays even at any DPR. */
.hatch{height:22px;border-block:1px solid var(--rule);
  background-image:repeating-linear-gradient(-45deg,
    var(--hatch) 0, var(--hatch) 1px, transparent 2px, transparent 8px)}

.eyebrow{font-family:var(--mono);font-size:.66rem;letter-spacing:.16em;text-transform:uppercase;
  color:var(--ink-soft);display:flex;align-items:center;gap:.5rem;margin:0}
.eyebrow::before{content:"";width:5px;height:5px;background:var(--teal);flex:none}
.lede{color:var(--ink-soft);font-size:1.02rem;max-width:64ch}

/* buttons — square, hairline, no radius anywhere in this system */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:.5rem;
  font-family:var(--mono);font-size:.82rem;padding:.6rem 1rem;border:1px solid var(--rule);
  white-space:nowrap;cursor:pointer;
  transition:background var(--dur-fast) var(--ease-out),border-color var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out)}
.btn-ghost:hover{border-color:var(--teal);color:var(--teal)}
.btn-solid{background:var(--teal);color:var(--teal-ink);border-color:var(--teal);font-weight:600}
.btn-solid:hover{filter:brightness(1.08)}
.btn-sm{padding:.32rem .78rem;font-size:.79rem}

/* nav */
.navwrap{position:relative;z-index:60}
.nav{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:1.5rem;min-height:58px}
.brand{display:flex;align-items:center;gap:.55rem;font-family:var(--mono);font-weight:700;
  letter-spacing:-.02em;flex:none}
/* The seal scales with its text context; the LOGO mark is always brand — it does
   not follow the text colour into white on dark, and does not shift on hover. */
.seal{width:1.15em;height:1.15em;flex:none}
.brand .seal{width:19px;height:19px;color:var(--teal)}
.navlinks{display:flex;justify-content:center;gap:1.6rem;font-family:var(--mono);
  font-size:.78rem;color:var(--ink-soft)}
.navlinks a{transition:color var(--dur-fast) var(--ease-out)}
.navlinks a:hover{color:var(--teal)}
.navcta{display:flex;align-items:center;justify-content:flex-end;gap:.6rem}
/* Bare icon link: no border, no fill. Padding is hit-area only. */
.iconlink{display:inline-flex;align-items:center;justify-content:center;flex:none;
  color:var(--ink-soft);padding:.4rem;margin:-.4rem;
  transition:color var(--dur-fast) var(--ease-out)}
.iconlink:hover{color:var(--teal)}
.iconlink .icon{width:1.2rem;height:1.2rem}
/* Mobile menu, driven by :target rather than JavaScript — this Worker ships
   none. :target also buys auto-close: every item is an in-page anchor, so
   choosing one moves the target off #menu and the panel closes itself. The
   panel is absolutely positioned, so it OVERLAYS the page, never pushes it.
   #menu precedes the nav in the DOM purely so a sibling combinator can reach
   the trigger; being absolutely positioned, its DOM order does not affect
   where it renders. */
/* The nav must sit ABOVE the scrim. .menu is positioned and the nav's .pad is
   static, so without these the fixed scrim paints over the bar itself and dims
   the logo and the close control — the overlay looks broken in both themes.
   The panel drops to top:100%, below the bar, so nothing is hidden by this. */
/* Opaque, not just stacked above: .pad has no background of its own, so the
   scrim painted straight THROUGH the transparent bar and the nav still read
   as dimmed. Matches --paper, so nothing changes when the menu is closed. */
.navwrap>.pad{position:relative;z-index:2;background:var(--paper)}
.menu{display:none;position:absolute;top:100%;left:0;right:0;z-index:1}
.menu:target{display:block}
@media(min-width:821px){.menu{display:none !important}}
.menu-scrim{position:fixed;inset:0;background:var(--scrim)}
.menu-panel{position:relative;background:var(--paper);border-bottom:1px solid var(--rule)}
.menu-panel a{display:flex;align-items:center;justify-content:space-between;
  font-family:var(--mono);font-size:.9rem;color:var(--ink);
  padding:.95rem clamp(1rem,3.5vw,2.5rem);border-top:1px solid var(--rule)}
.menu-panel a:first-child{border-top:0}
.menu-panel a:hover,.menu-panel a:focus-visible{color:var(--teal);background:var(--panel)}

/* One control, two states: the hamburger becomes an X in place. No separate
   close row — the trigger, the scrim and any menu item all dismiss it. */
.burger{display:none}
.burger-close{display:none}
@media(max-width:820px){
  .navlinks{display:none}
  .nav{grid-template-columns:1fr auto}
  .burger-open{display:inline-flex}
  .menu:target ~ .pad .burger-open{display:none}
  .menu:target ~ .pad .burger-close{display:inline-flex}
}
@keyframes burger-turn{from{transform:rotate(-90deg);opacity:0}to{transform:rotate(0);opacity:1}}
.burger .icon{animation:burger-turn var(--dur-base) var(--ease-out)}

/* section rhythm — fluid, so a phone does not spend ~530px on padding alone */
.sec{padding-block:clamp(2.25rem,5vw,3.5rem)}
.seclede{margin:.9rem 0 0;max-width:62ch;color:var(--ink-soft)}

/* verdict chips */
.chip{display:inline-flex;align-items:center;justify-content:center;gap:.35rem;
  font-family:var(--mono);font-size:.64rem;font-weight:600;letter-spacing:.1em;
  text-transform:uppercase;line-height:1;white-space:nowrap;padding:.28rem .48rem;border:1px solid}
.chip.pass{color:var(--pass);border-color:color-mix(in srgb,var(--pass) 42%,transparent)}
.chip.fail{color:var(--fail);border-color:color-mix(in srgb,var(--fail) 42%,transparent)}
.chip.skip{color:var(--ink-soft);border-color:color-mix(in srgb,var(--ink) 28%,transparent)}
.chip.warn{color:var(--warn);border-color:color-mix(in srgb,var(--warn) 42%,transparent)}

/* terminal — the one dark surface in the system */
.term{background:var(--term-bg);color:var(--plate-ink);height:100%;display:flex;flex-direction:column}
.termbar{display:flex;align-items:center;gap:.4rem;padding:.55rem .75rem;border-bottom:1px solid var(--plate-rule)}
.termbar i{width:9px;height:9px;border-radius:50%;background:var(--plate-dot);flex:none}
.termbar span{margin-left:.5rem;font-family:var(--mono);font-size:.66rem;color:var(--plate-dim)}
.termbody{padding:.9rem 1rem 1.1rem;overflow-x:auto;font-family:var(--mono);font-size:.735rem;line-height:1.75}
.termbody pre{margin:0}
.termbody:focus-visible{outline:2px solid var(--plate-accent);outline-offset:-2px}
.c-dim{color:var(--plate-dim)}
.c-acc{color:var(--plate-accent)}
.c-pass{color:var(--plate-pass)}

/* footer */
footer{padding-block:2rem}
.fgrid{display:grid;grid-template-columns:2fr 1fr 1fr 1fr;gap:1.75rem}
@media(max-width:820px){.fgrid{grid-template-columns:1fr 1fr}}
@media(max-width:520px){.fgrid{grid-template-columns:1fr}}
.fcol h4{font-family:var(--mono);font-size:.62rem;letter-spacing:.14em;text-transform:uppercase;
  color:var(--ink);margin:0 0 .65rem;font-weight:700}
/* Scoped away from .brand: an unscoped .fcol a selector overrides the brand
   lockup's display:flex and colour, silently breaking the footer logo. */
.fcol a:not(.brand){display:block;font-size:.83rem;color:var(--ink-soft);padding:.16rem 0;
  transition:color var(--dur-fast) var(--ease-out)}
.fcol a:not(.brand):hover{color:var(--teal)}
.fcol .brand{font-size:1.02rem;color:var(--ink);margin-bottom:.75rem}
.fnote{margin-top:1.75rem;padding-top:1rem;border-top:1px solid var(--rule-soft);
  font-family:var(--mono);font-size:.66rem;color:var(--ink-soft);
  display:flex;flex-wrap:wrap;gap:.4rem 1.25rem;justify-content:space-between}`
}

/**
 * Head metadata.
 *
 * WEBFONTS: IBM Plex Sans + IBM Plex Mono, one superfamily covering both roles.
 * They are drawn as an engineering identity, which is the register of a test
 * certificate, and being a superfamily the sans and mono relate rather than
 * collide. `display=swap` means the system stack paints first, so this never
 * blocks the verdict.
 *
 * TRADEOFF (deliberate): this adds fonts.googleapis.com and fonts.gstatic.com
 * as external origins. To restore the zero-external-host property, self-host
 * both as subset woff2 and swap these links for @font-face.
 */
function headMeta(): string {
  return `<meta name="theme-color" media="(prefers-color-scheme: light)" content="#e9ecea">
<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#1b2124">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600;700&display=swap">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="alternate icon" href="/favicon.ico" sizes="32x32">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta property="og:image" content="https://api.qa/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="https://api.qa/og.png">`
}

/** Marks come from src/icons.ts; no glyph path data is authored in this file. */
const sealSvg = sealIcon
const githubSvg = githubIcon

function shell(opts: { title: string; description: string; jsonLd: object; body: string; extraCss?: string; script?: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(opts.title)}</title>
<meta name="description" content="${esc(opts.description)}">
<meta name="color-scheme" content="light dark">
<meta property="og:title" content="${esc(opts.title)}">
<meta property="og:description" content="${esc(opts.description)}">
${headMeta()}
<script type="application/ld+json">${JSON.stringify(opts.jsonLd)}</script>
<style>${tokensCss()}${baseCss()}${opts.extraCss ?? ''}</style>
</head>
<body>
${opts.body}
${opts.script ? `<script>${opts.script}</script>` : ''}
</body>
</html>`
}

const NAV_LINKS: Record<'landing' | 'report', Array<[string, string]>> = {
  landing: [['#how', 'How it works'], ['#checklist', 'The AX score'], ['#pricing', 'Pricing'], ['/llms.txt', 'Docs']],
  // Absolute hrefs on the report page: the landing anchors do not exist here,
  // and relative ones silently did nothing on the most-linked page type.
  report: [['/#how', 'How it works'], ['/#checklist', 'The AX score'], ['/#pricing', 'Pricing'], ['/llms.txt', 'Docs']],
}

function navHtml(active: 'landing' | 'report'): string {
  const links = NAV_LINKS[active]
  return `<div class="navwrap">
  <div class="menu" id="menu">
    <a class="menu-scrim" href="#" aria-label="Close navigation menu" tabindex="-1"></a>
    <div class="menu-panel">
      ${links.map(([h, t]) => `<a href="${h}">${esc(t)}</a>`).join('')}
    </div>
  </div>
  <div class="pad"><nav class="nav">
    <a class="brand" href="/">${sealSvg()} api.qa</a>
    <div class="navlinks">${links.map(([h, t]) => `<a href="${h}">${esc(t)}</a>`).join('')}</div>
    <div class="navcta">
      <a class="iconlink" href="https://github.com/dot-do/api.qa" aria-label="Source on ${esc(GITHUB_TITLE)}" title="Source on ${esc(GITHUB_TITLE)}">${githubSvg()}</a>
      <a class="iconlink burger burger-open" href="#menu" aria-label="Open navigation menu" aria-expanded="false">${menuIcon()}</a>
      <a class="iconlink burger burger-close" href="#" aria-label="Close navigation menu" aria-expanded="true">${closeIcon('icon')}</a>
    </div>
  </nav></div>
</div>`
}

function footHtml(): string {
  const year = 2026
  return `<div class="pad"><footer>
  <div class="fgrid">
    <div class="fcol">
      <a class="brand" href="/">${sealSvg()} api.qa</a>
      <p style="font-size:.83rem;color:var(--ink-soft);max-width:32ch">The external third-party verifier for agent-first APIs. Published as the <code>autonomous-qa</code> package.</p>
    </div>
    <div class="fcol"><h4>Product</h4>
      <a href="/#how">How it works</a><a href="/#checklist">The AX score</a><a href="/#pricing">Pricing</a>
    </div>
    <div class="fcol"><h4>For agents</h4>
      <a href="/llms.txt">llms.txt</a><a href="/.well-known/agents.json">agents.json</a>
      <a href="/icp.json">icp.json</a><a href="/openapi.json">openapi.json</a>
    </div>
    <div class="fcol"><h4>Verify</h4>
      <a href="/self">/self &middot; api.qa under its own checks</a>
      <a href="/offers/attested-run">Attested run</a>
      <a href="https://github.com/dot-do/api.qa">Source</a>
    </div>
  </div>
  <div class="fnote">
    <span>&copy; ${year} api.qa</span>
    <span>a verdict is a pure function of five inputs, none of them yours to write</span>
  </div>
</footer></div>`
}

// ---------------------------------------------------------------------------
// Landing page
// ---------------------------------------------------------------------------

const AX_ITEMS: Array<[string, string]> = [
  ['llms.txt', 'served and agent-actionable'],
  ['agents.json', 'capability card parses'],
  ['icp.json', 'self-classification surface'],
  ['Content negotiation', 'curl gets markdown, browser gets HTML'],
  ['OpenAPI', 'machine-readable contract published'],
  ['MCP', 'interface declared with transport and tools'],
  ['Keyless flow', 'a No-ask Zone endpoint answers 2xx with no key'],
  ['402 offers', 'payment boundaries are structured, hard-ceiling offers'],
  ['Linkset', 'surfaces cross-reference each other'],
  ['Attestation', 'identity / attestation ladder declared'],
]

/**
 * The six anti-cheat mechanisms, each labelled with the threat-model attack it
 * defeats. The number is the ATTACK, not a sequence — these are independent
 * mechanisms, so numbering them 01..06 would assert an order that is not real.
 */
const FEATURES: Array<[string, string, string]> = [
  ['01', 'Derived at run time', 'Checks are computed from the target’s own published surfaces. There are zero repo-local test files to rewrite until green.'],
  ['02', 'Ratified-digest gate', 'Acceptance names a sha256 digest, not a file path. If the spec text doesn’t hash to the pin, nothing runs — the verifier refuses before a single probe fires.'],
  ['06', 'Held-out signing key', 'Attested verdicts are Ed25519-signed by a key that lives only as a deploy secret. A fleet that owns the code still cannot mint attested history.'],
  ['07', 'Deterministic, replayable', 'The evidence bundle is embedded, so anyone can re-judge it offline and confirm the grade reproduces. The same evidence cannot judge two ways.'],
  ['04', 'Seeded sampling', 'Endpoint sampling is seeded fresh per run and recorded in the report. Overfitting to one run’s probe set fails the next.'],
  ['11', 'Honesty caps the grade', 'Two non-scoring checks cap the grade at C when a surface lies. A faked 200 where a typed BLOCKED belongs scores worse than a missing surface.'],
]

const INVARIANT_INPUTS: Array<[string, string]> = [
  ['01', 'Published contracts'],
  ['02', 'Observed behavior'],
  ['03', 'Ratified digest'],
  ['04', 'Seed'],
  ['05', 'Verifier version'],
]

const STATS: Array<[string, string]> = [
  ['5', 'Inputs a verdict depends on, none of them yours to write'],
  ['24', 'Deterministic checks derived at run time'],
  ['0', 'Repo-local test files a fleet could rewrite'],
]

const PRICING: Array<{ name: string; price: string; note: string; features: string[]; cta: string; href: string; featured?: boolean }> = [
  {
    name: 'Public grade',
    price: '$0',
    note: 'keyless, forever',
    features: ['GET api.qa/{domain}: grade + AX score', 'Per-check verdicts and the punch list', 'Advisory local runs: npx autonomous-qa', 'No signup, no key'],
    cta: 'curl api.qa/example.com',
    href: '/example.com',
  },
  {
    name: 'Attested run',
    price: '$5',
    note: 'one-time, per run',
    features: ['On-demand, Ed25519-signed verdict', 'Embedded evidence, replayable offline', 'Proof URL that survives a handover', 'Settled as a hard-ceiling 402 offer'],
    cta: 'curl api.qa/offers/attested-run',
    href: '/offers/attested-run',
    featured: true,
  },
  {
    name: 'CI webhook',
    price: '$20',
    note: 'per month',
    features: ['Re-verify on every deploy', 'Freshness gate against time-shifted state', 'Reverify-as-a-subscription', 'Grade timeline + badge'],
    cta: 'Set up a monitor',
    href: '/monitors',
  },
]

function landingCss(): string {
  return `
/* announcement — a ruled line, not a lozenge */
.ann{display:inline-flex;align-items:center;gap:.55rem;font-family:var(--mono);
  font-size:.66rem;color:var(--ink-soft);letter-spacing:.06em}
.ann i{width:5px;height:5px;background:var(--teal);flex:none}
.ann b{text-transform:uppercase;letter-spacing:.14em;color:var(--ink);font-weight:700}
.ann:hover b{color:var(--teal)}

/* hero reads as a title block: centred intro, instrument panel full width under it */
.hero{padding-block:clamp(2.75rem,6.5vw,5rem);text-align:center}
.hero h1{margin:1.1rem auto 0;max-width:26ch}
.hero .lede{margin:1.1rem auto 0}
.actions{display:flex;flex-wrap:wrap;gap:.6rem;margin-top:1.75rem;justify-content:center}
/* Phones: stack and fill. Two side-by-side pills at this width leave each one
   too narrow to read as a primary action. */
@media(max-width:560px){
  .actions{flex-direction:column;align-items:stretch}
  .actions .btn{width:100%}
}
.trust{display:flex;flex-wrap:wrap;gap:.4rem 1.5rem;margin-top:1.35rem;justify-content:center;
  font-family:var(--mono);font-size:.72rem;color:var(--ink-soft)}
.trust span{display:inline-flex;align-items:center;gap:.45rem}
.trust span::before{content:"";width:4px;height:4px;background:var(--pass);flex:none}

/* The instrument well: the two windows float inside a padded, textured field.
   Noise is an feTurbulence data URI — ~250 bytes, tiles forever, resolution
   independent, and needs no JavaScript. */
.well{margin-top:clamp(1.6rem,4vw,2.5rem);text-align:left;
  padding:clamp(.85rem,2.4vw,1.6rem);
  background-color:var(--field-b);
  background-image:
    url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='180' height='180' filter='url(%23n)'/%3E%3C/svg%3E"),
    radial-gradient(120% 130% at 12% -10%, var(--field-a), transparent 58%),
    radial-gradient(110% 120% at 92% 108%, var(--field-c), transparent 62%),
    linear-gradient(128deg, var(--field-a) 0%, var(--field-b) 48%, var(--field-c) 100%);
  background-blend-mode:soft-light,normal,normal,normal;
  background-size:180px 180px,auto,auto,auto}
/* The two windows are ONE object: no gap, no seam, no frame. The surface change
   between paper card and dark terminal is the division. */
.windows{display:grid;grid-template-columns:1fr 1fr;overflow:hidden;
  -webkit-backdrop-filter:blur(7px);backdrop-filter:blur(7px)}
@media(max-width:860px){.windows{grid-template-columns:1fr}}
.cell{background:var(--window-bg);padding:clamp(1.1rem,3vw,1.6rem);min-width:0}
.cell--term{padding:0}
.cardhead{display:flex;justify-content:space-between;align-items:baseline;gap:1rem;
  font-family:var(--mono);font-size:.72rem;color:var(--ink-soft)}
.stamp{border:1px solid var(--rule);padding:.1rem .38rem;letter-spacing:.12em;
  font-size:.6rem;text-transform:uppercase}
.gradeline{display:flex;align-items:center;gap:1rem;margin-top:1rem}
.grade{font-family:var(--mono);font-weight:700;font-size:clamp(3rem,9vw,4.25rem);
  line-height:.85;letter-spacing:-.06em;color:var(--pass)}
.score{font-family:var(--mono)}
.score b{font-size:1.6rem;font-weight:700;letter-spacing:-.03em}
/* direct child only: an unscoped .score span selector also captures the /10
   span nested inside <b> and forces it onto its own line. */
.score>span{color:var(--ink-soft);font-size:.76rem;display:block;margin-top:.15rem}
.score b span{opacity:.45;font-weight:700}
/* 10 discrete cells, because the score is 10 discrete checks */
.meter{display:grid;grid-template-columns:repeat(10,1fr);gap:3px;margin-top:1.15rem}
.meter i{height:8px;background:var(--pass)}
.meter i.off{background:color-mix(in srgb,var(--ink) 18%,transparent)}
.facts{margin-top:1.05rem;padding-top:.85rem;border-top:1px dashed var(--rule);
  font-family:var(--mono);font-size:.68rem;color:var(--ink-soft);display:grid;gap:.3rem}
.facts b{color:var(--ink);font-weight:600}

/* stats */
.stats{display:grid;grid-template-columns:repeat(3,1fr);border-bottom:1px solid var(--rule)}
@media(max-width:760px){.stats{grid-template-columns:1fr}}
.stat{padding:1.35rem clamp(1rem,3.5vw,2.5rem)}
.stat+.stat{border-left:1px solid var(--rule)}
@media(max-width:760px){.stat+.stat{border-left:0;border-top:1px solid var(--rule)}}
.stat b{font-family:var(--mono);font-size:1.85rem;font-weight:700;letter-spacing:-.04em;display:block;line-height:1}
.stat span{color:var(--ink-soft);font-size:.8rem;display:block;margin-top:.4rem}

/* mechanisms — a 1px grid gap over a ruled ground draws the hairlines for free */
.mech{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;margin-top:1.9rem;
  background:var(--rule);border:1px solid var(--rule)}
@media(max-width:880px){.mech{grid-template-columns:1fr}}
.m{background:var(--panel);padding:1.25rem 1.35rem}
.m .att{font-family:var(--mono);font-size:.62rem;letter-spacing:.12em;text-transform:uppercase;color:var(--teal)}
.m h3{font-size:1.05rem;font-weight:600;margin:.5rem 0 .45rem;letter-spacing:-.015em;line-height:1.25}
.m p{color:var(--ink-soft);font-size:.87rem;line-height:1.55}

/* checklist */
.rows{margin-top:1.75rem;border:1px solid var(--rule);background:var(--panel)}
.row{display:grid;grid-template-columns:2.4rem 1fr auto;align-items:center;gap:.9rem;
  padding:.62rem clamp(.8rem,2.5vw,1.15rem);border-top:1px solid var(--rule-soft);font-size:.9rem}
.row:first-child{border-top:0}
.row .n{font-family:var(--mono);font-size:.72rem;color:var(--ink-soft);text-align:right}
.row .d{color:var(--ink-soft);font-size:.85rem}
.cap{padding:.85rem clamp(.8rem,2.5vw,1.15rem);border-top:1px solid var(--rule);
  font-size:.83rem;color:var(--ink-soft);background:color-mix(in srgb,var(--teal) 7%,transparent)}
@media(max-width:600px){.row{grid-template-columns:2rem 1fr}.row .chip{display:none}}

/* The core invariant is a SPECIFICATION CLAUSE, not a banner. It was a
   full-bleed dark plate; in dark mode the plate and the paper sit within a few
   points of each other, so the "engraved" read collapsed into a muddy slab. */
.clause{margin-top:1.9rem;border:1px solid var(--ink);background:var(--panel)}
.clause-h{display:flex;flex-wrap:wrap;gap:.5rem 1rem;align-items:baseline;justify-content:space-between;
  padding:.6rem clamp(.9rem,2.5vw,1.3rem);background:var(--ink);color:var(--paper)}
.clause-h span{font-family:var(--mono);font-size:.63rem;letter-spacing:.14em;text-transform:uppercase}
.clause-b{padding:clamp(1.1rem,3vw,1.5rem) clamp(.9rem,2.5vw,1.3rem)}
.clause-b q{quotes:none;display:block;font-family:var(--sans);font-weight:700;letter-spacing:-.022em;
  line-height:1.3;font-size:clamp(1.05rem,2.4vw,1.5rem);max-width:44ch;text-wrap:balance}
.clause-b q em{font-style:normal;color:var(--teal)}
.inputs{display:grid;grid-template-columns:repeat(5,1fr);gap:1px;margin-top:1.35rem;
  background:var(--rule);border:1px solid var(--rule)}
/* Straight to a single column: five clause inputs are a list, and a 2-up
   intermediate reads as a grid of unrelated cells rather than an enumeration. */
@media(max-width:860px){.inputs{grid-template-columns:1fr}}
.in{background:var(--panel);padding:.7rem .8rem}
.in b{display:block;font-family:var(--mono);font-size:.62rem;color:var(--teal);letter-spacing:.1em}
.in span{display:block;font-size:.83rem;margin-top:.2rem;line-height:1.35}
.clause-note{margin-top:1.25rem;font-size:.87rem;color:var(--ink-soft);max-width:64ch}

/* two audience tracks */
.tracks{display:grid;grid-template-columns:1fr 1fr;gap:1px;margin-top:1.9rem;
  background:var(--rule);border:1px solid var(--rule)}
@media(max-width:880px){.tracks{grid-template-columns:1fr}}
.tk{background:var(--panel);padding:1.35rem}
.tk .who{font-family:var(--mono);font-size:.62rem;letter-spacing:.12em;text-transform:uppercase;
  color:var(--teal-ink);background:var(--teal);padding:.16rem .45rem;display:inline-block}
.tk h3{font-size:1.08rem;font-weight:600;margin:.85rem 0 .9rem;letter-spacing:-.015em;line-height:1.3}
.tk ol{margin:0;padding:0;list-style:none;counter-reset:s}
.tk li{counter-increment:s;position:relative;padding:.6rem 0 .6rem 2.1rem;
  border-top:1px solid var(--rule-soft);font-size:.86rem;color:var(--ink-soft)}
.tk li:first-child{border-top:0}
.tk li::before{content:counter(s,decimal-leading-zero);position:absolute;left:0;top:.62rem;
  font-family:var(--mono);font-size:.7rem;color:var(--teal)}
.tk li b{color:var(--ink);font-weight:600;font-family:var(--mono);font-size:.82rem;display:block;margin-bottom:.15rem}

/* pricing */
.tiers{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;margin-top:1.9rem;
  background:var(--rule);border:1px solid var(--rule)}
@media(max-width:880px){.tiers{grid-template-columns:1fr}}
.tier{background:var(--panel);padding:1.35rem;display:flex;flex-direction:column}
.tier.mark{box-shadow:inset 0 3px 0 var(--teal)}
.tierhead{display:flex;justify-content:space-between;align-items:baseline;gap:.75rem}
.tier h3{font-size:1rem;font-weight:600;margin:0;letter-spacing:-.01em}
.tier .amt{font-family:var(--mono);font-size:1.9rem;font-weight:700;letter-spacing:-.04em;margin:.75rem 0 .1rem;line-height:1}
.tier .note{font-family:var(--mono);font-size:.68rem;color:var(--ink-soft)}
.tier ul{list-style:none;margin:1.05rem 0 1.35rem;padding:0;display:grid;gap:.45rem}
.tier li{font-size:.845rem;color:var(--ink-soft);padding-left:1.1rem;position:relative}
.tier li::before{content:"+";position:absolute;left:0;color:var(--teal);font-family:var(--mono);font-size:.8rem}
.tier .btn{margin-top:auto}

/* final call */
.final{border-block:1px solid var(--rule);padding-block:clamp(2.25rem,5vw,3.25rem)}
.finalcmd{margin-top:1.5rem;background:var(--plate);color:var(--plate-ink);
  font-family:var(--mono);font-size:.85rem;padding:.9rem 1.1rem;display:inline-block;
  overflow-x:auto;max-width:100%}`
}

export function landingHtml(): string {
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'WebSite', name: 'api.qa', url: 'https://api.qa', description: `External third-party verifier for agent-first APIs — ${JUDGED}.` },
      {
        '@type': 'DefinedTerm',
        name: 'Agent eXperience (AX)',
        description: `${TAGLINE} The quality of a service as experienced by AI agents: discoverable machine surfaces, keyless first value, hard-ceiling 402 offers, and attestable behavior. Made normative by ${AXP_ANCHOR}.`,
        inDefinedTermSet: { '@type': 'DefinedTermSet', name: 'api.qa AX score', url: 'https://api.qa' },
      },
    ],
  }

  const hero = `<div class="pad hero">
    <a class="ann" href="https://apis.ax/axp"><i></i><b>Thesis</b><span class="full">${esc(TAGLINE)}</span><span class="short">${esc(TAGLINE_SHORT)}</span></a>
    <h1>An agent won’t integrate an API it can’t <em>trust</em></h1>
    <p class="lede">A principal can’t prove their API works for agents by asserting it. api.qa grades a domain from its own published contracts, deterministically, and signs the verdict — ${esc(JUDGED)}.</p>
    <div class="actions">
      <a class="btn btn-solid" href="/self">Run a verification</a>
      <a class="btn btn-ghost" href="/llms.txt">Read the design</a>
    </div>
    <div class="trust">
      <span>${esc(JUDGED)}</span><span>deterministic, seeded, replayable</span><span>keyless first value</span>
    </div>

    <div class="well"><div class="windows">
      <div class="cell">
        <div class="cardhead"><span class="mono">api.qa/auto.dev</span><span class="stamp">Specimen</span></div>
        <div class="gradeline">
          <div class="grade">A+</div>
          <div class="score"><b>10<span>/10</span></b><span>AX score &middot; remote mode</span></div>
        </div>
        <div class="meter" role="img" aria-label="AX score: 10 of 10 checks passed">${'<i></i>'.repeat(10)}</div>
        <div class="facts">
          <div>attestation <b>Ed25519</b> &middot; verifier <b>v0.1.0</b></div>
          <div>evidence <b>ab1dcb44a00e217d98&hellip;</b></div>
          <div>seed <b>1804815020</b> &middot; replayable</div>
        </div>
      </div>
      <div class="cell cell--term"><div class="term">
        <div class="termbar"><i></i><i></i><i></i><span>curl api.qa/auto.dev</span></div>
        <div class="termbody" tabindex="0"><pre><span class="c-dim">$</span> curl https://api.qa/auto.dev

<span class="c-acc"># api.qa report — auto.dev</span>

<span class="c-dim">&gt;</span> <span class="c-acc">Grade A+</span> &middot; AX <span class="c-acc">10/10</span> &middot; remote &middot; attested

${AX_ITEMS.map(([n, d]) => `  <span class="c-pass">PASS</span>  ${esc(n)} — ${esc(d)}`).join('\n')}

<span class="c-dim">honesty caps ......... none triggered
evidence ............. 11 exchanges
re-judge ............. exit 0</span></pre></div>
      </div></div>
    </div></div>
  </div>`

  const stats = `<div class="stats">${STATS.map(([n, d]) => `<div class="stat"><b>${esc(n)}</b><span>${esc(d)}</span></div>`).join('')}</div>`

  const mechanisms = `<section class="pad sec" id="how">
    <p class="eyebrow">How it works</p>
    <h2 style="margin-top:.9rem">A fitness function held outside the fleet’s write access</h2>
    <p class="seclede">Six mechanisms. Each is labelled with the attack from the threat model it exists to defeat — the number is the attack, not a sequence.</p>
    <div class="mech">${FEATURES.map(([a, t, d]) => `<article class="m"><div class="att">Defeats attack ${esc(a)}</div><h3>${esc(t)}</h3><p>${esc(d)}</p></article>`).join('')}</div>
  </section>`

  const checklist = `<section class="pad sec" id="checklist">
    <p class="eyebrow">The AX score</p>
    <h2 style="margin-top:.9rem">Ten binary checks. One letter grade.</h2>
    <p class="seclede">Each item is derived from the target’s own published surfaces and scored 0 or 1, over the machine surfaces made normative by <a href="https://apis.ax/axp" style="color:var(--teal)">${esc(AXP_ANCHOR)}</a>.</p>
    <div class="rows">
      ${AX_ITEMS.map(([n, d], i) => `<div class="row"><div class="n">${String(i + 1).padStart(2, '0')}</div><div><b>${esc(n)}</b> <span class="d">${esc(d)}</span></div><span class="chip pass">Scores</span></div>`).join('')}
      <div class="cap"><b>Honesty caps:</b> schema-conformance and claims-honesty do not add points. Either failing caps the grade at C, because a lying surface is worse than a missing one.</div>
    </div>
    <div class="clause">
      <div class="clause-h"><span>Clause &mdash; the core invariant</span><span>Non-negotiable</span></div>
      <div class="clause-b">
        <q>A verdict is a pure function of five inputs. <em>None of them is yours to write.</em></q>
        <div class="inputs">${INVARIANT_INPUTS.map(([n, t]) => `<div class="in"><b>${esc(n)}</b><span>${esc(t)}</span></div>`).join('')}</div>
        <p class="clause-note">The villain is ${esc(VILLAIN)}. A fleet that would rather game the grade than fix the product finds the tests held outside its write access.</p>
      </div>
    </div>
  </section>`

  const tracks = `<section class="pad sec">
    <p class="eyebrow">Two heroes, one motion</p>
    <h2 style="margin-top:.9rem">Read the grade, or make it your definition of done</h2>
    <div class="tracks">
      <div class="tk">
        <span class="who">B2A &middot; the agent</span>
        <h3>Zero-shot: read the grade, enforce the gate</h3>
        <ol>
          <li><b>curl https://api.qa/{domain}</b>Pull the grade, AX score, per-check FAILs and the evidence bundle. No key, no account.</li>
          <li><b>accept: application/json</b>Read <code>grade</code> and <code>attested</code>, and integrate only on a verdict that clears your bar.</li>
          <li><b>npx autonomous-qa rejudge</b>Re-judge the verdict yourself and carry proof any third party can re-check offline.</li>
        </ol>
      </div>
      <div class="tk">
        <span class="who">B2A2D &middot; the orchestrator</span>
        <h3>An acceptance gate the workers cannot touch</h3>
        <ol>
          <li><b>spec-digest golden.spec.json</b>Mint the pin once. The ratified digest lives with you, never in the workers’ repos.</li>
          <li><b>verify --expect-digest &lt;pin&gt;</b>Hill-climb locally until exit 0. Advisory; local runs never sign.</li>
          <li><b>POST /verify</b>Done is <code>${esc(ADMISSION)}</code>, from a service the fleet cannot write to.</li>
        </ol>
      </div>
    </div>
  </section>`

  const pricing = `<section class="pad sec" id="pricing">
    <p class="eyebrow">Pricing</p>
    <h2 style="margin-top:.9rem">Public verification is free. You pay for durable evidence.</h2>
    <p class="seclede">The public grade runs unauthenticated, because a gate on the free grade would contradict the thesis. Money enters only at the boundaries, as machine-settleable 402 offers.</p>
    <div class="tiers">
      ${PRICING.map(
        (t) => `<div class="tier${t.featured ? ' mark' : ''}">
        <div class="tierhead"><h3>${esc(t.name)}</h3>${t.featured ? '<span class="stamp">Most portable</span>' : ''}</div>
        <div class="amt">${esc(t.price)}</div><div class="note">${esc(t.note)}</div>
        <ul>${t.features.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
        <a class="btn ${t.featured ? 'btn-solid' : 'btn-ghost'}" href="${t.href}">${esc(t.cta)}</a>
      </div>`,
      ).join('')}
    </div>
  </section>`

  const final = `<div class="pad final">
    <p class="eyebrow">The stakes</p>
    <h2 style="margin-top:.9rem">Attack the product, not the verifier</h2>
    <p class="seclede">Fail, and the agent-first web routes around you: to agents you are invisible, to wallets you are unbounded risk. Pass, and an agent that has never seen you discovers, understands, and pays you on first contact.</p>
    <div class="finalcmd">curl https://api.qa/your-api.com</div>
  </div>`

  const extraCss = `${landingCss()}
.ann .short{display:none}
@media(max-width:640px){.ann .full{display:none}.ann .short{display:inline}}`

  return shell({
    title: 'api.qa · the verifier your fleet cannot edit',
    description: `The external third-party verifier for agent-first APIs — ${JUDGED}. Deterministic, Ed25519-signed verdicts that bind to a ratified digest.`,
    jsonLd,
    extraCss,
    body: `<div class="sheet">${navHtml('landing')}<div class="hatch"></div>${hero}<div class="hatch"></div>${stats}${mechanisms}<div class="hatch"></div>${checklist}<div class="hatch"></div>${tracks}<div class="hatch"></div>${pricing}${final}${footHtml()}</div>`,
  })
}

// ---------------------------------------------------------------------------
// Report page — the grade as a credential
// ---------------------------------------------------------------------------

const GRADE_COLOR: Record<Grade, string> = {
  'A+': 'var(--grade-aplus)',
  A: 'var(--grade-a)',
  B: 'var(--grade-b)',
  C: 'var(--grade-c)',
  D: 'var(--grade-d)',
  F: 'var(--grade-f)',
}

const VERDICT_LABEL: Record<Verdict, string> = { pass: 'PASS', fail: 'FAIL', skip: 'skip' }

/**
 * Severity rank for the AX meter: earned, then not-applicable, then failed.
 * Only `pass` scores a point, so the meter is a gauge of points earned — and a
 * gauge reads left-to-right filled-then-empty.
 */
const METER_RANK: Record<Verdict, number> = { pass: 0, skip: 1, fail: 2 }

/**
 * Order the meter segments green → grey → red.
 *
 * The source order (grade.ts `axScoreOf`) is checklist order 1..10, which is
 * correct for the TABLE — the table is a list of ten named checks and its rows
 * must line up with the checklist on the landing page. It is wrong for the
 * METER, which is not a list: it is a single gauge of "how many of ten". In
 * checklist order a fail at item 3 puts red in the middle of the strip and the
 * bar reads as scattered noise instead of a score.
 *
 * Sorting is stable within a rank, so checklist order is preserved inside each
 * group and the mapping stays legible on hover.
 *
 * Returns a NEW array. `r.axScore.items` is serialized into the JSON report and
 * signed over, so sorting it in place would alter attested output.
 */
export function meterSegments(items: VerificationReport['axScore']['items']): VerificationReport['axScore']['items'] {
  return [...items].sort((a, b) => METER_RANK[a.verdict] - METER_RANK[b.verdict])
}

function reportCss(): string {
  return `
.rep-hero{padding-block:clamp(1.75rem,4.5vw,3rem)}
.rep-crumb{font-family:var(--mono);font-size:.76rem;color:var(--ink-soft);margin-bottom:1rem}
.rep-crumb a{color:var(--teal)}
.rep-crumb a:hover{text-decoration:underline}
/* the credential sits on the same instrument field as the landing hero */
.rep-field{padding:clamp(.85rem,2.4vw,1.6rem);
  background-color:var(--field-b);
  background-image:
    url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='180' height='180' filter='url(%23n)'/%3E%3C/svg%3E"),
    radial-gradient(120% 130% at 12% -10%, var(--field-a), transparent 58%),
    radial-gradient(110% 120% at 92% 108%, var(--field-c), transparent 62%),
    linear-gradient(128deg, var(--field-a) 0%, var(--field-b) 48%, var(--field-c) 100%);
  background-blend-mode:soft-light,normal,normal,normal;
  background-size:180px 180px,auto,auto,auto}
.rep-card{background:var(--window-bg);padding:clamp(1.25rem,3.5vw,2rem);
  -webkit-backdrop-filter:blur(7px);backdrop-filter:blur(7px)}
.rep-main{display:grid;grid-template-columns:auto 1fr;gap:1.9rem;align-items:center}
@media(max-width:640px){.rep-main{grid-template-columns:1fr;text-align:center;justify-items:center}}
.bigseal{--gc:var(--pass);font-family:var(--mono);font-weight:700;
  font-size:clamp(3.25rem,11vw,5rem);line-height:.82;letter-spacing:-.06em;color:var(--gc)}
.rep-host{font-family:var(--mono);font-size:1rem;color:var(--ink-soft)}
.rep-score{font-family:var(--mono);font-size:2.1rem;font-weight:700;letter-spacing:-.04em;margin:.2rem 0 0;line-height:1}
.rep-score span{font-size:1rem;font-weight:500;color:var(--ink-soft)}
.rep-badges{display:flex;flex-wrap:wrap;gap:.5rem;margin-top:.75rem;align-items:center}
.rep-meter{display:grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:3px;margin-top:1.25rem}
.rep-meter i{height:9px;background:color-mix(in srgb,var(--ink) 18%,transparent)}
.rep-meter i.pass{background:var(--pass)}
.rep-meter i.fail{background:var(--fail)}
.rep-facts{display:flex;flex-wrap:wrap;gap:.35rem 1.4rem;margin-top:1.25rem;padding-top:1.1rem;
  border-top:1px dashed color-mix(in srgb,var(--ink) 25%,transparent);
  font-family:var(--mono);font-size:.72rem;color:var(--ink-soft)}
.rep-facts b{color:var(--ink);font-weight:600}
.note{border:1px solid color-mix(in srgb,var(--fail) 40%,transparent);background:var(--fail-soft);
  color:var(--fail);padding:.85rem 1.15rem;font-size:.88rem;margin-top:1.25rem}

table.ax{width:100%;border-collapse:collapse;margin-top:1.75rem;background:var(--panel);
  border:1px solid var(--rule)}
table.ax th{text-align:left;font-family:var(--mono);font-size:.62rem;letter-spacing:.14em;
  text-transform:uppercase;color:var(--ink-soft);font-weight:700;padding:.7rem 1rem;
  border-bottom:1px solid var(--rule)}
table.ax td{padding:.62rem 1rem;border-top:1px solid var(--rule-soft);font-size:.9rem;vertical-align:middle}
table.ax tbody tr:first-child td{border-top:0}
table.ax td.n{font-family:var(--mono);font-size:.72rem;color:var(--ink-soft);width:2.6rem;text-align:right}
table.ax td.v{text-align:right;width:6rem}
/* the report table had no mobile rule at all: fixed columns ate 42% of a 375px
   viewport, and overflow:hidden left no escape */
@media(max-width:560px){
  table.ax td.n{width:2rem;padding-inline:.6rem}
  table.ax td.v{width:auto}
  table.ax td,table.ax th{padding-inline:.6rem}
}

.checks{margin-top:1.75rem;border:1px solid var(--rule);background:var(--panel)}
.chk{padding:.95rem clamp(.8rem,2.5vw,1.2rem);border-top:1px solid var(--rule-soft)}
.chk:first-child{border-top:0}
/* A wash of red reads as a highlighter mark, which is the wrong idiom for a
   ruled certificate. The FAIL chip already carries the signal at the head of
   every row, so the row only needs a whisper of warmth behind it. */
.chk.fail{background:color-mix(in srgb,var(--fail-soft) 20%,var(--panel))}
.chk-h{display:flex;align-items:center;gap:.7rem;flex-wrap:wrap}
.chk-h .t{font-weight:600;font-size:.95rem}
.chk-h code{font-family:var(--mono);font-size:.72rem;color:var(--ink-soft);
  background:color-mix(in srgb,var(--ink) 7%,transparent);padding:.1rem .4rem}
.chk p{color:var(--ink-soft);font-size:.88rem;margin-top:.5rem;line-height:1.6;max-width:104ch}

.attest{margin-top:1.75rem;border:1px solid var(--rule);background:var(--panel);padding:clamp(1.1rem,3vw,1.4rem)}
.attest dl{display:grid;grid-template-columns:9rem 1fr;gap:.55rem 1rem;margin:0;font-size:.82rem}
@media(max-width:560px){.attest dl{grid-template-columns:1fr;gap:.15rem}
  .attest dd{margin-bottom:.7rem}}
.attest dt{color:var(--ink-soft);font-weight:500}
.attest dd{margin:0;font-family:var(--mono);font-size:.76rem;word-break:break-all;color:var(--ink)}

/* A grade report is a document people file. Without a light reset a dark-mode
   reader prints near-white on white; without print-color-adjust the meter, the
   failed-row tint and the code block all print invisible. */
@media print{
  .navwrap,footer,.hatch{display:none}
  .sheet{border:0;max-width:none}
  :root{
    --paper:#fff; --panel:#fff; --ink:#111; --ink-soft:#444; --rule:#bbb; --rule-soft:#ddd;
    --window-bg:#fff; --term-bg:#111; --field-a:#fff; --field-b:#fff; --field-c:#fff;
  }
  .rep-field{background:none;padding:0}
  .rep-card{backdrop-filter:none;padding:0}
  .rep-meter i,.chip,.chk.fail,.note,.finalcmd,.termbody,.bigseal{
    -webkit-print-color-adjust:exact;print-color-adjust:exact}
  .chk,.attest,.rep-card,table.ax tr{break-inside:avoid}
  .rep-sec{padding-block:1rem}
  a[href^="http"]::after{content:" (" attr(href) ")";font-size:.7em;color:#555}
}`
}

export function reportPageHtml(r: VerificationReport): string {
  const host = r.target.replace(/^https?:\/\//, '')
  const gc = GRADE_COLOR[r.grade]
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'ClaimReview',
    url: `https://api.qa/${host}`,
    claimReviewed: `${host} is an agent-first API`,
    reviewRating: { '@type': 'Rating', ratingValue: r.axScore.points, bestRating: 10, worstRating: 0, alternateName: r.grade },
    author: { '@type': 'Organization', name: 'api.qa', url: 'https://api.qa' },
    datePublished: r.verifiedAt,
  }

  const meter = meterSegments(r.axScore.items)
    .map((i) => `<i class="${i.verdict === 'pass' ? 'pass' : i.verdict === 'fail' ? 'fail' : ''}" title="${esc(i.title)}: ${VERDICT_LABEL[i.verdict]}"></i>`)
    .join('')
  const failed = r.axScore.items.filter((i) => i.verdict === 'fail').length
  const skipped = r.axScore.items.filter((i) => i.verdict === 'skip').length
  // The per-segment title is hover-only, so the counts have to live on the
  // label or a keyboard/screen-reader user gets a bar with no reading.
  const meterLabel = `AX score: ${r.axScore.points} of 10 passed`
    + (failed ? `, ${failed} failed` : '')
    + (skipped ? `, ${skipped} not applicable` : '')

  const attBadge = r.attested
    ? `<span class="chip pass">${sealSvg()} Ed25519 attested</span>`
    : `<span class="chip warn">advisory &middot; unsigned</span>`

  const hero = `<div class="pad rep-hero">
    <div class="rep-crumb"><a href="/">api.qa</a> / ${esc(host)}</div>
    <div class="rep-field"><div class="rep-card">
      <div class="rep-main">
        <div class="bigseal" style="--gc:${gc}">${esc(r.grade)}</div>
        <div>
          <div class="rep-host">${esc(host)}</div>
          <div class="rep-score">${r.axScore.points}<span>/10 AX score</span></div>
          <div class="rep-badges">
            <span class="chip skip">${esc(r.mode)} mode</span>
            ${attBadge}
            <span class="chip skip">verifier v${esc(r.verifierVersion)}</span>
          </div>
        </div>
      </div>
      <div class="rep-meter" role="img" aria-label="${esc(meterLabel)}">${meter}</div>
      <div class="rep-facts">
        <span>verified <b>${esc(r.verifiedAt)}</b></span>
        <span>seed <b>${r.seed}</b> (replayable)</span>
        <span>evidence <b>${esc(r.discovery.evidenceDigest.slice(0, 18))}&hellip;</b></span>
      </div>
    </div></div>
    ${r.gradeNotes.map((n) => `<div class="note">${esc(n)}</div>`).join('')}
  </div>`

  const axTable = `<section class="pad sec rep-sec">
    <p class="eyebrow">The 10-point checklist</p>
    <h2 style="margin-top:.9rem;font-size:clamp(1.25rem,2.8vw,1.6rem)">Derived from ${esc(host)}’s own published surfaces</h2>
    <table class="ax"><thead><tr><th>#</th><th>Check</th><th style="text-align:right">Verdict</th></tr></thead><tbody>
    ${r.axScore.items.map((i) => `<tr><td class="n">${String(i.item).padStart(2, '0')}</td><td>${esc(i.title)}</td><td class="v"><span class="chip ${i.verdict}">${VERDICT_LABEL[i.verdict]}</span></td></tr>`).join('')}
    </tbody></table>
  </section>`

  const details = `<section class="pad sec rep-sec">
    <p class="eyebrow">Check details</p>
    <h2 style="margin-top:.9rem;font-size:clamp(1.25rem,2.8vw,1.6rem)">Every verdict references the evidence it was judged from</h2>
    <div class="checks">
    ${r.checks
      .map(
        (c) => `<article class="chk ${c.verdict}">
        <div class="chk-h"><span class="chip ${c.verdict}">${VERDICT_LABEL[c.verdict]}</span><span class="t">${esc(c.title)}</span><code>${esc(c.id)}</code></div>
        <p>${esc(c.detail)}</p>
      </article>`,
      )
      .join('')}
    </div>
  </section>`

  const attRows = r.attestation
    ? `<dt>Algorithm</dt><dd>${esc(r.attestation.alg)}</dd>
       <dt>Report digest</dt><dd>${esc(r.attestation.reportDigest)}</dd>
       <dt>Public key</dt><dd>${esc(r.attestation.publicKey)}</dd>
       <dt>Signature</dt><dd>${esc(r.attestation.signature)}</dd>
       <dt>Evidence bundle</dt><dd>${r.evidence.items.length} recorded exchanges &middot; ${esc(r.discovery.evidenceDigest)}</dd>`
    : `<dt>Evidence bundle</dt><dd>${r.evidence.items.length} recorded exchanges &middot; ${esc(r.discovery.evidenceDigest)}</dd>`

  const att = `<section class="pad sec rep-sec">
    <p class="eyebrow">Attestation &amp; evidence</p>
    <h2 style="margin-top:.9rem;font-size:clamp(1.25rem,2.8vw,1.6rem)">${r.attestation ? 'Signed over the canonical report digest' : `A ${esc(r.mode)}-mode report: advisory and unsigned by construction`}</h2>
    <div class="attest"><dl>${attRows}</dl></div>
  </section>`

  const repro = `<section class="pad sec rep-sec">
    <p class="eyebrow">Verify this yourself</p>
    <h2 style="margin-top:.9rem;font-size:clamp(1.25rem,2.8vw,1.6rem)">Judging is a pure function of the embedded evidence</h2>
    <p class="seclede">Re-run the checks over the bundle and you must get this same grade, or the report is forged or the verifier version changed.</p>
    <div class="finalcmd">curl -H 'accept: application/json' https://api.qa/${esc(host)} | npx autonomous-qa rejudge</div>
  </section>`

  return shell({
    title: `api.qa/${host} · Grade ${r.grade}`,
    description: `${host} scored ${r.grade} (AX ${r.axScore.points}/10) on api.qa, the external verifier for agent-first APIs — ${JUDGED}. ${r.attested ? 'Ed25519-attested' : 'Advisory'} verdict.`,
    jsonLd,
    extraCss: landingCss() + reportCss(),
    body: `<div class="sheet">${navHtml('report')}<div class="hatch"></div>${hero}<div class="hatch"></div>${axTable}${details}${att}${repro}${footHtml()}</div>`,
  })
}
