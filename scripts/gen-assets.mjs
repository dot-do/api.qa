#!/usr/bin/env node
/**
 * Generate the brand raster assets and emit them as a TypeScript module.
 *
 *   node scripts/gen-assets.mjs
 *
 * Produces `src/assets.ts` containing base64 payloads for:
 *   - og.png              1200x630 social card
 *   - apple-touch-icon.png  180x180
 *   - favicon.ico          32x32 (PNG bytes; browsers accept PNG under .ico)
 *
 * The Worker has no filesystem and no image pipeline, so these are inlined as
 * data rather than served from disk. They are committed, so a normal build does
 * NOT need to run this — rerun it only when the mark or the card copy changes.
 *
 * The seal glyph is read from `lucide-static` at generation time, the same
 * source `src/icons.ts` uses at runtime. No path data is authored here.
 *
 * Requires `rsvg-convert` (brew install librsvg) on the machine running it.
 */

import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ShieldCheck } from 'lucide-static'

// --- brand constants, resolved to sRGB hex --------------------------------
// rsvg has no OKLCH support, so the tokens in views.ts are resolved here once.
// If a token changes, update its twin below and rerun.
const C = {
  paper: '#e9ecea', // --paper          oklch(0.930 0.004 175)
  ink: '#0f1c20', // --ink            oklch(0.205 0.021 210)
  primary: '#00776c', // --teal           oklch(0.520 0.118 185)
  plate: '#0d1519', // --plate          oklch(0.190 0.024 220)
  onCode: '#4fd6c0', // --plate-accent   oklch(0.800 0.130 175)
  plateText: '#e4efec', // --plate-ink      oklch(0.910 0.014 190)
  muted: '#5c6b6d', // --ink-soft
}

// Plex if the generating machine has it installed; otherwise a neutral grotesque.
// rsvg resolves through fontconfig, so this is a best-effort preference.
const FONT = "'IBM Plex Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif"
const MONO = "'IBM Plex Mono', 'SF Mono', Menlo, Consolas, monospace"

/** Children of the lucide SVG, minus its own opening tag. */
function innerOf(svg) {
  const open = svg.indexOf('>')
  const close = svg.lastIndexOf('</svg>')
  return svg.slice(open + 1, close).trim().replace(/\s+/g, ' ')
}
const SEAL = innerOf(ShieldCheck)

/** A seal scaled from lucide's 24x24 box to `size`, positioned at x,y. */
function seal(x, y, size, color, strokeWidth = 2) {
  const s = size / 24
  return `<g transform="translate(${x} ${y}) scale(${s})" fill="none" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">${SEAL}</g>`
}

// --- the 1200x630 social card ---------------------------------------------
// Structure mirrors the site: lab-paper field, the mark, one line of what it
// is, and the ruled JUDGED formula on the same fixed dark plate the page uses
// for its load-bearing sentence.
function ogSvg() {
  const bandY = 470
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="${C.paper}"/>
  ${seal(96, 92, 76, C.primary, 2.1)}
  <text x="190" y="152" font-family="${FONT}" font-size="66" font-weight="800" fill="${C.ink}" letter-spacing="-2">api.qa</text>
  <text x="96" y="286" font-family="${FONT}" font-size="54" font-weight="700" fill="${C.ink}" letter-spacing="-1.6">The external verifier for</text>
  <text x="96" y="352" font-family="${FONT}" font-size="54" font-weight="700" fill="${C.ink}" letter-spacing="-1.6">agent-first APIs</text>
  <text x="96" y="416" font-family="${MONO}" font-size="27" fill="${C.muted}">curl api.qa/{domain}</text>
  <rect x="0" y="${bandY}" width="1200" height="160" fill="${C.plate}"/>
  <text x="96" y="${bandY + 68}" font-family="${FONT}" font-size="21" font-weight="600" fill="${C.onCode}" letter-spacing="2.4">THE CORE INVARIANT</text>
  <text x="96" y="${bandY + 118}" font-family="${FONT}" font-size="34" font-weight="600" fill="${C.plateText}" letter-spacing="-0.8">judged by api.qa, never self-graded</text>
</svg>`
}

/** Square app icon: the mark on the brand plate. */
function iconSvg(size) {
  const pad = size * 0.19
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${size * 0.22}" fill="${C.plate}"/>
  ${seal(pad, pad, size - pad * 2, C.onCode, 2.2)}
</svg>`
}

// --- rasterize -------------------------------------------------------------
const tmp = mkdtempSync(join(tmpdir(), 'apiqa-assets-'))

function png(svg, name, width, height) {
  const svgPath = join(tmp, `${name}.svg`)
  const pngPath = join(tmp, `${name}.png`)
  writeFileSync(svgPath, svg)
  try {
    execFileSync('rsvg-convert', ['-w', String(width), '-h', String(height), '-o', pngPath, svgPath])
  } catch (err) {
    console.error(`\nrsvg-convert failed for ${name}. Install it with:  brew install librsvg\n`)
    throw err
  }
  const bytes = readFileSync(pngPath)
  console.log(`  ${name}.png  ${width}x${height}  ${(bytes.length / 1024).toFixed(1)} KB`)
  // ASSET_OUT=<dir> also drops the raster next to you, for eyeballing the card.
  if (process.env.ASSET_OUT) writeFileSync(join(process.env.ASSET_OUT, `${name}.png`), bytes)
  return bytes.toString('base64')
}

console.log('generating brand assets:')
const og = png(ogSvg(), 'og', 1200, 630)
const apple = png(iconSvg(180), 'apple-touch-icon', 180, 180)
const ico = png(iconSvg(32), 'favicon', 32, 32)

const out = `/**
 * GENERATED FILE — do not edit by hand.
 * Regenerate with: node scripts/gen-assets.mjs
 *
 * Base64 raster brand assets, inlined because a Worker has no filesystem.
 * The seal glyph originates from \`lucide-static\`, the same source
 * \`src/icons.ts\` uses at runtime.
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
