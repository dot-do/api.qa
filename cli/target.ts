/**
 * Small, pure, network-free target-classification helpers for the CLI.
 *
 * Split out of cli/index.ts (which unconditionally runs `main()` at import
 * time, so it is not safe to import from tests) so these SSRF-relevant
 * decisions are directly unit-testable without spawning the compiled binary
 * or touching the network.
 */

import { isPrivateHost } from '../src/http.js'

export function isUrl(s: string): boolean {
  return /^https?:\/\//i.test(s)
}

/**
 * COSMETIC ONLY — a loose, unanchored substring heuristic used solely to pick
 * a probe-to-probe delay (0ms for what looks like a local target, 150ms
 * otherwise). Never use this to decide a security-relevant allowance: it
 * matches anywhere in the raw URL string, so a PUBLIC url that merely embeds
 * "localhost" / "127.0.0.1" in its path, query, or subdomain also matches.
 * That is harmless here (worst case: no throttle delay against a public
 * target) but NOT safe as an SSRF opt-in gate — see `isPrivateUrlHost` for
 * that, which anchors to the parsed hostname instead.
 */
export function isLocalTarget(target: string): boolean {
  return /localhost|127\.0\.0\.1|\[::1\]/.test(target)
}

/**
 * The SSRF-safe opt-in check for `dev <url>`: true iff the URL's PARSED
 * HOSTNAME (never the raw string) is private/loopback/link-local/metadata, per
 * the same `isPrivateHost` the core observer gates every probe with (src/
 * http.ts). A public host that happens to contain "localhost" / "127.0.0.1" /
 * "[::1]" in its path, query, or subdomain — e.g.
 * `http://127.0.0.1.attacker.com/` or `http://public.example/?x=localhost` —
 * parses to a public hostname and so is correctly reported as NOT private.
 * An unparsable string is treated as not-private (fails closed to "no
 * allowance"; `grade`/`verifyTarget` will separately reject it as an invalid
 * target).
 */
export function isPrivateUrlHost(url: string): boolean {
  try {
    return isPrivateHost(new URL(url).hostname)
  } catch {
    return false
  }
}
