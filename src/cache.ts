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

import { normalizeTarget } from './http.js'
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

/**
 * The NORMALIZED-ORIGIN key (scheme + host + port) for a target, via the same
 * `normalizeTarget` the verifier itself runs — so the cache keys on the exact
 * identity a run executes against. hostKey() strips scheme AND port, so two runs
 * against the SAME host on different ports/schemes (http://h:8787 vs
 * https://h:9999) would otherwise COLLIDE and serve each other a stale/wrong
 * verdict for a DIFFERENT service. The verdict caches (pinned/suite) key on this
 * origin instead (ax-4c4). `allowPrivate` is on so a consented local target
 * (http://localhost:8787) still gets a stable, distinct origin key; an
 * un-normalizable input falls back to hostKey rather than throwing.
 */
export function originKey(target: string): string {
  const n = normalizeTarget(target, true)
  return 'origin' in n ? n.origin.toLowerCase() : hostKey(target)
}

/**
 * Bucket the (optional) verifier RNG seed into a cache-key segment. A run's
 * `seed` field is part of the report and is NOT invariant across seeds (a
 * pinned spec can bind sampled/randomized behavior into it), so a verdict
 * cache keyed WITHOUT the seed would serve a request for a specific seed the
 * FIRST run's report — including its now-stale `seed` field — misreporting
 * which seed the returned verdict actually ran under. Keying on the
 * (unresolved) requested seed, rather than the resolved one baked into the
 * eventual report, keeps the key decidable BEFORE any run: an explicit seed
 * always gets its own bucket (re-runs on a different seed), while omitting
 * `seed` on every call keeps sharing one bucket (a caller that never asked
 * for a specific seed is truthfully served whichever seed answered).
 */
function seedKey(seed: number | undefined): string {
  return seed === undefined ? 'auto' : String(seed)
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
  private pinnedK(domain: string, specDigest: string, seed: number | undefined): string {
    // Keyed on the normalized ORIGIN (scheme+host+port), not hostKey — a run on
    // a different port/scheme of the same host is a DIFFERENT service and must
    // NOT share a verdict entry (ax-4c4).
    return `pinned:${originKey(domain)}:${specDigest}:${seedKey(seed)}`
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

  async getPinned(
    domain: string,
    specDigest: string,
    seed: number | undefined,
    nowMs: number = Date.now(),
  ): Promise<CacheHit<PinnedReport> | null> {
    const raw = await this.kv.get(this.pinnedK(domain, specDigest, seed))
    if (!raw) return null
    const cached = JSON.parse(raw) as CachedReport<PinnedReport>
    const ageMs = Math.max(0, nowMs - cached.storedAtMs)
    return { report: cached.report, ageMs, fresh: ageMs < this.ttlSeconds * 1000 }
  }

  async putPinned(
    domain: string,
    specDigest: string,
    seed: number | undefined,
    report: PinnedReport,
    nowMs: number = Date.now(),
  ): Promise<void> {
    await this.kv.put(
      this.pinnedK(domain, specDigest, seed),
      JSON.stringify({ report, storedAtMs: nowMs } satisfies CachedReport<PinnedReport>),
      { expirationTtl: this.ttlSeconds },
    )
  }

  // --- Reusable suites -----------------------------------------------------

  private suiteTextK(digest: string): string {
    return `suitetext:${digest}`
  }
  private suiteK(target: string, suiteDigest: string, envName: string, seed: number | undefined): string {
    // Normalized ORIGIN, not hostKey — same-host/different-port is a distinct
    // service and must not cross-serve a cached suite verdict (ax-4c4).
    return `suite:${originKey(target)}:${suiteDigest}:${envName}:${seedKey(seed)}`
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

  // --- Mock server (ax-e6b.28.3) -------------------------------------------

  private mockSpecK(digest: string): string {
    return `mockspec:${digest}`
  }

  private static readonly MOCK_SPEC_INDEX_KEY = 'mockspecs:index'

  private async mockSpecIndex(): Promise<string[]> {
    const raw = await this.kv.get(ReportCache.MOCK_SPEC_INDEX_KEY)
    if (!raw) return []
    try {
      const ids = JSON.parse(raw) as unknown
      return Array.isArray(ids) ? (ids as string[]) : []
    } catch {
      return []
    }
  }

  /**
   * The mock REGISTRY: content-addressed OpenAPI spec text stored by its digest
   * so `GET /mock/:digest/<path>` can serve a generated response by digest
   * alone. Durable (not TTL-expired) like the suite registry — the digest is
   * the identity, and the SAME digest is always the SAME spec text. An index
   * key tracks every registered digest so the Worker can enforce
   * `MAX_MOCK_SPECS` (mirrors the monitors registry's own index — KVLike has
   * no native list/count operation).
   */
  async putMockSpec(digest: string, text: string): Promise<void> {
    await this.kv.put(this.mockSpecK(digest), text)
    const ids = await this.mockSpecIndex()
    if (!ids.includes(digest)) {
      ids.push(digest)
      await this.kv.put(ReportCache.MOCK_SPEC_INDEX_KEY, JSON.stringify(ids))
    }
  }
  async getMockSpec(digest: string): Promise<string | null> {
    return this.kv.get(this.mockSpecK(digest))
  }

  /** Count of DISTINCT registered mock specs — the MAX_MOCK_SPECS cap check. */
  async countMockSpecs(): Promise<number> {
    return (await this.mockSpecIndex()).length
  }

  /** A prior suite verdict, keyed by (target, suite digest, environment, seed). */
  async getSuite(
    target: string,
    suiteDigest: string,
    envName: string,
    seed: number | undefined,
    nowMs: number = Date.now(),
  ): Promise<CacheHit<SuiteReport> | null> {
    const raw = await this.kv.get(this.suiteK(target, suiteDigest, envName, seed))
    if (!raw) return null
    const cached = JSON.parse(raw) as CachedReport<SuiteReport>
    const ageMs = Math.max(0, nowMs - cached.storedAtMs)
    return { report: cached.report, ageMs, fresh: ageMs < this.ttlSeconds * 1000 }
  }

  async putSuite(
    target: string,
    suiteDigest: string,
    envName: string,
    seed: number | undefined,
    report: SuiteReport,
    nowMs: number = Date.now(),
  ): Promise<void> {
    await this.kv.put(
      this.suiteK(target, suiteDigest, envName, seed),
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
