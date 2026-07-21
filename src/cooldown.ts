/**
 * Per-domain cooldown — the cross-isolate politeness budget
 * (DESIGN.md attack #9: "per-domain global cooldown is a deploy seam — needs
 * a DO"; wrangler.jsonc "DO: per-domain politeness budget across isolates").
 *
 * A fleet that fans a probe-cannon of `GET api.qa/{domain}` across many Worker
 * isolates would each keep a private budget — useless. One Durable Object per
 * domain (`env.COOLDOWN.idFromName(host)`) makes the minimum inter-probe
 * interval GLOBAL: however many isolates ask, only one probe per interval
 * fires against the third-party target.
 *
 * The decision is a pure function (`decideCooldown`) shared by the DO and the
 * in-memory test double, so the exact policy is unit-testable with zero
 * runtime and the DO class stays a thin storage/HTTP adapter over it.
 */

/** Minimum interval between probes of the same domain, across all isolates. */
export const DEFAULT_MIN_INTERVAL_MS = 60_000

export interface CooldownDecision {
  allowed: boolean
  /** ms until the next probe would be allowed (0 when allowed). */
  retryAfterMs: number
}

/** Pure policy: given the last probe time, may we probe this domain now? */
export function decideCooldown(
  nowMs: number,
  lastProbedAtMs: number | undefined,
  minIntervalMs: number,
): CooldownDecision {
  if (lastProbedAtMs === undefined) return { allowed: true, retryAfterMs: 0 }
  const elapsed = nowMs - lastProbedAtMs
  if (elapsed >= minIntervalMs) return { allowed: true, retryAfterMs: 0 }
  return { allowed: false, retryAfterMs: minIntervalMs - elapsed }
}

/**
 * The seam the Worker calls before probing a third party. `reserve` means
 * "I intend to probe {domain} now" — a truthy `allowed` both grants the probe
 * AND records that a probe is being spent (so a concurrent isolate is denied).
 */
export interface Cooldown {
  reserve(domain: string): Promise<CooldownDecision>
}

// ---------------------------------------------------------------------------
// In-memory double (single isolate) — for tests and no-DO local runs.
// ---------------------------------------------------------------------------

export class MemoryCooldown implements Cooldown {
  private readonly last = new Map<string, number>()
  constructor(
    private readonly minIntervalMs: number = DEFAULT_MIN_INTERVAL_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}
  async reserve(domain: string): Promise<CooldownDecision> {
    const nowMs = this.now()
    const decision = decideCooldown(nowMs, this.last.get(domain), this.minIntervalMs)
    if (decision.allowed) this.last.set(domain, nowMs)
    return decision
  }
}

// ---------------------------------------------------------------------------
// The Durable Object + its namespace-backed Cooldown adapter.
// ---------------------------------------------------------------------------

/** Structural subset of a DO's `state.storage` — injectable for tests. */
export interface DOStorage {
  get<T = unknown>(key: string): Promise<T | undefined>
  put<T = unknown>(key: string, value: T): Promise<void>
}
export interface DOState {
  storage: DOStorage
}

/** Structural subset of a `DurableObjectNamespace` — injectable for tests. */
export interface DOStub {
  fetch(request: Request): Promise<Response>
}
export interface DONamespaceLike {
  idFromName(name: string): unknown
  get(id: unknown): DOStub
}

/**
 * The Durable Object class. One instance per domain (via `idFromName(host)`),
 * so its single stored `lastProbedAt` is the global last-probe time for that
 * domain. Wrangler discovers it as a named export of the Worker main module.
 */
export class DomainCooldown {
  constructor(private readonly state: DOState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const domain = url.searchParams.get('domain') ?? 'unknown'
    const minIntervalMs = Number(url.searchParams.get('minIntervalMs')) || DEFAULT_MIN_INTERVAL_MS
    const nowMs = Date.now()
    const last = await this.state.storage.get<number>(`last:${domain}`)
    const decision = decideCooldown(nowMs, last, minIntervalMs)
    if (decision.allowed) await this.state.storage.put(`last:${domain}`, nowMs)
    return new Response(JSON.stringify(decision), {
      headers: { 'content-type': 'application/json' },
    })
  }
}

/** Cooldown backed by the real DO namespace (the deployed Worker path). */
export class DurableObjectCooldown implements Cooldown {
  constructor(
    private readonly ns: DONamespaceLike,
    private readonly minIntervalMs: number = DEFAULT_MIN_INTERVAL_MS,
  ) {}
  async reserve(domain: string): Promise<CooldownDecision> {
    const stub = this.ns.get(this.ns.idFromName(domain))
    const res = await stub.fetch(
      new Request(
        `https://cooldown.internal/reserve?domain=${encodeURIComponent(domain)}&minIntervalMs=${this.minIntervalMs}`,
        { method: 'POST' },
      ),
    )
    return (await res.json()) as CooldownDecision
  }
}
