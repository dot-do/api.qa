/**
 * Metering / money-event SEAMS (property-template §7.4, fn-it wave zero).
 *
 * The property EMITS usage and money events at its own seams; it never
 * contains account UI, key management, invoicing, or payout logic — those
 * live behind the platform doors when they exist. Every event carries the
 * experiment rollup key `{ substrate, projection, motion, operation, shape,
 * pattern }` (template §6.4) plus the §9.3 diagnostic fields: identity class
 * (human vs machine, by the AXP A.7.4 agent-UA token list — id.org.ai grain
 * is a seam, not yet wired) and referral source.
 *
 * Transport: an Analytics Engine dataset when the `METERING` binding is
 * present; otherwise one structured JSON log line per event. Absence of the
 * binding never affects request handling (presence-when-true).
 */

import { AGENT_UA_PATTERN } from './self.js'

/** The G4 projection constants for this deployment (config/projection.api.qa.json). */
export const PROJECTION = {
  substrate: 'fn-it',
  projection: 'api.qa',
  motion: 'B2D',
  pattern: 'freemium-ladder',
} as const

export interface MeterEvent {
  kind: 'metering' | 'money' | 'receipt'
  substrate: string
  projection: string
  motion: string
  /** OpenAPI operationId (the only things a rate card may price). */
  operation: string
  /** Offer shape the call rode: anon-sandbox | metered-offer | … */
  shape: string
  pattern: string
  /** §9.3 identity class: human | machine | unknown (UA-token grain today). */
  identityClass: 'human' | 'machine' | 'unknown'
  /** Referral source when the request names one (Referer header). */
  referral?: string
  at: string
}

/** Minimal Analytics Engine surface (avoids a workers-types dependency). */
export interface MeteringSink {
  writeDataPoint(point: { blobs?: string[]; doubles?: number[]; indexes?: string[] }): void
}

export function classifyIdentity(userAgent: string | null): MeterEvent['identityClass'] {
  if (userAgent === null || userAgent === '') return 'unknown'
  return AGENT_UA_PATTERN.test(userAgent) ? 'machine' : 'human'
}

/**
 * Emit one event at a seam. Never throws; never blocks the response path.
 */
export function emitMeter(
  sink: MeteringSink | undefined,
  request: { headers: { get(name: string): string | null } },
  operation: string,
  shape: string,
  kind: MeterEvent['kind'] = 'metering',
): void {
  try {
    const event: MeterEvent = {
      kind,
      ...PROJECTION,
      operation,
      shape,
      identityClass: classifyIdentity(request.headers.get('user-agent')),
      ...(request.headers.get('referer') ? { referral: request.headers.get('referer')! } : {}),
      at: new Date().toISOString(),
    }
    if (sink) {
      sink.writeDataPoint({
        blobs: [event.kind, event.substrate, event.projection, event.motion, event.operation, event.shape, event.pattern, event.identityClass, event.referral ?? ''],
        doubles: [1],
        indexes: [event.operation],
      })
    } else {
      console.log(JSON.stringify({ seam: 'meter', ...event }))
    }
  } catch {
    // A seam must never take down the rail it observes.
  }
}
