/**
 * KV report cache — the politeness / replay store for the deployed Worker
 * (DESIGN.md Seams §3, wrangler.jsonc "KV: report cache").
 *
 * Purity boundary: this module NEVER judges. It memoises the whole
 * observe → judge → attest artifact (a finished VerificationReport /
 * PinnedReport) so that a probe-cannon of `GET api.qa/{domain}` requests does
 * not re-probe the target on every hit. The pure judge is untouched: same
 * EvidenceBundle → byte-identical verdict, always. The cache only decides
 * whether to serve an already-minted verdict instead of minting a new one.
 *
 * Verdicts are content-addressed by the evidence digest the pure judge already
 * recorded in the report (`discovery.evidenceDigest`), so the store doubles as
 * a replay index: `report:{domain}:{digest}` → the exact attested verdict, and
 * a `head:{domain}` pointer names the most-recent digest + probe time (the
 * per-target cooldown horizon). Pinned-spec runs are keyed by
 * `pinned:{domain}:{specDigest}` — the spec digest is known before any probe,
 * so an identical (target, pinned spec) pair is served without re-probing.
 */

import type { VerificationReport } from './types.js'
import type { PinnedReport, SuiteReport } from './pinned.js'

/** Structural subset of Cloudflare's `KVNamespace` — injectable for tests. */
export interface KVLike {
  get(key: string): Promise<string | null>
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>
}

/**
 * Default freshness window (seconds): a cached verdict is served without
 * re-probing for this long, and it is the natural per-target cooldown horizon.
 * Cloudflare KV requires `expirationTtl >= 60`.
 */
export const DEFAULT_TTL_SECONDS = 300

/** Normalise any target form to a bare lowercase host key.
 *  Shared with the cooldown gate so both key on the same identity. */
export function hostKey(domain: string): string {
  return domain
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '')
    .toLowerCase()
}

interface HeadPointer {
  digest: string
  probedAtMs: number
}

interface CachedReport<R> {
  report: R
  storedAtMs: number
}

export interface CacheHit<R> {
  report: R
  ageMs: number
  fresh: boolean
}

export class ReportCache {
  constructor(
    private readonly kv: KVLike,
    private readonly ttlSeconds: number = DEFAULT_TTL_SECONDS,
  ) {}

  private headK(domain: string): string {
    return `head:${hostKey(domain)}`
  }
  private reportK(domain: string, digest: string): string {
    return `report:${hostKey(domain)}:${digest}`
  }
  private pinnedK(domain: string, specDigest: string): string {
    return `pinned:${hostKey(domain)}:${specDigest}`
  }

  /** Latest domain-mode verdict, if any. `fresh` = within the TTL window. */
  async getDomain(domain: string, nowMs: number = Date.now()): Promise<CacheHit<VerificationReport> | null> {
    const headRaw = await this.kv.get(this.headK(domain))
    if (!headRaw) return null
    const head = JSON.parse(headRaw) as HeadPointer
    const raw = await this.kv.get(this.reportK(domain, head.digest))
    if (!raw) return null
    const cached = JSON.parse(raw) as CachedReport<VerificationReport>
    const ageMs = Math.max(0, nowMs - head.probedAtMs)
    return { report: cached.report, ageMs, fresh: ageMs < this.ttlSeconds * 1000 }
  }

  async putDomain(domain: string, report: VerificationReport, nowMs: number = Date.now()): Promise<void> {
    const digest = report.discovery.evidenceDigest
    await this.kv.put(
      this.reportK(domain, digest),
      JSON.stringify({ report, storedAtMs: nowMs } satisfies CachedReport<VerificationReport>),
      { expirationTtl: this.ttlSeconds },
    )
    await this.kv.put(
      this.headK(domain),
      JSON.stringify({ digest, probedAtMs: nowMs } satisfies HeadPointer),
      { expirationTtl: this.ttlSeconds },
    )
  }

  /** Replay lookup: a specific verdict by its evidence digest. */
  async getByDigest(domain: string, digest: string): Promise<VerificationReport | null> {
    const raw = await this.kv.get(this.reportK(domain, digest))
    return raw ? (JSON.parse(raw) as CachedReport<VerificationReport>).report : null
  }

  async getPinned(domain: string, specDigest: string, nowMs: number = Date.now()): Promise<CacheHit<PinnedReport> | null> {
    const raw = await this.kv.get(this.pinnedK(domain, specDigest))
    if (!raw) return null
    const cached = JSON.parse(raw) as CachedReport<PinnedReport>
    const ageMs = Math.max(0, nowMs - cached.storedAtMs)
    return { report: cached.report, ageMs, fresh: ageMs < this.ttlSeconds * 1000 }
  }

  async putPinned(domain: string, specDigest: string, report: PinnedReport, nowMs: number = Date.now()): Promise<void> {
    await this.kv.put(
      this.pinnedK(domain, specDigest),
      JSON.stringify({ report, storedAtMs: nowMs } satisfies CachedReport<PinnedReport>),
      { expirationTtl: this.ttlSeconds },
    )
  }

  // --- Reusable suites -----------------------------------------------------

  private suiteTextK(digest: string): string {
    return `suitetext:${digest}`
  }
  private suiteK(target: string, suiteDigest: string, envName: string): string {
    return `suite:${hostKey(target)}:${suiteDigest}:${envName}`
  }

  /**
   * The suite REGISTRY: content-addressed suite text stored by its digest so a
   * later request can run a STORED suite by digest alone. This is a durable
   * registry, not the freshness cache, so it is not TTL-expired here — the
   * digest is the identity, and the SAME digest is always the SAME suite text.
   */
  async putSuiteText(digest: string, text: string): Promise<void> {
    await this.kv.put(this.suiteTextK(digest), text)
  }
  async getSuiteText(digest: string): Promise<string | null> {
    return this.kv.get(this.suiteTextK(digest))
  }

  /** A prior suite verdict, keyed by (target, suite digest, environment). */
  async getSuite(
    target: string,
    suiteDigest: string,
    envName: string,
    nowMs: number = Date.now(),
  ): Promise<CacheHit<SuiteReport> | null> {
    const raw = await this.kv.get(this.suiteK(target, suiteDigest, envName))
    if (!raw) return null
    const cached = JSON.parse(raw) as CachedReport<SuiteReport>
    const ageMs = Math.max(0, nowMs - cached.storedAtMs)
    return { report: cached.report, ageMs, fresh: ageMs < this.ttlSeconds * 1000 }
  }

  async putSuite(
    target: string,
    suiteDigest: string,
    envName: string,
    report: SuiteReport,
    nowMs: number = Date.now(),
  ): Promise<void> {
    await this.kv.put(
      this.suiteK(target, suiteDigest, envName),
      JSON.stringify({ report, storedAtMs: nowMs } satisfies CachedReport<SuiteReport>),
      { expirationTtl: this.ttlSeconds },
    )
  }
}

/**
 * In-memory KV double for tests — zero network. Honours reads/writes; ignores
 * `expirationTtl` (TTL semantics are exercised by advancing the injected clock
 * against the stored timestamps, not by wall-clock eviction).
 */
export class MemoryKV implements KVLike {
  private readonly store = new Map<string, string>()
  async get(key: string): Promise<string | null> {
    return this.store.has(key) ? (this.store.get(key) as string) : null
  }
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value)
  }
  get size(): number {
    return this.store.size
  }
  keys(): string[] {
    return [...this.store.keys()]
  }
}
