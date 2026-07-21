import { describe, it, expect } from 'vitest'
import {
  decideCooldown,
  MemoryCooldown,
  DomainCooldown,
  DurableObjectCooldown,
  type DOStorage,
  type DOState,
  type DONamespaceLike,
} from '../src/cooldown.js'

describe('decideCooldown (pure policy)', () => {
  it('allows the first probe of a domain', () => {
    expect(decideCooldown(1000, undefined, 60_000)).toEqual({ allowed: true, retryAfterMs: 0 })
  })
  it('denies a second probe inside the interval and reports the wait', () => {
    expect(decideCooldown(1000 + 20_000, 1000, 60_000)).toEqual({ allowed: false, retryAfterMs: 40_000 })
  })
  it('allows again once the interval has fully elapsed', () => {
    expect(decideCooldown(1000 + 60_000, 1000, 60_000)).toEqual({ allowed: true, retryAfterMs: 0 })
  })
})

describe('MemoryCooldown', () => {
  it('gates repeat probes of one domain but not distinct domains', async () => {
    let t = 0
    const cd = new MemoryCooldown(60_000, () => t)
    expect((await cd.reserve('a.example')).allowed).toBe(true)
    // second probe of a.example inside the window is denied
    t = 10_000
    const denied = await cd.reserve('a.example')
    expect(denied.allowed).toBe(false)
    expect(denied.retryAfterMs).toBe(50_000)
    // a different domain is independent
    expect((await cd.reserve('b.example')).allowed).toBe(true)
    // once the window passes, a.example is allowed again
    t = 61_000
    expect((await cd.reserve('a.example')).allowed).toBe(true)
  })
})

/** In-memory DO storage double — zero runtime, zero network. */
class MemoryDOStorage implements DOStorage {
  private m = new Map<string, unknown>()
  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.m.has(key) ? (this.m.get(key) as T) : undefined
  }
  async put<T = unknown>(key: string, value: T): Promise<void> {
    this.m.set(key, value)
  }
}

/** A fake DO namespace that routes idFromName(domain) to one DO instance,
 *  exactly like the runtime — proving cross-isolate sharing works. */
function fakeNamespace(): DONamespaceLike {
  const instances = new Map<string, DomainCooldown>()
  return {
    idFromName(name: string) {
      return name
    },
    get(id: unknown) {
      const key = String(id)
      if (!instances.has(key)) {
        const state: DOState = { storage: new MemoryDOStorage() }
        instances.set(key, new DomainCooldown(state))
      }
      return instances.get(key)!
    },
  }
}

describe('DomainCooldown DO + DurableObjectCooldown adapter', () => {
  it('shares one budget per domain across separate reserve() calls (isolates)', async () => {
    // A short interval keeps the wall-clock test fast and deterministic-enough:
    // two back-to-back reserves cannot both fall outside a 1s interval.
    const cd = new DurableObjectCooldown(fakeNamespace(), 1_000)

    const first = await cd.reserve('c.example')
    expect(first.allowed).toBe(true)

    const second = await cd.reserve('c.example')
    expect(second.allowed).toBe(false)
    expect(second.retryAfterMs).toBeGreaterThan(0)
    expect(second.retryAfterMs).toBeLessThanOrEqual(1_000)

    // distinct domain, distinct DO instance → allowed
    expect((await cd.reserve('d.example')).allowed).toBe(true)
  })

  it('DomainCooldown.fetch returns a JSON CooldownDecision', async () => {
    const state: DOState = { storage: new MemoryDOStorage() }
    const doInst = new DomainCooldown(state)
    const res = await doInst.fetch(
      new Request('https://cooldown.internal/reserve?domain=e.example&minIntervalMs=1000', { method: 'POST' }),
    )
    expect(res.headers.get('content-type')).toContain('application/json')
    const decision = (await res.json()) as { allowed: boolean }
    expect(decision.allowed).toBe(true)
  })
})
