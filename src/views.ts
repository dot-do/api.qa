/**
 * Browser-facing views — the polished HTML mounts of api.qa.
 *
 * WHY this is a self-contained string layer and not React SSR of `@mdxui/neo`:
 * this is a Cloudflare Worker built with plain `tsc` + wrangler/esbuild, with no
 * React runtime, no Tailwind pipeline, and a hard bundle-size budget on a LIVE
 * deployed verifier. Fully server-rendering neo would drag in react-dom/server,
 * framer-motion, shiki, radix, and the `workspace:*` mdxui packages — a large,
 * risky dependency for a service whose whole value is being unbluffably correct.
 *
 * Instead we mirror the startup-sites approach at the worker's constraint level:
 * a payload rendered into a polished page through a design-system **dialect**.
 * The token vocabulary here (`--background`/`--foreground`/`--primary`/`--muted`
 * /`--border`/radius/shadows, OKLCH throughout) is ported verbatim from
 * `@mdxui/themes`, and the section grammar (Navbar, HeroCenterAnnouncement,
 * Stats trust strip, FeaturesGrid, PricingPlansBordered, CtaCenteredCheck,
 * FooterSmall) is neo's. So we reuse neo's design system rather than inventing a
 * new one; we just emit it as dependency-free HTML.
 *
 * DESIGN.md purity boundary: presentation lives here and in render.ts, never in
 * the pure judge. These functions read a finished report; they never observe or
 * grade. Same report in → same HTML out.
 */

import type { VerificationReport, Grade, Verdict } from './types.js'

export function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ---------------------------------------------------------------------------
// The dialect — @mdxui/themes tokens, retuned to api.qa's green→cyan identity.
// Light "lab paper" is the default (a verdict is a credential you cite in
// daylight); a dark variant rides prefers-color-scheme for night reading.
// ---------------------------------------------------------------------------

function tokensCss(): string {
  return `
:root{
  --background: oklch(0.988 0.006 175);
  --foreground: oklch(0.205 0.021 210);
  --card: oklch(0.998 0.004 175);
  --card-foreground: oklch(0.205 0.021 210);
  --muted: oklch(0.958 0.010 185);
  --muted-foreground: oklch(0.470 0.020 200);
  --primary: oklch(0.560 0.118 185);
  --primary-foreground: oklch(0.992 0.006 180);
  --accent: oklch(0.700 0.110 205);
  --accent-foreground: oklch(0.205 0.021 210);
  --border: oklch(0.905 0.013 190);
  --input: oklch(0.945 0.010 190);
  --ring: oklch(0.560 0.118 185);
  --pass: oklch(0.560 0.140 158);
  --pass-soft: oklch(0.945 0.045 158);
  --fail: oklch(0.560 0.198 27);
  --fail-soft: oklch(0.950 0.045 27);
  --skip: oklch(0.640 0.018 200);
  --warn: oklch(0.700 0.150 75);
  --code-bg: oklch(0.190 0.024 220);
  --code-fg: oklch(0.910 0.014 190);
  --glow-a: oklch(0.720 0.130 175 / 0.30);
  --glow-b: oklch(0.700 0.120 205 / 0.24);
  --radius: 0.7rem;
  --shadow-sm: 0 1px 2px oklch(0.30 0.02 210 / 0.06), 0 1px 3px oklch(0.30 0.02 210 / 0.05);
  --shadow-md: 0 4px 12px oklch(0.30 0.02 210 / 0.08), 0 2px 4px oklch(0.30 0.02 210 / 0.05);
  --shadow-lg: 0 18px 40px oklch(0.30 0.02 210 / 0.12), 0 6px 12px oklch(0.30 0.02 210 / 0.06);
  --font-sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  --font-mono: 'JetBrains Mono', ui-monospace, 'SF Mono', 'Cascadia Code', Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark){
  :root{
    --background: oklch(0.165 0.021 220);
    --foreground: oklch(0.935 0.012 185);
    --card: oklch(0.202 0.024 220);
    --card-foreground: oklch(0.935 0.012 185);
    --muted: oklch(0.235 0.024 218);
    --muted-foreground: oklch(0.660 0.022 195);
    --primary: oklch(0.735 0.130 178);
    --primary-foreground: oklch(0.165 0.021 220);
    --accent: oklch(0.760 0.110 205);
    --accent-foreground: oklch(0.165 0.021 220);
    --border: oklch(0.290 0.022 218);
    --input: oklch(0.270 0.022 218);
    --ring: oklch(0.735 0.130 178);
    --pass: oklch(0.720 0.150 158);
    --pass-soft: oklch(0.290 0.055 158);
    --fail: oklch(0.680 0.190 27);
    --fail-soft: oklch(0.300 0.070 27);
    --skip: oklch(0.600 0.020 200);
    --warn: oklch(0.770 0.150 75);
    --code-bg: oklch(0.135 0.020 222);
    --code-fg: oklch(0.900 0.016 190);
    --glow-a: oklch(0.680 0.140 175 / 0.26);
    --glow-b: oklch(0.640 0.130 205 / 0.20);
    --shadow-sm: 0 1px 2px oklch(0.05 0.01 220 / 0.5);
    --shadow-md: 0 4px 14px oklch(0.05 0.01 220 / 0.5);
    --shadow-lg: 0 20px 46px oklch(0.05 0.01 220 / 0.6);
  }
}`
}

