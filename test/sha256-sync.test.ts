import { describe, it, expect } from 'vitest'
import { sha256HexSync } from '../src/sha256-sync.js'
import { sha256Hex } from '../src/digest.js'

/**
 * `sha256-sync.ts` exists only because `runChecks` is synchronous and WebCrypto
 * is not (see that file's header). A second hash implementation is only
 * acceptable if it is PROVED equal to the first, so this suite is the proof:
 * published FIPS-180-4 vectors, then agreement with the estate's WebCrypto
 * `sha256Hex` across every shape that has ever broken a hand-written SHA-256 —
 * the padding block boundaries above all.
 */
describe('sha256HexSync', () => {
  it('matches the published FIPS-180-4 vectors', () => {
    expect(sha256HexSync('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256HexSync('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(sha256HexSync('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    )
    expect(sha256HexSync('abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu')).toBe(
      'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1',
    )
  })

  it('agrees with WebCrypto sha256Hex on the padding block boundaries', async () => {
    // 55/56 straddle the "length fits in this block" boundary; 63/64 the block
    // size itself; 119/120 the two-block equivalent. These are where a
    // hand-written padding implementation goes wrong and nowhere else.
    for (const n of [0, 1, 54, 55, 56, 57, 63, 64, 65, 118, 119, 120, 121, 127, 128, 129]) {
      const s = 'a'.repeat(n)
      expect(sha256HexSync(s), `length ${n}`).toBe(await sha256Hex(s))
    }
  })

  it('agrees with WebCrypto sha256Hex on multi-byte UTF-8 and large inputs', async () => {
    const cases = [
      'héllo wörld',           // 2-byte sequences
      '日本語テキスト',           // 3-byte sequences
      '🧪🔬 emoji surrogate pairs', // 4-byte sequences
      JSON.stringify({ $type: 'Suite', name: 'x', requirements: [{ id: 'a' }] }),
      'x'.repeat(10_000),
      Array.from({ length: 2000 }, (_, i) => `line ${i}\n`).join(''),
    ]
    for (const s of cases) {
      expect(sha256HexSync(s), JSON.stringify(s.slice(0, 24))).toBe(await sha256Hex(s))
    }
  })

  it('is sensitive to a single-byte change (the whole point of the pin)', () => {
    const a = sha256HexSync('{"$type":"Suite","name":"a"}')
    const b = sha256HexSync('{"$type":"Suite","name":"b"}')
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })
})
