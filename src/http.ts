/**
 * The polite observer. All network the verifier ever does goes through
 * `Observer` — read-only by default, budgeted, size-capped, and it records
 * every exchange as Evidence. Probes deliberately look like ordinary agent
 * traffic (standard Accept headers, no distinctive User-Agent) so a target
 * cannot cheaply cloak for the verifier (DESIGN.md, attack #5).
 */

import type { Evidence } from './types.js'

/** fetch-compatible seam. Tests and self-verification inject their own. */
export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>

/**
 * The exact `Evidence.error` text recorded when a call to `Observer.observe`
 * is refused because the per-run politeness budget is exhausted (the request
 * is NEVER sent). Exported so a caller (e.g. the contract-diff judge) can
 * distinguish "declared but never probed — budget ran out" from a genuine
 * network failure (timeout, DNS, connection refused): the latter is evidence
 * of a real dishonest/unreachable claim, the former is not a violation at all.
 */
export const BUDGET_EXHAUSTED_ERROR = 'blocked: politeness budget exhausted'

export interface ObserverOpts {
  fetcher?: Fetcher
  /** Max requests per run. Default 24. */
  budget?: number
  /** Delay between requests, ms. Default 150 (0 in tests). */
  delayMs?: number
  /** Per-request timeout, ms. Default 10_000. */
  timeoutMs?: number
  /** Max body bytes retained. Default 262_144. */
  maxBodyBytes?: number
  /** Pinned-spec consent mode may enable non-GET probes. Default false. */
  allowWrites?: boolean
  /**
   * Consented private/local target mode (dev/CLI `--allow-private`). When true,
   * the observer may fetch a private/loopback/link-local initial target (e.g.
   * http://localhost:8787). Default false — the deployed Worker NEVER sets it,
   * so it can never fetch a private/metadata address as an initial target.
   */
  allowPrivate?: boolean
}

const HEADER_ALLOWLIST = ['link', 'retry-after', 'www-authenticate', 'access-control-allow-origin']

/** Max redirect hops the observer will manually follow (each re-validated). */
const MAX_REDIRECT_HOPS = 3

/** The origin of a URL, or null if it does not parse. */
function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

export class Observer {
  readonly items: Evidence[] = []
  private used = 0
  private readonly opts: Required<Omit<ObserverOpts, 'fetcher'>> & { fetcher: Fetcher }

  constructor(opts: ObserverOpts = {}) {
    this.opts = {
      fetcher: opts.fetcher ?? ((url, init) => fetch(url, init)),
      budget: opts.budget ?? 24,
      delayMs: opts.delayMs ?? 150,
      timeoutMs: opts.timeoutMs ?? 10_000,
      maxBodyBytes: opts.maxBodyBytes ?? 262_144,
      allowWrites: opts.allowWrites ?? false,
      allowPrivate: opts.allowPrivate ?? false,
    }
  }

  get budgetRemaining(): number {
    return this.opts.budget - this.used
  }