function baseCss(): string {
  return `
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  margin:0;font-family:var(--font-sans);
  background:var(--background);color:var(--foreground);
  line-height:1.6;letter-spacing:-0.011em;
  -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;
}
h1,h2,h3{line-height:1.08;letter-spacing:-0.03em;font-weight:700;margin:0}
p{margin:0}
a{color:inherit;text-decoration:none}
code,pre,.mono{font-family:var(--font-mono);font-feature-settings:'liga' 0}
.wrap{max-width:72rem;margin:0 auto;padding:0 1.5rem}
.eyebrow{font-size:.74rem;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:var(--primary)}
.lede{color:var(--muted-foreground);font-size:1.075rem;line-height:1.65}

/* buttons */
.btn{display:inline-flex;align-items:center;gap:.5rem;font-weight:600;font-size:.94rem;
  padding:.62rem 1.05rem;border-radius:calc(var(--radius) - .15rem);border:1px solid transparent;
  cursor:pointer;transition:transform .18s cubic-bezier(.2,.8,.2,1),background .18s,border-color .18s,box-shadow .18s}
.btn-primary{background:var(--primary);color:var(--primary-foreground);box-shadow:var(--shadow-sm)}
.btn-primary:hover{transform:translateY(-1px);box-shadow:var(--shadow-md)}
.btn-ghost{background:transparent;color:var(--foreground);border-color:var(--border)}
.btn-ghost:hover{background:var(--muted)}

/* nav */
.nav{position:sticky;top:0;z-index:40;backdrop-filter:saturate(1.4) blur(10px);
  background:color-mix(in oklch,var(--background) 82%,transparent);border-bottom:1px solid var(--border)}
.nav-in{display:flex;align-items:center;gap:1.5rem;height:60px}
.brand{display:inline-flex;align-items:center;gap:.5rem;font-weight:700;font-size:1.02rem;letter-spacing:-0.02em}
.brand .seal{width:20px;height:20px;flex:none}
.nav-links{display:flex;gap:1.4rem;margin-left:.5rem}
.nav-links a{color:var(--muted-foreground);font-size:.9rem;font-weight:500}
.nav-links a:hover{color:var(--foreground)}
.nav-cta{margin-left:auto;display:flex;align-items:center;gap:.75rem}
@media(max-width:720px){.nav-links{display:none}}

/* section rhythm — deliberately uneven, not uniform padding */
.section{padding:5.5rem 0}
.section-tight{padding:3.5rem 0}
.section h2{font-size:clamp(1.7rem,3.6vw,2.5rem)}
.center{text-align:center;max-width:42rem;margin:0 auto}

/* footer */
.foot{border-top:1px solid var(--border);padding:3rem 0 3.5rem;color:var(--muted-foreground)}
.foot-grid{display:flex;flex-wrap:wrap;gap:2.5rem;justify-content:space-between}
.foot a{color:var(--muted-foreground);font-size:.9rem}
.foot a:hover{color:var(--foreground)}
.foot-col h4{font-size:.72rem;letter-spacing:.09em;text-transform:uppercase;color:var(--foreground);margin:0 0 .7rem}
.foot-col a{display:block;margin:.35rem 0}

/* verdict pills */
.pill{display:inline-flex;align-items:center;gap:.35rem;font-size:.74rem;font-weight:600;
  padding:.16rem .5rem;border-radius:99px;letter-spacing:.01em}
.pill.pass{background:var(--pass-soft);color:var(--pass)}
.pill.fail{background:var(--fail-soft);color:var(--fail)}
.pill.skip{background:var(--muted);color:var(--skip)}

pre.code{background:var(--code-bg);color:var(--code-fg);padding:1rem 1.15rem;border-radius:var(--radius);
  overflow-x:auto;font-size:.85rem;line-height:1.7;margin:0}
.code .tok-c{color:oklch(0.62 0.02 200)}
.code .tok-k{color:oklch(0.78 0.13 175)}`
}

function fontHead(): string {
  return `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">`
}

/** The verified-seal glyph — a check inside a rounded shield. Reused in nav + hero. */
function sealSvg(cls = 'seal'): string {
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 2.5l7.5 3v5.2c0 4.6-3.1 8.4-7.5 10.3-4.4-1.9-7.5-5.7-7.5-10.3V5.5l7.5-3z" fill="var(--primary)" opacity="0.16"/><path d="M12 2.5l7.5 3v5.2c0 4.6-3.1 8.4-7.5 10.3-4.4-1.9-7.5-5.7-7.5-10.3V5.5l7.5-3z" stroke="var(--primary)" stroke-width="1.4"/><path d="M8.4 12.2l2.5 2.5 4.7-5" stroke="var(--primary)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`
}

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
${fontHead()}
<script type="application/ld+json">${JSON.stringify(opts.jsonLd)}</script>
<style>${tokensCss()}${baseCss()}${opts.extraCss ?? ''}</style>
</head>
<body>
${opts.body}
${opts.script ? `<script>${opts.script}</script>` : ''}
</body>
</html>`
}

function navHtml(active: 'landing' | 'report'): string {
  const links =
    active === 'landing'
      ? `<nav class="nav-links">
      <a href="#how">How it works</a>
      <a href="#checklist">The AX score</a>
      <a href="#pricing">Pricing</a>
      <a href="/llms.txt">Docs</a>
    </nav>`
      : `<nav class="nav-links">
      <a href="/">Home</a>
      <a href="/self">/self</a>
      <a href="/llms.txt">Docs</a>
    </nav>`
  return `<header class="nav"><div class="wrap nav-in">
    <a class="brand" href="/">${sealSvg()} api.qa</a>
    ${links}
    <div class="nav-cta">
      <a class="btn btn-ghost" href="https://github.com/dot-do/api.qa">GitHub</a>
      <a class="btn btn-primary" href="/self">Grade an API</a>
    </div>
  </div></header>`
}

