/**
 * Icons — sourced from maintained libraries, never hand-authored.
 *
 * RULE: no glyph path data is written by hand anywhere in this repo. UI icons
 * come from `lucide-static` (SVG strings, MIT) and brand marks from
 * `simple-icons` (path data + official brand hex). If an icon is needed and one
 * of these packages has it, import it here; do not paste a `<path d="…">`.
 *
 * Both packages declare `sideEffects: false` and are consumed through named
 * imports, so esbuild tree-shakes to only the glyphs actually referenced —
 * measured at ~1.8KB for the two icons below, against a full-package weight of
 * several megabytes. Keep using named top-level imports for that reason.
 *
 * Everything is re-wrapped rather than emitted as-shipped: the upstream strings
 * carry their own class, width, height and stroke-width, and this design sizes
 * icons in `em` so they track the text they sit beside.
 */

import { ShieldCheck } from 'lucide-static'
import { siGithub } from 'simple-icons'

/**
 * Take the children of an upstream `<svg>` string and drop its opening tag, so
 * we can re-wrap with our own attributes. Index-based rather than a regex: the
 * opening tag is multi-line and attribute order is not ours to depend on.
 */
function inner(svg: string): string {
  const openEnd = svg.indexOf('>')
  const closeStart = svg.lastIndexOf('</svg>')
  if (openEnd < 0 || closeStart < 0) return ''
  return svg.slice(openEnd + 1, closeStart).trim().replace(/\s+/g, ' ')
}

const SHIELD_CHECK_INNER = inner(ShieldCheck)

/**
 * The verified-seal glyph — a shield enclosing a check. api.qa's mark on the
 * nav, the hero credential and the report attestation badge.
 *
 * Sized in `em` (see `.seal` in views.ts) so it scales with whatever text it
 * accompanies. Intrinsic width/height are still emitted: an SVG carrying only a
 * viewBox falls back to the CSS default object size (300x150) anywhere a rule
 * fails to size it, which is exactly how the credential badge once rendered at
 * 53px next to a 20px nav mark.
 */
export function sealIcon(cls = 'seal'): string {
  return `<svg class="${cls}" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${SHIELD_CHECK_INNER}</svg>`
}

/**
 * GitHub mark, for the nav's source link. `simple-icons` is the canonical
 * source for brand marks and tracks upstream logo changes; `siGithub.title`
 * supplies the accessible name so it stays correct if the brand is renamed.
 */
export function githubIcon(cls = 'icon'): string {
  return `<svg class="${cls}" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="${siGithub.path}"/></svg>`
}

/** Accessible name for the GitHub mark, taken from the package rather than typed. */
export const GITHUB_TITLE = siGithub.title

/**
 * Standalone seal document for `/favicon.svg`, `/apple-touch-icon.png` and the
 * OG card. Same glyph as `sealIcon`, but self-contained: a favicon has no
 * cascade to inherit `currentColor` or an `em` size from, so the color is
 * resolved to a literal here and the box is explicit.
 */
export function sealDocument(opts: { size: number; color: string; background?: string; pad?: number }): string {
  const { size, color, background, pad = 3 } = opts
  const box = 24 + pad * 2
  const bg = background
    ? `<rect width="${box}" height="${box}" rx="${box * 0.22}" fill="${background}"/>`
    : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${box} ${box}" fill="none">${bg}<g transform="translate(${pad} ${pad})" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none">${SHIELD_CHECK_INNER}</g></svg>`
}
