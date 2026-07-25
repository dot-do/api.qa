#!/usr/bin/env node
/**
 * Generate the brand raster assets and emit them as a TypeScript module.
 *
 *   node scripts/gen-assets.mjs
 *
 * Produces `src/assets.ts` containing base64 payloads for:
 *   - og.png                1200x630 social card
 *   - apple-touch-icon.png  180x180
 *   - favicon.ico           32x32 (PNG bytes; browsers accept PNG under .ico)
 *
 * The Worker has no filesystem and no image pipeline, so these are inlined as
 * data. They are committed, so a normal build does NOT run this — rerun it only
 * when the mark, the tokens, or the card copy change.
 *
 * WHY CHROME AND NOT rsvg-convert: the card is set in IBM Plex, which is a
 * webfont. rsvg resolves through fontconfig, so on any machine without Plex
 * installed it silently falls back to Helvetica and the card ships in the wrong
 * typeface — which is exactly what happened before this rewrite. Chrome loads
 * the same Google Fonts stylesheet the site uses, so the card is rendered in the
 * real face, in the real design language, from the real tokens.
 *
 * WHY THE TOKENS ARE PARSED OUT OF views.ts: hand-copied hex values drift the
 * moment a token moves. They already had. The light-theme `:root` block is the
 * single source; this script reads it.
 *
 * Requires Google Chrome. Set CHROME=/path/to/chrome to override.
 */

import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ShieldCheck } from 'lucide-static'

const CHROME =
  process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

if (!existsSync(CHROME)) {
  console.error(`\nChrome not found at:\n  ${CHROME}\nSet CHROME=/path/to/chrome and rerun.\n`)
  process.exit(1)
}

// --- tokens, read from the stylesheet rather than copied -------------------

const viewsSrc = readFileSync(new URL('../src/views.ts', import.meta.url), 'utf8')
const rootBlock = viewsSrc.slice(viewsSrc.indexOf(':root{'), viewsSrc.indexOf('@media (prefers-color-scheme: dark)'))

function token(name) {
  const m = rootBlock.match(new RegExp(`--${name}:\\s*([^;]+);`))
  if (!m) throw new Error(`token --${name} not found in views.ts :root block`)
  return m[1].trim()
}

const T = Object.fromEntries(
  ['paper', 'panel', 'ink', 'ink-soft', 'rule', 'teal', 'plate', 'plate-ink', 'plate-accent'].map(
    (n) => [n, token(n)],
  ),
)
console.log('tokens read from views.ts:')
for (const [k, v] of Object.entries(T)) console.log(`  --${k}: ${v}`)

/** Children of the lucide SVG, minus its own opening tag. */
function inner(svg) {
  const a = svg.indexOf('>'), b = svg.lastIndexOf('</svg>')
  return svg.slice(a + 1, b).trim().replace(/\s+/g, ' ')
}
const SEAL = inner(ShieldCheck)

function seal(size, color, strokeWidth = 2) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">${SEAL}</svg>`
}

const FONTS = `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700&family=IBM+Plex+Mono:wght@400;600;700&display=block">`

/** The hatched separator band, same recipe as the site. */
const HATCH = (h = 22) =>
  `<div style="height:${h}px;border-top:1px solid ${T.rule};border-bottom:1px solid ${T.rule};
    background-image:repeating-linear-gradient(-45deg, color-mix(in oklch, ${T.ink} 16%, transparent) 0 1px, transparent 1px 7px)"></div>`