function footHtml(): string {
  const year = 2026
  return `<footer class="foot"><div class="wrap foot-grid">
    <div style="max-width:22rem">
      <a class="brand" href="/">${sealSvg()} api.qa</a>
      <p style="margin-top:.7rem;font-size:.9rem;line-height:1.6">The external third-party verifier for agent-first APIs. Published as the <code>autonomous-qa</code> package.</p>
    </div>
    <div class="foot-col"><h4>Product</h4>
      <a href="#how">How it works</a><a href="#checklist">The AX score</a><a href="#pricing">Pricing</a>
    </div>
    <div class="foot-col"><h4>For agents</h4>
      <a href="/llms.txt">llms.txt</a><a href="/.well-known/agents.json">agents.json</a>
      <a href="/icp.json">icp.json</a><a href="/openapi.json">openapi.json</a>
    </div>
    <div class="foot-col"><h4>Verify</h4>
      <a href="/self">/self &middot; api.qa grades itself</a><a href="/offers/attested-run">Attested run</a>
      <a href="https://github.com/dot-do/api.qa">Source</a>
    </div>
  </div>
  <div class="wrap" style="margin-top:2rem;font-size:.82rem;opacity:.8">&copy; ${year} api.qa &middot; a verdict is a pure function of five inputs, none of them yours to write.</div>
  </footer>`
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
  ['MCP', 'interface declared with transport + tools'],
  ['Keyless flow', 'a declared endpoint answers 2xx with no key'],
  ['402 offers', 'payment boundaries are structured offers'],
  ['Linkset', 'surfaces cross-reference each other'],
  ['Attestation', 'identity / attestation ladder declared'],
]

const FEATURES: Array<[string, string]> = [
  ['Derived at run time', 'Checks are computed from the target’s own published surfaces: llms.txt, agents.json, icp.json, OpenAPI, MCP, 402 offers. There are zero repo-local test files to rewrite until green.'],
  ['Pinned-digest gate', 'Acceptance names a sha256 digest, not a file path. Supply a spec that does not hash to the expected digest and the run refuses before a single probe fires. The pin lives with the orchestrator, not the workers.'],
  ['Held-out signing key', 'Attested verdicts are Ed25519-signed by a key that lives only as a deploy secret. A fleet that owns the code still cannot mint attested history. Local runs are advisory and unsigned by construction.'],
  ['Deterministic + replayable', 'A verdict is a pure function of published contracts, observed behavior, pinned digest, seed, and verifier version. The evidence bundle is embedded, so anyone can re-judge it offline and confirm the grade reproduces.'],
  ['Seeded, no flake-mining', 'Endpoint sampling is seeded fresh per run and recorded in the report. Overfitting to one run’s probes fails the next, and the same evidence cannot re-judge to a different verdict.'],
  ['Honesty caps the grade', 'Two non-scoring checks, schema-conformance and claims-honesty, cap the grade at C when a surface lies. A lying surface scores worse than a missing one.'],
]

const PRICING: Array<{ name: string; price: string; note: string; features: string[]; cta: string; href: string; featured?: boolean }> = [
  {
    name: 'Public grade',
    price: '$0',
    note: 'keyless, forever',
    features: ['GET api.qa/{domain}: grade + AX score', 'Per-check verdicts and the punch list', 'Advisory local runs: npx autonomous-qa', 'No signup, no key'],
    cta: 'Grade an API',
    href: '/self',
  },
  {
    name: 'Attested run',
    price: '$5',
    note: 'one-time, per run',
    features: ['On-demand, Ed25519-signed verdict', 'Embedded evidence bundle, replayable offline', 'Portable proof URL that survives a handover', 'Settled as a 402 offer'],
    cta: 'Get attested',
    href: '/offers/attested-run',
    featured: true,
  },
  {
    name: 'CI webhook',
    price: '$20',
    note: 'per month',
    features: ['Re-verify on every deploy', 'Freshness gate against time-shifted state', 'Reverify-as-a-subscription', 'Grade timeline + badge (roadmap)'],
    cta: 'Subscribe',
    href: '/offers/attested-run',
  },
]