  /** Fetch once, record Evidence, return it. Never throws. */
  async observe(
    role: string,
    url: string,
    init: { method?: string; accept?: string; body?: unknown } = {},
  ): Promise<Evidence> {
    const method = (init.method ?? 'GET').toUpperCase()
    // STRUCTURAL SSRF BACKSTOP (DESIGN.md attack #9): re-validate our OWN
    // INITIAL url before the first byte leaves, independent of any call site.
    // No redirect is needed to hit metadata — `openapi:"http://169.254.169.254/…"`
    // is fetched DIRECTLY, so `redirect:'manual'` never sees it. api.qa must
    // NEVER fetch a private/loopback/link-local/metadata address as an initial
    // target, for EVERY role, no matter which (present or future) call site
    // passed it — this is the whack-a-mole-proof layer under the per-call-site
    // same-origin gates. The ONLY exception is a consented private/local target
    // (dev/CLI `--allow-private`, the same escape hatch normalizeTarget honors);
    // the deployed Worker never sets allowPrivate. Mirrors the redirect-hop
    // guard, which fails closed on exactly these addresses.
    const initialHost = (() => { try { return new URL(url).hostname } catch { return null } })()
    if (!this.opts.allowPrivate && initialHost !== null && isPrivateHost(initialHost)) {
      return this.record(role, url, method, init.accept, null, null, {}, null, 0,
        `blocked: refusing private/metadata initial target (SSRF): ${url}`)
    }
    if (!this.opts.allowWrites && method !== 'GET' && method !== 'HEAD') {
      const ev = this.record(role, url, method, init.accept, null, null, {}, null, 0, 'blocked: read-only mode')
      return ev
    }
    if (this.used >= this.opts.budget) {
      return this.record(role, url, method, init.accept, null, null, {}, null, 0, BUDGET_EXHAUSTED_ERROR)
    }
    this.used += 1
    if (this.used > 1 && this.opts.delayMs > 0) {
      await new Promise((r) => setTimeout(r, this.opts.delayMs))
    }

    const started = Date.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs)
    try {
      const headers: Record<string, string> = { accept: init.accept ?? '*/*' }
      let body: string | undefined
      if (init.body !== undefined) {
        body = typeof init.body === 'string' ? init.body : JSON.stringify(init.body)
        headers['content-type'] = 'application/json'
      }
      // SSRF (DESIGN.md attack #9): NEVER let native `fetch` auto-follow a
      // redirect — a hostile-but-legal same-origin GET probe can 3xx to
      // http://169.254.169.254/… (or any off-origin host) and native
      // `redirect: 'follow'` would hop there and store the metadata/credential
      // body. We follow manually and re-validate EVERY hop against the original
      // origin (same-origin, publicly-routable, not private/metadata) and keep
      // it read-only (GET/HEAD). Any failing hop fails closed: we do not fetch
      // the Location and never read its body.
      const originForRedirect = safeOrigin(url)
      let currentUrl = url
      let res: Response
      let hop = 0
      for (;;) {
        res = await this.opts.fetcher(currentUrl, {
          method, headers, body, signal: controller.signal, redirect: 'manual',
        })
        const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null
        if (!location) break
        // A redirect on a non-read-only method is never safe to follow.
        if (method !== 'GET' && method !== 'HEAD') {
          clearTimeout(timer)
          return this.record(role, url, method, init.accept, null, null, {}, null, Date.now() - started,
            `blocked: refusing to follow redirect on ${method} (read-only)`)
        }
        if (hop >= MAX_REDIRECT_HOPS) {
          clearTimeout(timer)
          return this.record(role, url, method, init.accept, null, null, {}, null, Date.now() - started,
            `blocked: too many redirects (> ${MAX_REDIRECT_HOPS})`)
        }
        let nextUrl: string
        try {
          nextUrl = new URL(location, currentUrl).toString()
        } catch {
          clearTimeout(timer)
          return this.record(role, url, method, init.accept, null, null, {}, null, Date.now() - started,
            `blocked: unparseable redirect Location`)
        }
        if (!originForRedirect || !isPubliclyRoutableSameOrigin(nextUrl, originForRedirect)) {
          clearTimeout(timer)
          return this.record(role, url, method, init.accept, null, null, {}, null, Date.now() - started,
            `blocked: refusing off-origin/private redirect (SSRF): ${nextUrl}`)
        }
        hop += 1
        currentUrl = nextUrl
      }
      // Keep the abort timer ARMED across the body read (ax-gf2 slow-loris fix).
      // Previously `clearTimeout(timer)` fired HERE, before readCapped streamed
      // the body — so a server that returned 200 headers then slow-lorised /
      // dripped the body held the probe open past timeoutMs (the AbortController),
      // bounded only by maxBodyBytes. With the timer still armed, the
      // AbortController fires DURING a slow body drip and aborts the underlying
      // stream, so total connect+headers+body time is bounded by timeoutMs.
      // readCapped surfaces the abort as a clean rejection (caught below and
      // recorded as a timeout error) — no hang, no unhandled rejection — and the
      // maxBodyBytes cap still applies to a fast body.
      const text = await this.readCapped(res)
      clearTimeout(timer)
      const kept: Record<string, string> = {}
      for (const h of HEADER_ALLOWLIST) {
        const v = res.headers.get(h)
        if (v) kept[h] = v
      }
      return this.record(
        role, url, method, init.accept,
        res.status, res.headers.get('content-type'), kept, text, Date.now() - started,
      )
    } catch (err) {
      clearTimeout(timer)
      return this.record(
        role, url, method, init.accept, null, null, {}, null, Date.now() - started,
        err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      )
    }
  }

  /**
   * SSRF-safe JSON-RPC POST for the MCP registry LIVE-remote handshake
   * (ax-e6b.38): the ONE place the verifier sends a non-GET request. It exists
   * so api.qa can perform the MCP `initialize` → `tools/list` handshake against
   * a server.json-declared remote — non-mutating MCP protocol reads — to
   * confirm the remote genuinely resolves and advertises tools (not merely
   * "declared"). It is DELIBERATELY narrow, and keeps every SSRF backstop the
   * read-only `observe` has, PLUS it NEVER follows a redirect at all:
   *
   *   - the initial host is re-validated against the private/loopback/link-
   *     local/metadata block (same structural backstop as `observe`); a
   *     private initial target is refused WITHOUT sending a byte (unless the
   *     dev/CLI `allowPrivate` escape hatch is set, which the deployed Worker
   *     never sets);
   *   - `redirect:'manual'` — a 3xx is recorded verbatim and its `Location` is
   *     NEVER fetched, so a hostile remote cannot 3xx the POST to
   *     169.254.169.254 and have us hop there (the read-only observe follows
   *     same-origin redirects; a write must follow NONE);
   *   - the caller (discovery) additionally gates the remote URL through
   *     `isPublicHttpsOffOriginAllowed` (https, public host, no private IP) —
   *     the same narrow off-origin allowance the RFC 9728 authorization server
   *     uses, because a registry remote MAY legitimately be hosted off the
   *     target's own origin;
   *   - bounded body, per-request timeout, and it draws from the same shared
   *     politeness budget.
   *
   * The `mcp-session-id` response header (MCP streamable-http assigns it on
   * `initialize`; the follow-up `tools/list` must echo it) is captured into the
   * kept headers so the JUDGE can thread it — WITHOUT widening the global header
   * allowlist that every other role's Evidence carries.
   */
  async observeMcp(
    role: string,
    url: string,
    jsonRpc: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<Evidence> {
    const method = 'POST'
    const accept = 'application/json, text/event-stream'
    const initialHost = (() => { try { return new URL(url).hostname } catch { return null } })()
    if (!this.opts.allowPrivate && initialHost !== null && isPrivateHost(initialHost)) {
      return this.record(role, url, method, accept, null, null, {}, null, 0,
        `blocked: refusing private/metadata MCP remote (SSRF): ${url}`)
    }
    if (this.used >= this.opts.budget) {
      return this.record(role, url, method, accept, null, null, {}, null, 0, BUDGET_EXHAUSTED_ERROR)
    }
    this.used += 1
    if (this.used > 1 && this.opts.delayMs > 0) {
      await new Promise((r) => setTimeout(r, this.opts.delayMs))
    }
    const started = Date.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs)
    try {
      const headers: Record<string, string> = {
        accept,
        'content-type': 'application/json',
        ...extraHeaders,
      }
      // redirect:'manual' — a write is NEVER redirect-followed (SSRF): the 3xx
      // is recorded, its Location is never fetched.
      const res = await this.opts.fetcher(url, {
        method,
        headers,
        body: JSON.stringify(jsonRpc),
        signal: controller.signal,
        redirect: 'manual',
      })
      // Timer stays ARMED across the body read (ax-gf2): a slow-lorised / dripped
      // MCP response body cannot hold this probe past timeoutMs either.
      const text = await this.readCapped(res)
      clearTimeout(timer)
      const kept: Record<string, string> = {}
      for (const h of HEADER_ALLOWLIST) {
        const v = res.headers.get(h)
        if (v) kept[h] = v
      }
      // MCP streamable-http session id — kept ONLY on the handshake evidence so
      // the follow-up tools/list can echo it; not added to HEADER_ALLOWLIST.
      const sid = res.headers.get('mcp-session-id')
      if (sid) kept['mcp-session-id'] = sid
      return this.record(role, url, method, accept, res.status, res.headers.get('content-type'), kept, text, Date.now() - started)
    } catch (err) {
      clearTimeout(timer)
      return this.record(role, url, method, accept, null, null, {}, null, Date.now() - started,
        err instanceof Error ? `${err.name}: ${err.message}` : String(err))
    }
  }

  /**
   * Read a response body up to `maxBodyBytes`, WITHOUT ever buffering more
   * than that many bytes in memory — regardless of how large the target's
   * response actually is (a shared-code memory-DoS fix: `await res.text()`
   * used to buffer the ENTIRE body before slicing, so a malicious target
   * streaming a huge/unbounded body could exhaust memory on every single
   * api.qa fetch call site, since every role's evidence goes through here).
   *
   * Two layers, neither trusting the other:
   *   1. A declared `Content-Length` that ALREADY exceeds the cap is rejected
   *      before reading a single byte of the body (the fast, cheap path — no
   *      point starting a read we know must be truncated).
   *   2. Regardless of what `Content-Length` says (absent, wrong, or a
   *      chunked transfer with no length at all), the body is read via a
   *      STREAMING reader that accumulates chunks only up to the cap, then
   *      cancels the underlying stream — so peak memory is bounded by
   *      `maxBodyBytes` no matter how much data the target tries to send.
   *
   * Normal (non-oversized) bodies are read in full and decoded as UTF-8,
   * preserving prior behavior for every legitimate target.
   */
  private async readCapped(res: Response): Promise<string> {
    const maxBytes = this.opts.maxBodyBytes
    const declaredLength = res.headers.get('content-length')
    if (declaredLength !== null) {
      const declared = Number(declaredLength)
      if (Number.isFinite(declared) && declared > maxBytes) {
        try { await res.body?.cancel() } catch { /* best-effort — connection may already be closed */ }
        return ''
      }
    }

    const body = res.body
    if (!body || typeof (body as { getReader?: unknown }).getReader !== 'function') {
      // No streamable body on this Response implementation (some test/mock
      // Response constructions) — fall back to a single bounded read.
      const text = await res.text()
      return text.length <= maxBytes ? text : text.slice(0, maxBytes)
    }

    const reader = body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    let truncated = false
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value || value.byteLength === 0) continue
        const remaining = maxBytes - total
        if (value.byteLength >= remaining) {
          if (remaining > 0) {
            chunks.push(value.subarray(0, remaining))
            total += remaining
          }
          truncated = true
          break
        }
        chunks.push(value)
        total += value.byteLength
      }
      if (truncated) {
        // Stop pulling the rest of the stream — never drain a body past the cap.
        try { await reader.cancel() } catch { /* best-effort */ }
      }
    } finally {
      try { reader.releaseLock() } catch { /* already released by cancel() in some runtimes */ }
    }

    const buf = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      buf.set(chunk, offset)
      offset += chunk.byteLength
    }
    return new TextDecoder('utf-8').decode(buf)
  }

  private record(
    role: string, url: string, method: string, accept: string | undefined,
    status: number | null, contentType: string | null, headers: Record<string, string>,
    body: string | null, elapsedMs: number, error?: string,
  ): Evidence {
    const ev: Evidence = { role, url, method, accept, status, contentType, headers, body, elapsedMs }
    if (error) ev.error = error
    this.items.push(ev)
    return ev
  }
}

