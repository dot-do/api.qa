import { describe, it, expect } from 'vitest'
import { generateSigningKey, attestReport, verifyAttestation, exportPrivateKey, importSigningKeyPair } from '../src/attest.js'
import { verifyTarget } from '../src/verify.js'
import { rejudge } from '../src/verify.js'
import { goodTargetRoutes, makeFetcher, GOOD } from './helpers.js'

async function attestedReport() {
  const keys = await generateSigningKey()
  const report = await verifyTarget(GOOD, {
    mode: 'remote', fetcher: makeFetcher(goodTargetRoutes()), delayMs: 0, seed: 42, signingKeys: keys,
  })
  return { report, keys }
}

describe('attestation', () => {
  it('signs remote reports; third parties verify with the embedded key', async () => {
    const { report } = await attestedReport()
    expect(report.attested).toBe(true)
    expect(report.attestation?.alg).toBe('Ed25519')
    expect(await verifyAttestation(report)).toBe(true)
  })

  it('any tampering with the report body breaks the signature', async () => {
    const { report } = await attestedReport()
    const forged = { ...report, grade: 'F' as const, axScore: { ...report.axScore, points: 0 } }
    expect(await verifyAttestation(forged)).toBe(false)
  })

  it('local-mode reports are never attested', async () => {
    const keys = await generateSigningKey()
    const report = await verifyTarget(GOOD, {
      mode: 'local', fetcher: makeFetcher(goodTargetRoutes()), delayMs: 0, signingKeys: keys,
    })
    expect(report.attested).toBe(false)
    expect(report.attestation).toBeUndefined()
  })

  it('rejudge over the embedded evidence reproduces the verdict', async () => {
    const { report } = await attestedReport()
    const result = await rejudge(report)
    expect(result.consistent).toBe(true)
    expect(result.grade).toBe(report.grade)
  })

  it('rejudge exposes a forged grade even before checking the signature', async () => {
    const { report } = await attestedReport()
    const forged = { ...report, grade: 'F' as const }
    const result = await rejudge(forged)
    expect(result.consistent).toBe(false)
  })

  it('round-trips a pkcs8 key (the Worker SIGNING_KEY path)', async () => {
    const keys = await generateSigningKey()
    const pkcs8 = await exportPrivateKey(keys.privateKey)
    const imported = await importSigningKeyPair(pkcs8)
    const report = await verifyTarget(GOOD, {
      mode: 'remote', fetcher: makeFetcher(goodTargetRoutes()), delayMs: 0, signingKeys: imported,
    })
    expect(await verifyAttestation(report)).toBe(true)
  })
})