function landingCss(): string {
  return `
.hero{position:relative;overflow:hidden;padding:4.5rem 0 4rem}
.hero::before{content:'';position:absolute;inset:-30% 0 auto 0;height:60rem;z-index:0;pointer-events:none;
  background:radial-gradient(60rem 32rem at 25% 0%,var(--glow-a),transparent 60%),
             radial-gradient(52rem 30rem at 82% 8%,var(--glow-b),transparent 62%)}
.hero-grid{position:relative;z-index:1;display:grid;grid-template-columns:1.05fr .95fr;gap:3rem;align-items:center}
@media(max-width:860px){.hero-grid{grid-template-columns:1fr;gap:2.25rem}}
.announce{display:inline-flex;align-items:center;gap:.5rem;font-size:.82rem;font-weight:500;
  padding:.32rem .7rem .32rem .4rem;border-radius:99px;border:1px solid var(--border);
  background:var(--card);color:var(--muted-foreground);box-shadow:var(--shadow-sm)}
.announce b{background:var(--primary);color:var(--primary-foreground);font-size:.68rem;font-weight:700;
  padding:.12rem .42rem;border-radius:99px;letter-spacing:.02em}
.hero h1{font-size:clamp(2.3rem,5.4vw,3.5rem);margin:1.3rem 0 0;font-weight:800}
.hero h1 .hl{color:var(--primary)}
.hero .lede{margin-top:1.15rem;max-width:34rem;font-size:1.12rem}
.hero-actions{display:flex;flex-wrap:wrap;gap:.75rem;margin-top:1.6rem}
.grade-bar{margin-top:1.9rem;display:flex;align-items:stretch;max-width:33rem;
  border:1px solid var(--border);border-radius:calc(var(--radius) + .1rem);background:var(--card);
  box-shadow:var(--shadow-md);overflow:hidden}
.grade-bar .pfx{display:flex;align-items:center;padding:0 .3rem 0 .9rem;color:var(--muted-foreground);font-family:var(--font-mono);font-size:.92rem}
.grade-bar input{flex:1;border:0;background:transparent;color:var(--foreground);font-family:var(--font-mono);
  font-size:.95rem;padding:.85rem .4rem;outline:none;min-width:0}
.grade-bar button{border:0;margin:.35rem;border-radius:calc(var(--radius) - .2rem);background:var(--primary);
  color:var(--primary-foreground);font-weight:600;padding:0 1.1rem;cursor:pointer;font-size:.9rem}
.trust{margin-top:1.7rem;display:flex;flex-wrap:wrap;align-items:center;gap:.5rem 1.4rem;color:var(--muted-foreground);font-size:.82rem}
.trust span{display:inline-flex;align-items:center;gap:.4rem}
.trust .dot{width:5px;height:5px;border-radius:99px;background:var(--pass)}

/* the sample credential card shown in the hero */
.cred{position:relative;background:var(--card);border:1px solid var(--border);border-radius:calc(var(--radius) + .3rem);
  box-shadow:var(--shadow-lg);padding:1.6rem 1.7rem}
.cred-top{display:flex;align-items:center;justify-content:space-between;gap:1rem}
.cred-host{font-family:var(--font-mono);font-size:.9rem;color:var(--muted-foreground)}
.cred-mark{display:flex;align-items:center;gap:1.1rem;margin:1.1rem 0 .3rem}
.gradeseal{--gc:var(--pass);width:96px;height:96px;flex:none;border-radius:50%;display:grid;place-items:center;
  font-weight:800;font-size:2.9rem;letter-spacing:-.04em;color:var(--gc);
  background:radial-gradient(circle at 50% 42%,color-mix(in oklch,var(--gc) 16%,transparent),transparent 70%);
  border:2.5px solid var(--gc);box-shadow:0 0 0 6px color-mix(in oklch,var(--gc) 10%,transparent)}
.cred-mark .meta{font-size:.9rem}
.cred-mark .meta .big{font-size:1.5rem;font-weight:700;letter-spacing:-.02em}
.axmeter{display:flex;gap:4px;margin-top:1rem}
.axmeter i{height:7px;flex:1;border-radius:99px;background:var(--border)}
.axmeter i.on{background:var(--primary)}
.cred-foot{margin-top:1.1rem;padding-top:.95rem;border-top:1px dashed var(--border);
  font-family:var(--font-mono);font-size:.72rem;color:var(--muted-foreground);display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap}
.cred-badge{display:inline-flex;align-items:center;gap:.35rem;color:var(--pass);font-weight:600}

/* invariant band */
.invariant{background:var(--foreground);color:var(--background);border-radius:0}
.invariant .wrap{padding-top:3.2rem;padding-bottom:3.2rem}
.invariant .q{font-size:clamp(1.35rem,3vw,2rem);font-weight:600;letter-spacing:-.025em;max-width:52rem;line-height:1.32}
.invariant .q em{font-style:normal;color:var(--primary);font-weight:700}
.invariant .sub{margin-top:1rem;opacity:.72;max-width:44rem;font-size:1rem}

/* feature grid — asymmetric, not identical cards */
.feat-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1.15rem;margin-top:2.75rem}
@media(max-width:860px){.feat-grid{grid-template-columns:1fr}}
.feat{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:1.5rem;box-shadow:var(--shadow-sm)}
.feat .n{font-family:var(--font-mono);font-size:.78rem;color:var(--primary);font-weight:600}
.feat h3{font-size:1.12rem;margin:.55rem 0 .5rem}
.feat p{color:var(--muted-foreground);font-size:.94rem;line-height:1.6}

/* checklist */
.checklist{background:var(--card);border:1px solid var(--border);border-radius:calc(var(--radius) + .1rem);
  box-shadow:var(--shadow-md);overflow:hidden;margin-top:2.5rem}
.ck-row{display:grid;grid-template-columns:2.4rem 1fr auto;gap:.9rem;align-items:center;
  padding:.85rem 1.3rem;border-top:1px solid var(--border)}
.ck-row:first-child{border-top:0}
.ck-row .num{font-family:var(--font-mono);font-size:.85rem;color:var(--muted-foreground);text-align:right}
.ck-row .name{font-weight:600;font-size:.96rem}
.ck-row .desc{color:var(--muted-foreground);font-weight:400;font-size:.9rem}
.ck-cap{padding:1rem 1.3rem;background:var(--pass-soft);color:var(--pass);font-size:.9rem;font-weight:500;border-top:1px solid var(--border)}
@media(max-width:600px){.ck-row{grid-template-columns:1.8rem 1fr}.ck-row .check{display:none}}

/* how it works — two tracks */
.tracks{display:grid;grid-template-columns:1fr 1fr;gap:1.15rem;margin-top:2.5rem}
@media(max-width:820px){.tracks{grid-template-columns:1fr}}
.track{border:1px solid var(--border);border-radius:var(--radius);padding:1.6rem;background:var(--card);box-shadow:var(--shadow-sm)}
.track .tag{font-family:var(--font-mono);font-size:.72rem;font-weight:600;color:var(--accent-foreground);
  background:color-mix(in oklch,var(--accent) 24%,transparent);padding:.16rem .5rem;border-radius:99px}
.track h3{font-size:1.22rem;margin:.85rem 0 1rem}
.track ol{margin:0;padding:0;list-style:none;counter-reset:s}
.track li{counter-increment:s;position:relative;padding:.55rem 0 .55rem 2.2rem;font-size:.93rem;color:var(--muted-foreground);border-top:1px solid var(--border)}
.track li:first-child{border-top:0}
.track li::before{content:counter(s);position:absolute;left:0;top:.5rem;width:1.5rem;height:1.5rem;border-radius:50%;
  display:grid;place-items:center;font-family:var(--font-mono);font-size:.78rem;font-weight:600;
  color:var(--primary);border:1px solid var(--primary)}
.track li b{color:var(--foreground);font-weight:600}
.track code{background:var(--muted);padding:.08rem .32rem;border-radius:4px;font-size:.82rem}

/* pricing */
.price-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1.15rem;margin-top:2.75rem;align-items:start}
@media(max-width:820px){.price-grid{grid-template-columns:1fr;max-width:26rem;margin-inline:auto}}
.tier{border:1px solid var(--border);border-radius:calc(var(--radius) + .1rem);padding:1.7rem;background:var(--card);box-shadow:var(--shadow-sm)}
.tier.featured{border-color:var(--primary);box-shadow:var(--shadow-lg);position:relative}
.tier.featured::after{content:'Most portable';position:absolute;top:-.7rem;left:50%;transform:translateX(-50%);
  background:var(--primary);color:var(--primary-foreground);font-size:.68rem;font-weight:700;letter-spacing:.03em;
  padding:.2rem .6rem;border-radius:99px;text-transform:uppercase}
.tier h3{font-size:1.06rem}
.tier .amt{font-size:2.4rem;font-weight:800;letter-spacing:-.03em;margin:.5rem 0 0}
.tier .amt small{font-size:.85rem;font-weight:500;color:var(--muted-foreground);letter-spacing:0}
.tier ul{list-style:none;margin:1.25rem 0;padding:0}
.tier li{position:relative;padding:.4rem 0 .4rem 1.5rem;font-size:.9rem;color:var(--muted-foreground)}
.tier li::before{content:'';position:absolute;left:0;top:.72rem;width:.72rem;height:.42rem;
  border-left:2px solid var(--pass);border-bottom:2px solid var(--pass);transform:rotate(-45deg)}
.tier .btn{width:100%;justify-content:center}

/* final cta */
.cta-final{position:relative;overflow:hidden;border-radius:calc(var(--radius) + .4rem);
  border:1px solid var(--border);background:var(--card);padding:3.4rem 2rem;text-align:center;box-shadow:var(--shadow-md)}
.cta-final::before{content:'';position:absolute;inset:auto 0 -60% 0;height:30rem;z-index:0;
  background:radial-gradient(40rem 20rem at 50% 100%,var(--glow-a),transparent 65%)}
.cta-final > *{position:relative;z-index:1}
.cta-final h2{font-size:clamp(1.8rem,4vw,2.6rem)}`
}

