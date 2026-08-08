/**
 * exec/gateway.ts — the deploy-time face of the A.8.6.3 egress gateway: a
 * named `WorkerEntrypoint` of THIS worker, bound back to itself in
 * wrangler.jsonc —
 *
 *   "services": [{ "binding": "SUITE_OUTBOUND", "service": "api-qa",
 *                  "entrypoint": "SuiteGateway" }]
 *
 * — the same same-worker-loopback shape the apis-vin exec rail deployed on
 * this account. Every fetch a suite isolate makes rides `globalOutbound` to
 * `SuiteGateway.fetch`, and the runner drains the out-of-band refusal record
 * through the `drainViolations` RPC on the same binding (auto-detected by
 * `workerLoaderExecRunner`'s `hasDrain`).
 *
 * ALL behavior lives in `createOutboundGateway` (src/exec/runner.ts), which
 * is unit-tested without this module: the floor per request AND per redirect
 * hop, the marked 403, the parent-owned violation sink. This class is a thin
 * mount, nothing more.
 *
 * THE SINK IS MODULE-LEVEL on purpose: workerd constructs a fresh entrypoint
 * INSTANCE per invocation, so an instance field would silently drop the
 * record between the isolate's fetches and the runner's later drain. A
 * loopback service binding to this same worker is served in-isolate, so the
 * module-level gateway is the shared record both sides see. Sharing one sink
 * across concurrent runs can only OVER-attribute a violation, which errs in
 * the closed direction (a run may be failed by a neighbour's refusal, never
 * passed by one) — the trade `createOutboundGateway`'s contract already
 * names. If the drain ever crosses isolates (a platform change), the record
 * comes back empty and the in-isolate violation channel still fails the run
 * for any non-forged suite — degraded, never open.
 *
 * This module imports `cloudflare:workers`, so ONLY the wrangler entry
 * (src/entry.ts) may import it — vitest imports src/worker.ts and never
 * resolves this file (the apis-vin entry-only import trick). Enforced by
 * test/suite-loader-enrollment.test.ts.
 */
import { WorkerEntrypoint } from 'cloudflare:workers'
import { createOutboundGateway, type OutboundGatewayLike } from './runner.js'
import type { GateViolation } from './dialect.js'

/** The isolate-global gateway instance — the one record both halves share. */
const gateway: OutboundGatewayLike = createOutboundGateway()

export class SuiteGateway extends WorkerEntrypoint {
  /** `globalOutbound` delivery: the floor, per request and per redirect hop. */
  async fetch(request: Request): Promise<Response> {
    return gateway.fetch(request)
  }

  /**
   * Hand the out-of-band refusal record to the runner and clear it — the
   * A.8.6.3 fail-closed half that makes a caught/absorbed refusal still fail
   * the run. Exposed as an RPC method so the SAME binding carries both halves.
   */
  async drainViolations(): Promise<GateViolation[]> {
    return gateway.drainViolations()
  }
}
