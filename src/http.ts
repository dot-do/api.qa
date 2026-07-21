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
    if (!this.opts.allowWrites && method !== 'GET' && method !== 'HEAD') {
      const ev = this.record(role, url, method, init.accept, null, null, {}, null, 0, 'blocked: read-only mode')
      return ev
    }
    if (this.used >= this.opts.budget) {
      return this.record(role, url, method, init.accept, null, null, {}, null, 0, 'blocked: politeness budget exhausted')
    }
    this.used += 1
    if (this.used > 1 && this.opts.delayMs > 0) {
      await new Promise((r) => setTimeout(r, this.opts.delayMs))
    }

    const started = Date.now()
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs)
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
      clearTimeout(timer)
      const text = await this.readCapped(res)
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
      return this.record(
        role, url, method, init.accept, null, null, {}, null, Date.now() - started,
        err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      )
    }
  }

  private async readCapped(res: Response): Promise<string> {
    const text = await res.text()
    if (text.length <= this.opts.maxBodyBytes) return text
    return text.slice(0, this.opts.maxBodyBytes)
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
const IP_LITERAL = /^\d{1,3}(\.\d{1,3}){3}$|^\[/

/** A private/loopback/link-local/metadata host — never a public probe target. */
export function isPrivateHost(host: string): boolean {
  return PRIVATE_HOST.test(host) || IP_LITERAL.test(host)
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
