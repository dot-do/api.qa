/**
 * entry.ts — the wrangler entry (wrangler.jsonc "main"), and NOTHING but the
 * mount plate. It re-exports the whole deployed surface of src/worker.ts —
 * the default { fetch, scheduled } handler plus the Durable Object classes
 * wrangler discovers as named exports of `main` — PLUS the workerd-only
 * SuiteGateway entrypoint (the A.8.6.3 egress gateway the SUITE_OUTBOUND
 * loopback service binding names).
 *
 * WHY A SEPARATE FILE: src/exec/gateway.ts imports `cloudflare:workers`,
 * which only the workerd runtime resolves — and the vitest suite imports
 * src/worker.ts directly (createApp and friends). So the runtime-only import
 * lives here, one file ABOVE the module every test resolves, and the test
 * graph never sees it (the same entry-only import trick the apis-vin worker
 * uses). test/suite-loader-enrollment.test.ts pins this split.
 */
export { default } from './worker.js'
export { DomainCooldown, MonitorSchedulerDO } from './worker.js'
export { SuiteGateway } from './exec/gateway.js'
