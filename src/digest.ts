/**
 * Canonical JSON + sha256 + a seeded PRNG.
 *
 * Canonicalisation (sorted keys, no whitespace) is what makes digests and
 * signatures replayable: two runs that observed the same target state
 * produce byte-identical canonical forms.
 */

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value))
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key]
      if (v !== undefined) out[key] = sortValue(v)
    }
    return out
  }
  return value
}

export async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Deterministic PRNG (mulberry32). The seed is chosen fresh per attested run
 * and RECORDED in the report — replayable after the fact, unpredictable
 * before it (see DESIGN.md, attack #4: probe-pattern overfitting).
 */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Sample up to n items deterministically under a seed. Order-stable input. */
export function sampleSeeded<T>(items: T[], n: number, seed: number): T[] {
  const rand = seededRandom(seed)
  const pool = [...items]
  const out: T[] = []
  while (pool.length > 0 && out.length < n) {
    const i = Math.floor(rand() * pool.length)
    out.push(...pool.splice(i, 1))
  }
  return out
}