// --- the 1200x630 social card ---------------------------------------------
// Mirrors the page: ruled top bar, hatch, title block, hatch, and the ruled
// invariant on the fixed dark plate.
function ogHtml() {
  return `<!doctype html><meta charset="utf-8">${FONTS}
<style>
  *{box-sizing:border-box;margin:0}
  body{width:1200px;height:630px;background:${T.paper};color:${T.ink};
    font-family:'IBM Plex Sans',sans-serif;display:flex;flex-direction:column;overflow:hidden}
  .bar{display:flex;align-items:center;gap:12px;padding:26px 64px;
    font-family:'IBM Plex Mono',monospace;font-weight:700;font-size:27px;letter-spacing:-.02em}
  .body{flex:1;padding:56px 64px 0;display:flex;flex-direction:column}
  h1{font-size:76px;font-weight:700;letter-spacing:-.03em;line-height:1.05;max-width:17ch}
  h1 em{font-style:normal;color:${T.teal}}
  .cmd{margin-top:auto;margin-bottom:46px;font-family:'IBM Plex Mono',monospace;
    font-size:26px;background:${T.plate};color:${T['plate-ink']};
    padding:16px 22px;align-self:flex-start}
  .plate{background:${T.plate};color:${T['plate-ink']};padding:26px 64px 30px}
  .plate .eyebrow{font-family:'IBM Plex Mono',monospace;font-size:17px;letter-spacing:.16em;
    text-transform:uppercase;color:${T['plate-accent']};display:flex;align-items:center;gap:10px}
  .plate .eyebrow::before{content:"";width:7px;height:7px;background:${T['plate-accent']}}
  .plate .line{margin-top:14px;font-size:36px;font-weight:600;letter-spacing:-.02em}
</style>
<div class="bar">${seal(30, T.teal, 2.1)} api.qa</div>
${HATCH()}
<div class="body">
  <h1>The external verifier for <em>agent-first</em> APIs</h1>
  <div class="cmd">curl api.qa/{domain}</div>
</div>
<div class="plate">
  <div class="eyebrow">The core invariant</div>
  <div class="line">judged by api.qa, never self-graded</div>
</div>`
}

/** Square app icon: the mark on the brand plate. */
function iconHtml(size) {
  const pad = Math.round(size * 0.2)
  return `<!doctype html><meta charset="utf-8">
<style>*{box-sizing:border-box;margin:0}
  body{width:${size}px;height:${size}px;background:${T.plate};
    display:grid;place-items:center;overflow:hidden}</style>
<div>${seal(size - pad * 2, T['plate-accent'], 2.2)}</div>`
}

// --- render ----------------------------------------------------------------
const tmp = mkdtempSync(join(tmpdir(), 'apiqa-assets-'))

function shot(html, name, w, h) {
  const htmlPath = join(tmp, `${name}.html`)
  const pngPath = join(tmp, `${name}.png`)
  writeFileSync(htmlPath, html)
  execFileSync(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    // budget gives the webfont time to arrive before the frame is captured
    '--virtual-time-budget=8000',
    `--window-size=${w},${h}`,
    `--screenshot=${pngPath}`,
    `file://${htmlPath}`,
  ], { stdio: 'pipe' })
  const bytes = readFileSync(pngPath)
  console.log(`  ${name}.png  ${w}x${h}  ${(bytes.length / 1024).toFixed(1)} KB`)
  if (process.env.ASSET_OUT) writeFileSync(join(process.env.ASSET_OUT, `${name}.png`), bytes)
  return bytes.toString('base64')
}

console.log('\nrendering via Chrome:')
const og = shot(ogHtml(), 'og', 1200, 630)
const apple = shot(iconHtml(180), 'apple-touch-icon', 180, 180)
const ico = shot(iconHtml(32), 'favicon', 32, 32)

const out = `/**
 * GENERATED FILE — do not edit by hand.
 * Regenerate with: node scripts/gen-assets.mjs
 *
 * Base64 raster brand assets, inlined because a Worker has no filesystem.
 * Rendered by Chrome from the same tokens and typefaces the site uses; the seal
 * glyph originates from \`lucide-static\`, the same source \`src/icons.ts\` uses.
 */

/** 1200x630 social card, referenced by og:image / twitter:image. */
export const OG_PNG_BASE64 = '${og}'

/** 180x180 iOS home-screen icon. */
export const APPLE_TOUCH_ICON_PNG_BASE64 = '${apple}'

/** 32x32 legacy favicon (PNG bytes; every current browser accepts this). */
export const FAVICON_PNG_BASE64 = '${ico}'

/** Decode a base64 asset into bytes a Response can stream. */
export function assetBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
`

writeFileSync(new URL('../src/assets.ts', import.meta.url), out)
console.log(`\nwrote src/assets.ts (${(out.length / 1024).toFixed(1)} KB source)`)
