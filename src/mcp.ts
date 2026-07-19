/**
 * MCP server (stdio, newline-delimited JSON-RPC) — dependency-free.
 * Tools: verify_domain, discover_domain, verify_pinned_spec.
 *
 * An agent that just built an API adds this server and asks "does it work?"
 * — the same verifier core answers, in local (advisory) mode.
 */

import { verifyTarget } from './verify.js'
import { verifyPinnedSpec } from './pinned.js'
import { VERIFIER_VERSION } from './verify.js'

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: number | string | null
  method: string
  params?: Record<string, unknown>
}

const TOOLS = [
  {
    name: 'verify_domain',
    description:
      'Run the full api.qa verification against a target domain or URL: discovery from its published machine surfaces (llms.txt, agents.json, icp.json, OpenAPI), contract-derived deterministic checks, AX score (0-10) and letter grade. Local mode: advisory, unsigned.',
    inputSchema: {
      type: 'object',
      required: ['target'],
      properties: {
        target: { type: 'string', description: 'Domain or URL, e.g. example.com or http://localhost:8787' },
        seed: { type: 'integer', description: 'Optional seed to replay a previous probe plan' },
      },
    },
  },
  {
    name: 'discover_domain',
    description:
      'Discovery only: fetch and parse the target\'s machine surfaces and return the DiscoveryReport (what the target claims to be) without grading it.',
    inputSchema: {
      type: 'object',
      required: ['target'],
      properties: { target: { type: 'string' } },
    },
  },
  {
    name: 'verify_pinned_spec',
    description:
      'Verify a target against a pinned spec document (the anti-Goodhart harness). If expectedDigest is supplied and the spec text does not hash to it, verification refuses to run. Use this as the acceptance gate of a build loop: the workers cannot pass by editing the spec.',
    inputSchema: {
      type: 'object',
      required: ['target', 'specText'],
      properties: {
        target: { type: 'string' },
        specText: { type: 'string', description: 'The PinnedSpec JSON, as exact text (the digest is over these bytes)' },
        expectedDigest: { type: 'string', description: 'sha256 hex the spec text must hash to' },
        seed: { type: 'integer' },
      },
    },
  },
]

export async function runMcpServer(io: { stdin?: NodeJS.ReadableStream; stdout?: NodeJS.WritableStream } = {}): Promise<void> {
  const stdin = io.stdin ?? process.stdin
  const stdout = io.stdout ?? process.stdout
  const write = (msg: unknown) => stdout.write(`${JSON.stringify(msg)}\n`)

  let buffer = ''
  stdin.setEncoding?.('utf8')
  for await (const chunk of stdin as AsyncIterable<string>) {
    buffer += chunk
    let idx: number
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (!line) continue
      let req: JsonRpcRequest
      try {
        req = JSON.parse(line) as JsonRpcRequest
      } catch {
        continue
      }
      const response = await handle(req)
      if (response !== undefined) write(response)
    }
  }
}

async function handle(req: JsonRpcRequest): Promise<unknown | undefined> {
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id: req.id ?? null, result })
  const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id: req.id ?? null, error: { code, message } })

  switch (req.method) {
    case 'initialize':
      return reply({
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'api.qa', version: VERIFIER_VERSION },
      })
    case 'notifications/initialized':
      return undefined
    case 'ping':
      return reply({})
    case 'tools/list':
      return reply({ tools: TOOLS })
    case 'tools/call': {
      const name = req.params?.name as string
      const args = (req.params?.arguments ?? {}) as Record<string, unknown>
      try {
        const result = await callTool(name, args)
        return reply({ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] })
      } catch (err) {
        return reply({
          content: [{ type: 'text', text: `error: ${err instanceof Error ? err.message : err}` }],
          isError: true,
        })
      }
    }
    default:
      return req.id !== undefined ? fail(-32601, `method not found: ${req.method}`) : undefined
  }
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const target = String(args.target ?? '')
  const seed = typeof args.seed === 'number' ? args.seed : undefined
  const local = /localhost|127\.0\.0\.1/.test(target)
  switch (name) {
    case 'verify_domain':
      return verifyTarget(target, { mode: 'local', seed, delayMs: local ? 0 : 150 })
    case 'discover_domain': {
      const report = await verifyTarget(target, { mode: 'local', seed, delayMs: local ? 0 : 150 })
      return report.discovery
    }
    case 'verify_pinned_spec':
      return verifyPinnedSpec(target, String(args.specText ?? ''), {
        mode: 'local',
        seed,
        expectedDigest: typeof args.expectedDigest === 'string' ? args.expectedDigest : undefined,
        delayMs: local ? 0 : 150,
      })
    default:
      throw new Error(`unknown tool: ${name}`)
  }
}
