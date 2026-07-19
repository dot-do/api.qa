/**
 * Attestation — Ed25519 over the canonicalised report. The signing key is
 * the ONE thing that must live outside every fleet's write access (a Worker
 * secret in production; see DESIGN.md). Anyone can verify a report with the
 * embedded public key; anyone can re-derive the report digest from the
 * canonical body; and the evidence bundle inside the report lets anyone
 * re-judge the verdicts. Signature + determinism = replayable attestation.
 */

import { canonicalJson, sha256Hex } from './digest.js'
import type { Attestation, VerificationReport } from './types.js'

const ED25519: EcKeyAlgorithm | { name: string } = { name: 'Ed25519' }

export function ed25519Supported(): boolean {
  return typeof crypto !== 'undefined' && !!crypto.subtle
}

export async function generateSigningKey(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey(ED25519, true, ['sign', 'verify'])) as CryptoKeyPair
}

export async function importSigningKey(pkcs8Base64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('pkcs8', fromB64(pkcs8Base64), ED25519, true, ['sign'])
}

/**
 * Import a pkcs8 private key AND derive its public half (via JWK) so the
 * Worker can attest from a single `SIGNING_KEY` secret.
 */
export async function importSigningKeyPair(pkcs8Base64: string): Promise<CryptoKeyPair> {
  const privateKey = await importSigningKey(pkcs8Base64)
  const jwk = await crypto.subtle.exportKey('jwk', privateKey)
  const publicJwk: JsonWebKey = { kty: jwk.kty, crv: jwk.crv, x: jwk.x }
  const publicKey = await crypto.subtle.importKey('jwk', publicJwk, ED25519, true, ['verify'])
  return { privateKey, publicKey }
}

export async function exportPrivateKey(key: CryptoKey): Promise<string> {
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', key)
  return b64(new Uint8Array(pkcs8))
}

/** Canonical body = the report without its attestation/attested fields. */
export function reportBody(report: VerificationReport): string {
  const { attestation: _a, attested: _b, ...body } = report
  return canonicalJson(body)
}

export async function attestReport(
  report: VerificationReport,
  keys: CryptoKeyPair,
): Promise<VerificationReport> {
  const body = reportBody(report)
  const reportDigest = await sha256Hex(body)
  const signature = await crypto.subtle.sign(ED25519, keys.privateKey, new TextEncoder().encode(reportDigest))
  const publicRaw = await crypto.subtle.exportKey('raw', keys.publicKey)
  const attestation: Attestation = {
    alg: 'Ed25519',
    publicKey: b64(new Uint8Array(publicRaw)),
    signature: b64(new Uint8Array(signature)),
    reportDigest,
  }
  return { ...report, attested: true, attestation }
}

/** Third-party verification: re-derive digest, check the signature. */
export async function verifyAttestation(report: VerificationReport): Promise<boolean> {
  if (!report.attestation) return false
  const { publicKey, signature, reportDigest } = report.attestation
  const expected = await sha256Hex(reportBody(report))
  if (expected !== reportDigest) return false
  const key = await crypto.subtle.importKey('raw', fromB64(publicKey), ED25519, true, ['verify'])
  return crypto.subtle.verify(ED25519, key, fromB64(signature), new TextEncoder().encode(reportDigest))
}

function b64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

function fromB64(text: string): Uint8Array<ArrayBuffer> {
  const bin = atob(text)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