// ---------------------------------------------------------------------------
// Target guards (SSRF — DESIGN.md attack #9)
// ---------------------------------------------------------------------------

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0|\[::1\]|\[fe80:|\[fc|\[fd|.*\.(local|internal|localhost))/i
// Dotted-quad, ANY bracketed IPv6 literal, and — critically — a bare all-digit
// host (a DECIMAL-encoded IPv4, e.g. 2852039166 === 169.254.169.254) or an
// 0x-hex host. A purely numeric label is never a public DNS name, so treating
// it as an IP literal closes the decimal/hex SSRF bypass of the dotted-quad
// checks in PRIVATE_HOST above.
const IP_LITERAL = /^\d{1,3}(\.\d{1,3}){3}$|^\[|^\d+$|^0x[0-9a-f]+$/i

/**
 * Decode any inet_aton-style numeric IPv4 host to its canonical dotted-quad, or
 * null when `host` is not a purely-numeric IPv4 form. WHATWG-`URL` canonicalizes
 * these forms itself (`new URL('http://2852039166/').hostname === '169.254.169.254'`),
 * so a caller that already ran the host through `new URL()` is covered — but
 * isPrivateHost must NOT depend on that. This decodes the same forms the URL
 * parser accepts, so isPrivateHost is correct on a RAW string too:
 *   - bare decimal      2852039166            → 169.254.169.254
 *   - bare 0x-hex       0xA9FEA9FE            → 169.254.169.254
 *   - bare octal        025177724776          → 169.254.169.254
 *   - dotted, mixed radix / short forms       0xA9.0376.169.254, 127.1, …
 * inet_aton packs the LAST part into the remaining low-order bytes; leading
 * parts are one byte each. A part out of range, an empty part, or any non-numeric
 * label makes the whole host a DNS name (→ null, not an IP). The dotted-octal and
 * dotted-hex forms are the ones the flat IP_LITERAL regex above CANNOT catch, so
 * this is the load-bearing addition; bare decimal/hex are already caught by
 * IP_LITERAL and stay refused regardless.
 */
function numericIpv4ToDotted(host: string): string | null {
  const labels = host.split('.')
  if (labels.length === 0 || labels.length > 4) return null
  const parts: number[] = []
  for (const label of labels) {
    if (label.length === 0) return null
    let n: number
    if (/^0x[0-9a-f]+$/i.test(label)) n = parseInt(label.slice(2), 16)
    else if (/^0[0-7]+$/.test(label)) n = parseInt(label, 8)
    else if (/^(0|[1-9][0-9]*)$/.test(label)) n = parseInt(label, 10)
    else return null
    if (!Number.isFinite(n) || n < 0) return null
    parts.push(n)
  }
  const n = parts.length
  const bytesForLast = 4 - (n - 1)
  for (let i = 0; i < n - 1; i++) if (parts[i]! > 0xff) return null
  const last = parts[n - 1]!
  const maxLast = Math.pow(256, bytesForLast) - 1
  if (last > maxLast) return null
  let leading = 0
  for (let i = 0; i < n - 1; i++) leading = leading * 256 + parts[i]!
  const value = (leading * Math.pow(256, bytesForLast) + last) >>> 0
  return `${(value >>> 24) & 0xff}.${(value >>> 16) & 0xff}.${(value >>> 8) & 0xff}.${value & 0xff}`
}

/** A private/loopback/link-local/metadata host — never a public probe target. */
export function isPrivateHost(host: string): boolean {
  if (PRIVATE_HOST.test(host) || IP_LITERAL.test(host)) return true
  // Self-defense: normalize/parse the numeric IPv4 forms (dotted octal/hex and
  // short forms the flat IP_LITERAL regex misses) and re-run the private-range
  // check on the canonical dotted-quad. Purely ADDITIVE — it can only make MORE
  // hosts private, never fewer, so every host currently refused stays refused.
  const dotted = numericIpv4ToDotted(host)
  return dotted !== null && PRIVATE_HOST.test(dotted)
}

/**
 * The single same-origin + publicly-routable gate. A capability card is
 * ADVERSARIAL input: any probe URL it declares (monetization.probe AND every
 * `probes.<channel>` entry) is resolved through THIS function so the two
 * cannot drift apart (AXP Appendix A.5 requires monetization.probe be
 * same-origin, exactly as the probe manifest already is).
 *
 * Returns true only when `rawUrl` parses, is same-origin with `origin`, and
 * does not point at a private/loopback/link-local/metadata address (e.g.
 * 169.254.169.254, 10.x, 127.x, ::1). This gate protects TWO surfaces:
 *   1. the declared probe URL (monetization.probe / probes.*), where `rawUrl`
 *      is same-origin with `origin` by construction; and
 *   2. every redirect Location the observer manually follows, where `rawUrl`
 *      is the hop target and its host CAN differ from `origin` — a hostile
 *      same-origin probe that 3xx-redirects to http://169.254.169.254/… is
 *      the live SSRF this guard must stop.
 *
 * The private/metadata block is checked FIRST and against `rawUrl`'s host, so
 * it bites on the redirect hop (the case the same-origin compare alone cannot
 * be relied on to reach). The one exception is a consented private/local
 * target (origin itself private — the dev-mode escape hatch) serving its own
 * same-origin private probe. The method (GET-only) is enforced by the caller.
 */
export function isPubliclyRoutableSameOrigin(rawUrl: string, origin: string): boolean {
  let u: URL
  try { u = new URL(rawUrl) } catch { return false }
  let base: URL
  try { base = new URL(origin) } catch { return false }
  // Private/metadata block — runs against the RESOLVED host (`u`), which is
  // where a redirect Location differs from the origin. Only a consented
  // private target serving its own same-origin private probe is exempt.
  if (isPrivateHost(u.hostname)) {
    const consentedPrivateSameOrigin = isPrivateHost(base.hostname) && u.origin === base.origin
    if (!consentedPrivateSameOrigin) return false
  }
  if (u.origin !== base.origin) return false
  return true
}

/**
 * The narrowly-scoped OFF-ORIGIN gate: "off-origin allowed, but PUBLIC-only".
 *
 * Unlike `isPubliclyRoutableSameOrigin`, this does NOT require same-origin — it
 * exists for the ONE OAuth case where the target LEGITIMATELY delegates to a
 * different origin: `authorization_servers[0]` in RFC 9728 protected-resource
 * metadata (a dedicated authorization server). That single declared AS may live
 * off the verification target's origin, so the same-origin gate would wrongly
 * refuse it. This gate keeps the SSRF backstop that DOES apply: the AS url must
 * parse, be https (no cleartext), and MUST NOT point at a private / loopback /
 * link-local / metadata address (169.254.169.254, 10.x, 127.x, ::1, …). It is a
 * DELIBERATELY narrow hole — use it ONLY for the AS-metadata role, never as a
 * general off-origin fetch permission, and the observer's own initial-url
 * private-host backstop still runs underneath it as defense in depth.
 */
export function isPublicHttpsOffOriginAllowed(rawUrl: string): boolean {
  let u: URL
  try { u = new URL(rawUrl) } catch { return false }
  if (u.protocol !== 'https:') return false
  if (isPrivateHost(u.hostname)) return false
  return true
}

/**
 * Normalise a target to an https origin. `allowPrivate` is the local-mode
 * escape hatch (CLI / dev harness) — the deployed Worker never sets it.
 */
export function normalizeTarget(input: string, allowPrivate = false): { origin: string } | { error: string } {
  let raw = input.trim()
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { error: `not a valid target: ${input}` }
  }
  const host = url.hostname
  if (!allowPrivate) {
    if (PRIVATE_HOST.test(host) || IP_LITERAL.test(host)) {
      return { error: `refusing private/IP-literal target: ${host}` }
    }
    if (!host.includes('.')) return { error: `refusing single-label host: ${host}` }
  }
  return { origin: url.origin }
}