export function landingHtml(): string {
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'WebSite', name: 'api.qa', url: 'https://api.qa', description: 'External third-party verifier for agent-first APIs.' },
      {
        '@type': 'DefinedTerm',
        name: 'Agent Experience (AX)',
        description:
          'The quality of a service as experienced by AI agents: discoverable machine surfaces, keyless trial flows, structured payment offers, and attestable behavior. Successor term to Developer Experience (DX).',
        inDefinedTermSet: { '@type': 'DefinedTermSet', name: 'api.qa AX score', url: 'https://api.qa' },
      },
    ],
  }

  const sampleAx = 10
  const axmeter = Array.from({ length: 10 }, (_, i) => `<i class="${i < sampleAx ? 'on' : ''}"></i>`).join('')

  const hero = `<section class="hero"><div class="wrap hero-grid">
    <div>
      <a class="announce" href="/llms.txt"><b>NEW</b> SSL Labs, but for how well an API works for agents</a>
      <h1>Green because it <span class="hl">works</span>, not because it gamed the test</h1>
      <p class="lede">api.qa/{domain} returns a letter grade (A+ to F) and a 10-point AX score computed only from a target’s own published machine surfaces. The verdict is deterministic, replayable, and Ed25519-signed, and a fleet optimizing for it cannot edit the tests, pin a friendlier spec, or forge a report.</p>
      <form class="grade-bar" onsubmit="return gradeGo(event)">
        <span class="pfx">api.qa/</span>
        <input id="g" name="g" placeholder="your-api.com" autocomplete="off" spellcheck="false" aria-label="domain to grade">
        <button type="submit">Grade &rarr;</button>
      </form>
      <div class="trust">
        <span><i class="dot"></i> 52 tests pass</span>
        <span><i class="dot"></i> self-grades 10/10 A+</span>
        <span><i class="dot"></i> keyless, no signup</span>
      </div>
    </div>
    <aside class="cred" aria-label="sample verdict">
      <div class="cred-top"><span class="cred-host">api.qa/auto.dev</span><span class="pill pass">verified</span></div>
      <div class="cred-mark">
        <div class="gradeseal" style="--gc:var(--pass)">A+</div>
        <div class="meta"><div class="big">10<span style="opacity:.5">/10</span></div><div style="color:var(--muted-foreground)">AX score &middot; remote mode</div></div>
      </div>
      <div class="axmeter">${axmeter}</div>
      <div class="cred-foot">
        <span class="cred-badge">${sealSvg('seal')} Ed25519 attested</span>
        <span>seed 4821 &middot; replayable</span>
      </div>
    </aside>
  </div></section>`

  const invariant = `<section class="invariant"><div class="wrap">
    <div class="eyebrow" style="color:var(--primary)">The core invariant</div>
    <p class="q" style="margin-top:1rem">A verdict is a pure function of published contracts, observed behavior, a pinned spec digest, a seed, and the verifier version. <em>None of those five inputs is yours to write.</em></p>
    <p class="sub">The fleet can change its behavior and its published contracts, but changing either changes the evidence digest, visibly, in the attested report. Goodhart is the adversary, and every mechanism below exists because of a specific attack on it.</p>
  </div></section>`

  const features = `<section class="section" id="how"><div class="wrap">
    <div class="center">
      <div class="eyebrow">How it works</div>
      <h2 style="margin-top:.6rem">A fitness function held outside the fleet’s write access</h2>
      <p class="lede" style="margin-top:.8rem">The anti-cheat core already works. Six mechanisms, each answering a named way a hill-climbing fleet would rather beat the test than fix the product.</p>
    </div>
    <div class="feat-grid">
      ${FEATURES.map(([t, d], i) => `<article class="feat"><div class="n">0${i + 1}</div><h3>${esc(t)}</h3><p>${esc(d)}</p></article>`).join('')}
    </div>
  </div></section>`

  const checklist = `<section class="section-tight" id="checklist"><div class="wrap">
    <div class="center">
      <div class="eyebrow">The AX score</div>
      <h2 style="margin-top:.6rem">Ten binary checks. One letter grade.</h2>
      <p class="lede" style="margin-top:.8rem">Each item is derived from the target’s own published surfaces and scored 0 or 1. Two honesty checks sit outside the score and cap the grade when a surface lies.</p>
    </div>
    <div class="checklist">
      ${AX_ITEMS.map(([name, desc], i) => `<div class="ck-row"><div class="num">${i + 1}</div><div><span class="name">${esc(name)}</span> <span class="desc">${esc(desc)}</span></div><div class="check pill pass">scores</div></div>`).join('')}
      <div class="ck-cap">Honesty caps: schema-conformance and claims-honesty do not add points. Either failing caps the grade at C, because a lying surface is worse than a missing one.</div>
    </div>
  </div></section>`

  const tracks = `<section class="section"><div class="wrap">
    <div class="center">
      <div class="eyebrow">Two heroes, one motion</div>
      <h2 style="margin-top:.6rem">Read the grade, or make it your definition of done</h2>
    </div>
    <div class="tracks">
      <div class="track">
        <span class="tag">B2A &middot; the agent</span>
        <h3>Read the grade, act on it</h3>
        <ol>
          <li><b>Read.</b> <code>GET api.qa/{domain}</code> returns the grade, AX score, per-check FAILs (the punch list), and the evidence bundle.</li>
          <li><b>Act.</b> Fix the named FAILs, or use another target’s grade to decide whether to integrate.</li>
          <li><b>Carry the proof.</b> An attested report URL is portable evidence any third party can re-judge offline.</li>
        </ol>
      </div>
      <div class="track">
        <span class="tag">B2A2D &middot; the fleet orchestrator</span>
        <h3>An acceptance gate the workers cannot touch</h3>
        <ol>
          <li><b>Ratify + pin.</b> Write the golden scenario as a PinnedSpec; mint its sha256 digest once. The digest lives with you, never in the workers’ repos.</li>
          <li><b>Hill-climb locally.</b> Workers loop <code>npx autonomous-qa verify</code> against the pin (advisory, unsigned, fine inside the loop).</li>
          <li><b>Accept on the held-out verifier.</b> Done means <code>POST /verify</code> returns <code>passed:true</code> from a service the fleet has no write access to.</li>
        </ol>
      </div>
    </div>
  </div></section>`

  const pricing = `<section class="section-tight" id="pricing"><div class="wrap">
    <div class="center">
      <div class="eyebrow">Pricing</div>
      <h2 style="margin-top:.6rem">Public verification is free. You pay for durable evidence.</h2>
      <p class="lede" style="margin-top:.8rem">Keyless grade pages stay free forever, that is the point. Money enters at the boundaries, as structured 402 offers an agent can settle.</p>
    </div>
    <div class="price-grid">
      ${PRICING.map(
        (t) => `<div class="tier${t.featured ? ' featured' : ''}">
        <h3>${esc(t.name)}</h3>
        <div class="amt">${esc(t.price)} <small>${esc(t.note)}</small></div>
        <ul>${t.features.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
        <a class="btn ${t.featured ? 'btn-primary' : 'btn-ghost'}" href="${t.href}">${esc(t.cta)}</a>
      </div>`,
      ).join('')}
    </div>
  </div></section>`

  const ctaFinal = `<section class="section"><div class="wrap"><div class="cta-final">
    <div class="eyebrow">The proof URL is the atomic unit</div>
    <h2 style="margin-top:.7rem">Attack the product, not the verifier</h2>
    <p class="lede center" style="margin-top:.9rem">A fleet whose reward is api.qa-green will attack the test before it fixes the product. So we built the one grade it cannot game.</p>
    <div class="hero-actions" style="justify-content:center;margin-top:1.7rem">
      <a class="btn btn-primary" href="/self">See api.qa grade api.qa &rarr;</a>
      <a class="btn btn-ghost" href="/llms.txt">Read the design</a>
    </div>
  </div></div></section>`

  const script = `function gradeGo(e){e.preventDefault();var v=document.getElementById('g').value.trim().replace(/^https?:\\/\\//,'').replace(/\\/.*$/,'');if(v){location.href='/'+encodeURIComponent(v)}return false}`

  return shell({
    title: 'api.qa — the verifier your fleet cannot edit',
    description: 'An independent, deterministic, Ed25519-signed verdict on whether an agent-first API works as described. A grade your fleet cannot game.',
    jsonLd,
    extraCss: landingCss(),
    body: navHtml('landing') + hero + invariant + features + checklist + tracks + pricing + ctaFinal + footHtml(),
    script,
  })
}

