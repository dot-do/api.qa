/**
 * A SYNCHRONOUS SHA-256.
 *
 * WHY THIS EXISTS, since a second hash implementation is otherwise a smell.
 * `digest.ts`'s `sha256Hex` is the estate's hash, and it stays the hash — but it
 * is `async` because WebCrypto's `crypto.subtle.digest` is. `runChecks(bundle)`
 * is SYNCHRONOUS and PURE over the evidence bundle, and that purity is the
 * determinism contract the whole verifier rests on: the same bundle must yield
 * the same verdicts, on a live run and on a replay of a stored bundle, with no
 * I/O in between. Making `runChecks` async to await a digest would push `await`
 * through every judge in the file and into every caller.
 *
 * The `published-test-suite` check has to verify that the suite document the
 * target served hashes to the digest the target's own card pinned. The
 * alternative — compute the digest during the OBSERVE phase and record the
 * scalar for the judge to trust — is worse in the way that matters: on replay
 * the judge would re-read a recorded verdict about the bytes instead of
 * re-deriving it FROM the bytes. With a sync hash the check re-computes the
 * digest from the suite text stored in the bundle every time it judges, so a
 * tampered bundle fails the digest gate exactly as a tampered live response
 * does, and the anti-Goodhart pin survives serialization.
 *
 * Correctness is not asserted, it is TESTED: `test/sha256-sync.test.ts` checks
 * this implementation against the published FIPS-180-4 vectors AND against
 * `digest.ts`'s WebCrypto `sha256Hex` over empty, ASCII, multi-byte UTF-8,
 * block-boundary (55/56/63/64/119/120 byte) and multi-kilobyte inputs. If the
 * two ever disagree, that test fails and this file is wrong.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n))

/** sha256 of a UTF-8 string, lowercase hex. Synchronous by design (see above). */
export function sha256HexSync(text: string): string {
  const msg = new TextEncoder().encode(text)
  const bitLen = msg.length * 8

  // Pad: 0x80, then zeros, then the 64-bit big-endian bit length.
  const withLen = msg.length + 9
  const blocks = Math.ceil(withLen / 64)
  const buf = new Uint8Array(blocks * 64)
  buf.set(msg)
  buf[msg.length] = 0x80
  // Bit length as a 64-bit big-endian value. Lengths beyond 2^53 bits are not
  // representable in a JS number and cannot occur here (inputs are capped by
  // the observer's byte cap), so the high word is written from a float-safe
  // division rather than a BigInt.
  const view = new DataView(buf.buffer)
  view.setUint32(buf.length - 8, Math.floor(bitLen / 0x100000000), false)
  view.setUint32(buf.length - 4, bitLen >>> 0, false)

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ])
  const w = new Uint32Array(64)

  for (let b = 0; b < blocks; b++) {
    const off = b * 64
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4, false)
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15]!
      const y = w[i - 2]!
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10)
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0
    }
    let [a, bb, c, d, e, f, g, hh] = [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!]
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (hh + S1 + ch + K[i]! + w[i]!) >>> 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & bb) ^ (a & c) ^ (bb & c)
      const t2 = (S0 + maj) >>> 0
      hh = g; g = f; f = e
      e = (d + t1) >>> 0
      d = c; c = bb; bb = a
      a = (t1 + t2) >>> 0
    }
    h[0] = (h[0]! + a) >>> 0
    h[1] = (h[1]! + bb) >>> 0
    h[2] = (h[2]! + c) >>> 0
    h[3] = (h[3]! + d) >>> 0
    h[4] = (h[4]! + e) >>> 0
    h[5] = (h[5]! + f) >>> 0
    h[6] = (h[6]! + g) >>> 0
    h[7] = (h[7]! + hh) >>> 0
  }

  let out = ''
  for (let i = 0; i < 8; i++) out += h[i]!.toString(16).padStart(8, '0')
  return out
}
