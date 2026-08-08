/**
 * Minimal ambient declaration for the `cloudflare:workers` runtime module —
 * kept LOCAL and structural (the same stance as WorkerCodeLike in
 * src/exec/runner.ts) so the repo keeps compiling without
 * @cloudflare/workers-types. Declares only what src/exec/gateway.ts uses;
 * the real types come from the workerd runtime at deploy time.
 */
declare module 'cloudflare:workers' {
  /** Structural subset of the runtime's WorkerEntrypoint base class. */
  export abstract class WorkerEntrypoint<Env = unknown> {
    protected env: Env
    protected ctx: { waitUntil(promise: Promise<unknown>): void }
  }
}
