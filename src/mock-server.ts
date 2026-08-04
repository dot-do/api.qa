/**
 * Local deterministic MOCK SERVER CLI engine (ax-gyh).
 *
 * Stands up a REAL local HTTP server from a published OpenAPI 3.1 spec so the
 * offline loop `mock -> run suite against it -> teardown` works in a network-
 * isolated pipeline. It REUSES the pure mock core (mock.ts): every response is
 * generated LOCALLY from the stored spec by `serveMock` (deterministic under a
 * seed, schema-conformant by construction). An UNDECLARED (method, path) 404s.
 *
 * SSRF: the mock only ever SERVES local generated responses — it NEVER fetches
 * anything (no outbound surface). The one network primitive here is BINDING a
 * listening socket on the requested port; there is no client fetch of any kind.
 */

import { createServer, type Server } from 'node:http'
import { serveMock, DEFAULT_MOCK_SEED } from './mock.js'

export interface MockServeResult {
  status: number
  contentType: string
  body: string
}

/**
 * Resolve one mock request against a stored spec — PURE, testable without a
 * socket. Delegates to `serveMock` (deterministic under `seed`); an operation
 * the spec does not declare yields a 404 JSON body, so an undeclared path is a
 * hard, honest miss rather than a silent 200.
 */
export function handleMockRequest(
  doc: unknown,
  method: string,
  path: string,
  accept: string | undefined,
  seed: number = DEFAULT_MOCK_SEED,
): MockServeResult {
  const served = serveMock(doc, method, path, { seed, ...(accept ? { accept } : {}) })
  if (!served) {
    return {
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: `mock declares no ${method.toUpperCase()} ${path}` }),
    }
  }
  return { status: served.status, contentType: served.contentType, body: served.body }
}

export interface MockServerOptions {
  /** Seed for the deterministic body generator (default DEFAULT_MOCK_SEED). */
  seed?: number
}

/**
 * Build (but do not start) a node http server that serves the stored spec's
 * declared operations deterministically. The caller `listen`s it; the handler
 * never touches the network.
 */
export function createMockServer(doc: unknown, opts: MockServerOptions = {}): Server {
  const seed = opts.seed ?? DEFAULT_MOCK_SEED
  return createServer((req, res) => {
    const method = (req.method ?? 'GET').toUpperCase()
    // Parse the path off the request URL. The host is irrelevant (local mock),
    // so a fixed base is used purely to split path from query.
    let path = '/'
    try {
      path = new URL(req.url ?? '/', 'http://mock.local').pathname
    } catch {
      path = req.url ?? '/'
    }
    const accept = typeof req.headers.accept === 'string' ? req.headers.accept : undefined
    // Drain any request body (mock never reads it) so the socket frees cleanly.
    req.resume()
    const out = handleMockRequest(doc, method, path, accept, seed)
    res.writeHead(out.status, { 'content-type': out.contentType })
    res.end(out.body)
  })
}

export interface StartedMockServer {
  server: Server
  port: number
  close: () => Promise<void>
}

/**
 * Start a local mock server listening on `port` (0 = an OS-assigned ephemeral
 * port, returned in `.port` — used by tests). Binds loopback only.
 */
export function startMockServer(doc: unknown, port: number, opts: MockServerOptions = {}): Promise<StartedMockServer> {
  const server = createMockServer(doc, opts)
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address()
      const boundPort = typeof addr === 'object' && addr ? addr.port : port
      resolve({
        server,
        port: boundPort,
        close: () =>
          new Promise<void>((res, rej) => server.close((err) => (err ? rej(err) : res()))),
      })
    })
  })
}
