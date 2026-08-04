/**
 * cli/target.ts — the SSRF-relevant `dev <url>` allowance decision, unit
 * tested directly (no network, no spawned process). The load-bearing
 * property: `isPrivateUrlHost` anchors to the PARSED HOSTNAME, so a public URL
 * that merely embeds "localhost" / "127.0.0.1" / "[::1]" as a substring
 * somewhere in its path/query/subdomain must NOT be classified as private —
 * only a URL whose actual hostname is private/loopback/link-local/metadata may
 * flip the `dev` command's `allowPrivate` opt-in.
 */
import { describe, it, expect } from 'vitest'
import { isPrivateUrlHost, isLocalTarget, isUrl } from '../cli/target.js'

describe('isPrivateUrlHost — anchored to the parsed hostname (SSRF opt-in gate)', () => {
  it('a REAL localhost / loopback / IPv6-loopback host is private', () => {
    expect(isPrivateUrlHost('http://localhost:8787/')).toBe(true)
    expect(isPrivateUrlHost('http://127.0.0.1:8787/')).toBe(true)
    expect(isPrivateUrlHost('http://[::1]:8787/')).toBe(true)
  })

  it('a public host that embeds "127.0.0.1" NOT at the start of the hostname is NOT private', () => {
    // The unanchored-substring SSRF trick: `www.127.0.0.1.attacker.com`
    // contains the substring "127.0.0.1" but its hostname is a real,
    // attacker-controlled public DNS name (isPrivateHost's own prefix rule
    // only fires when a host STARTS WITH "127.", so a label buried mid-host
    // does not trip it).
    expect(isPrivateUrlHost('http://www.127.0.0.1.attacker.com/')).toBe(false)
  })

  it('a public host that embeds "localhost" as a substring (not the whole label) is NOT private', () => {
    // "notlocalhost.example.com" contains the substring "localhost" but is
    // neither the literal host "localhost" nor a *.local/.internal/.localhost
    // suffix — a real public hostname.
    expect(isPrivateUrlHost('http://notlocalhost.example.com/')).toBe(false)
  })

  it('a public host that embeds "localhost" in its QUERY STRING is NOT private', () => {
    expect(isPrivateUrlHost('http://public.example/?x=localhost')).toBe(false)
  })

  it('a public host that embeds "localhost" in its PATH is NOT private', () => {
    expect(isPrivateUrlHost('http://public.example/localhost/path')).toBe(false)
  })

  it('other private/metadata hosts (not just localhost) are still caught via isPrivateHost', () => {
    expect(isPrivateUrlHost('http://169.254.169.254/latest/meta-data/')).toBe(true)
    expect(isPrivateUrlHost('http://10.0.0.1/')).toBe(true)
  })

  it('an unparsable URL string fails closed to NOT private (no allowance granted)', () => {
    expect(isPrivateUrlHost('not a url')).toBe(false)
  })
})

describe('isLocalTarget — the loose substring heuristic, cosmetic-only (delay throttle)', () => {
  it('documents the LOOSE match this heuristic intentionally makes (never use it for allowPrivate)', () => {
    // This is exactly the shape that must NOT be used to decide the SSRF
    // opt-in — isLocalTarget matches these, isPrivateUrlHost (above) does not.
    expect(isLocalTarget('http://www.127.0.0.1.attacker.com/')).toBe(true)
    expect(isLocalTarget('http://public.example/?x=localhost')).toBe(true)
  })
})

describe('isUrl', () => {
  it('accepts http/https, rejects bare paths/module specifiers', () => {
    expect(isUrl('http://localhost:8787')).toBe(true)
    expect(isUrl('https://example.com')).toBe(true)
    expect(isUrl('./examples/example-worker.mjs')).toBe(false)
  })
})