// ---------------------------------------------------------------------------
// Report page — the grade as a credential
// ---------------------------------------------------------------------------

const GRADE_COLOR: Record<Grade, string> = {
  'A+': 'var(--pass)',
  A: 'var(--pass)',
  B: 'var(--primary)',
  C: 'var(--warn)',
  D: 'oklch(0.64 0.17 45)',
  F: 'var(--fail)',
}

const VERDICT_LABEL: Record<Verdict, string> = { pass: 'PASS', fail: 'FAIL', skip: 'skip' }

function reportCss(): string {
  return `
.rep-hero{position:relative;overflow:hidden;padding:3rem 0 2.5rem}
.rep-hero::before{content:'';position:absolute;inset:-40% 0 auto 0;height:40rem;z-index:0;pointer-events:none;
  background:radial-gradient(48rem 26rem at 30% 0%,var(--glow-a),transparent 62%)}
.rep-card{position:relative;z-index:1;background:var(--card);border:1px solid var(--border);
  border-radius:calc(var(--radius) + .3rem);box-shadow:var(--shadow-lg);padding:2rem 2.1rem}
.rep-crumb{font-family:var(--font-mono);font-size:.82rem;color:var(--muted-foreground)}
.rep-crumb a{color:var(--primary)}
.rep-main{display:grid;grid-template-columns:auto 1fr;gap:1.9rem;align-items:center;margin-top:1.1rem}
@media(max-width:640px){.rep-main{grid-template-columns:1fr;text-align:center;justify-items:center}}
.bigseal{--gc:var(--pass);width:132px;height:132px;flex:none;border-radius:50%;display:grid;place-items:center;
  font-weight:800;font-size:4rem;letter-spacing:-.05em;color:var(--gc);
  background:radial-gradient(circle at 50% 42%,color-mix(in oklch,var(--gc) 18%,transparent),transparent 70%);
  border:3px solid var(--gc);box-shadow:0 0 0 8px color-mix(in oklch,var(--gc) 9%,transparent)}
.rep-host{font-family:var(--font-mono);font-size:1.05rem;color:var(--muted-foreground)}
.rep-score{font-size:2.6rem;font-weight:800;letter-spacing:-.03em;margin:.15rem 0 .1rem}
.rep-score small{font-size:1rem;font-weight:500;color:var(--muted-foreground)}
.rep-badges{display:flex;flex-wrap:wrap;gap:.5rem;margin-top:.65rem}
.badge{display:inline-flex;align-items:center;gap:.4rem;font-size:.78rem;font-weight:600;
  padding:.24rem .62rem;border-radius:99px;border:1px solid var(--border);background:var(--background)}
.badge.att{color:var(--pass);border-color:color-mix(in oklch,var(--pass) 40%,var(--border))}
.badge.adv{color:var(--warn);border-color:color-mix(in oklch,var(--warn) 40%,var(--border))}
.rep-meter{display:flex;gap:5px;margin-top:1.25rem}
.rep-meter i{height:9px;flex:1;border-radius:99px;background:var(--border)}
.rep-meter i.pass{background:var(--pass)}
.rep-meter i.fail{background:var(--fail)}
.rep-facts{display:flex;flex-wrap:wrap;gap:.35rem 1.4rem;margin-top:1.25rem;padding-top:1.1rem;border-top:1px dashed var(--border);
  font-family:var(--font-mono);font-size:.76rem;color:var(--muted-foreground)}
.rep-facts b{color:var(--foreground);font-weight:600}

.note{background:var(--fail-soft);color:var(--fail);border-radius:var(--radius);padding:.9rem 1.15rem;
  font-size:.9rem;font-weight:500;margin-top:1.4rem}

.rep-sec{padding:2.4rem 0}
.rep-sec h2{font-size:1.35rem;letter-spacing:-.02em}
.rep-sec .sub{color:var(--muted-foreground);font-size:.92rem;margin-top:.3rem}

table.ax{width:100%;border-collapse:collapse;margin-top:1.1rem;background:var(--card);
  border:1px solid var(--border);border-radius:var(--radius);overflow:hidden}
table.ax th{text-align:left;font-size:.72rem;letter-spacing:.06em;text-transform:uppercase;color:var(--muted-foreground);
  font-weight:600;padding:.7rem 1rem;border-bottom:1px solid var(--border)}
table.ax td{padding:.72rem 1rem;border-top:1px solid var(--border);font-size:.93rem;vertical-align:middle}
table.ax td.n{font-family:var(--font-mono);color:var(--muted-foreground);width:2.5rem}
table.ax td.v{text-align:right;width:6rem}
table.ax tr:first-child td{border-top:0}

.checks{margin-top:1.2rem;display:grid;gap:.7rem}
.chk{border:1px solid var(--border);border-radius:var(--radius);padding:1rem 1.15rem;background:var(--card)}
.chk-h{display:flex;align-items:center;gap:.7rem;flex-wrap:wrap}
.chk-h .t{font-weight:600;font-size:.96rem}
.chk-h code{font-family:var(--font-mono);font-size:.76rem;color:var(--muted-foreground);
  background:var(--muted);padding:.1rem .4rem;border-radius:5px}
.chk p{color:var(--muted-foreground);font-size:.9rem;margin-top:.5rem;line-height:1.6}

.attest{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:1.4rem 1.5rem;margin-top:1.1rem}
.attest .kv{display:grid;grid-template-columns:8.5rem 1fr;gap:.55rem 1rem;font-size:.82rem}
@media(max-width:560px){.attest .kv{grid-template-columns:1fr}}
.attest .kv dt{color:var(--muted-foreground);font-weight:500}
.attest .kv dd{margin:0;font-family:var(--font-mono);font-size:.78rem;word-break:break-all;color:var(--foreground)}

.repro{margin-top:1.1rem}
.repro p{color:var(--muted-foreground);font-size:.92rem;margin-bottom:.8rem;max-width:46rem}`
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

  const meter = r.axScore.items
    .map((i) => `<i class="${i.verdict === 'pass' ? 'pass' : i.verdict === 'fail' ? 'fail' : ''}" title="${esc(i.title)}: ${VERDICT_LABEL[i.verdict]}"></i>`)
    .join('')

  const attBadge = r.attested
    ? `<span class="badge att">${sealSvg('seal')} Ed25519 attested</span>`
    : `<span class="badge adv">advisory &middot; unsigned</span>`

  const digestShort = r.discovery.evidenceDigest.slice(0, 18)

  const hero = `<section class="rep-hero"><div class="wrap">
    <div class="rep-card">
      <div class="rep-crumb"><a href="/">api.qa</a> / ${esc(host)}</div>
      <div class="rep-main">
        <div class="bigseal" style="--gc:${gc}">${esc(r.grade)}</div>
        <div>
          <div class="rep-host">${esc(host)}</div>
          <div class="rep-score">${r.axScore.points}<small>/10 AX score</small></div>
          <div class="rep-badges">
            <span class="badge">${esc(r.mode)} mode</span>
            ${attBadge}
            <span class="badge">verifier v${esc(r.verifierVersion)}</span>
          </div>
        </div>
      </div>
      <div class="rep-meter" aria-label="10-point AX score">${meter}</div>
      <div class="rep-facts">
        <span>verified <b>${esc(r.verifiedAt)}</b></span>
        <span>seed <b>${r.seed}</b> (replayable)</span>
        <span>evidence <b>${esc(digestShort)}…</b></span>
      </div>
    </div>
  </div></section>`

  const notes = r.gradeNotes.length
    ? `<div class="wrap">${r.gradeNotes.map((n) => `<div class="note">${esc(n)}</div>`).join('')}</div>`
    : ''

  const axTable = `<section class="rep-sec"><div class="wrap">
    <h2>The 10-point checklist</h2>
    <div class="sub">Each item derived from ${esc(host)}’s own published surfaces, scored 0 or 1.</div>
    <table class="ax"><thead><tr><th>#</th><th>Check</th><th style="text-align:right">Verdict</th></tr></thead><tbody>
    ${r.axScore.items
      .map((i) => `<tr><td class="n">${i.item}</td><td>${esc(i.title)}</td><td class="v"><span class="pill ${i.verdict}">${VERDICT_LABEL[i.verdict]}</span></td></tr>`)
      .join('')}
    </tbody></table>
  </div></section>`

  const details = `<section class="rep-sec"><div class="wrap">
    <h2>Check details</h2>
    <div class="sub">Every verdict references the evidence it was judged from.</div>
    <div class="checks">
    ${r.checks
      .map(
        (c) => `<article class="chk">
        <div class="chk-h"><span class="pill ${c.verdict}">${VERDICT_LABEL[c.verdict]}</span>
          <span class="t">${esc(c.title)}</span><code>${esc(c.id)}</code></div>
        <p>${esc(c.detail)}</p>
      </article>`,
      )
      .join('')}
    </div>
  </div></section>`

  const att = r.attestation
    ? `<section class="rep-sec"><div class="wrap">
      <h2>Attestation &amp; evidence</h2>
      <div class="sub">Signed over the canonical report digest; the evidence bundle is embedded, so this verdict re-judges offline.</div>
      <div class="attest"><dl class="kv">
        <dt>Algorithm</dt><dd>${esc(r.attestation.alg)}</dd>
        <dt>Report digest</dt><dd>${esc(r.attestation.reportDigest)}</dd>
        <dt>Public key</dt><dd>${esc(r.attestation.publicKey)}</dd>
        <dt>Signature</dt><dd>${esc(r.attestation.signature)}</dd>
        <dt>Evidence bundle</dt><dd>${r.evidence.items.length} recorded exchanges &middot; digest ${esc(r.discovery.evidenceDigest)}</dd>
      </dl></div>
    </div></section>`
    : `<section class="rep-sec"><div class="wrap">
      <h2>Attestation &amp; evidence</h2>
      <div class="sub">This is a ${esc(r.mode)}-mode report: advisory and unsigned by construction. Only the held-out deployed verifier mints Ed25519 attestations.</div>
      <div class="attest"><dl class="kv">
        <dt>Evidence bundle</dt><dd>${r.evidence.items.length} recorded exchanges &middot; digest ${esc(r.discovery.evidenceDigest)}</dd>
      </dl></div>
    </div></section>`

  const repro = `<section class="rep-sec"><div class="wrap repro">
    <h2>Verify this yourself</h2>
    <p>Judging is a pure function of the embedded evidence bundle. Re-run the checks over it and you must get this same grade, or the report is forged or the verifier version changed.</p>
    <pre class="code"><span class="tok-c"># fetch the full report and re-judge its embedded evidence</span>
curl -H <span class="tok-k">'accept: application/json'</span> https://api.qa/${esc(host)} | npx autonomous-qa rejudge</pre>
    <p style="margin-top:1rem">Agents: <code>curl https://api.qa/${esc(host)}</code> returns this report as markdown; <code>accept: application/json</code> returns the full report with the replayable evidence bundle.</p>
  </div></section>`

  return shell({
    title: `api.qa — ${host} — Grade ${r.grade}`,
    description: `${host} scored ${r.grade} (AX ${r.axScore.points}/10) on api.qa, the external verifier for agent-first APIs. ${r.attested ? 'Ed25519-attested' : 'Advisory'} verdict.`,
    jsonLd,
    extraCss: reportCss(),
    body: navHtml('report') + hero + notes + axTable + details + att + repro + footHtml(),
  })
}
