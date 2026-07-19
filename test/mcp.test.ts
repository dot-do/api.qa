import { describe, it, expect } from 'vitest'
import { PassThrough } from 'node:stream'
import { runMcpServer } from '../src/mcp.js'

async function roundTrip(messages: object[]): Promise<unknown[]> {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const done = runMcpServer({ stdin, stdout })
  for (const m of messages) stdin.write(`${JSON.stringify(m)}\n`)
  stdin.end()
  await done
  const out = stdout.read()?.toString() ?? ''
  return out.split('\n').filter(Boolean).map((l: string) => JSON.parse(l))
}

describe('mcp server (stdio, newline-delimited JSON-RPC)', () => {
  it('initializes and lists the three verifier tools', async () => {
    const replies = await roundTrip([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ])
    expect(replies).toHaveLength(2)
    const init = replies[0] as { result: { serverInfo: { name: string } } }
    expect(init.result.serverInfo.name).toBe('api.qa')
    const tools = (replies[1] as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name)
    expect(tools).toEqual(['verify_domain', 'discover_domain', 'verify_pinned_spec'])
  })

  it('answers unknown methods with a JSON-RPC error', async () => {
    const replies = await roundTrip([{ jsonrpc: '2.0', id: 9, method: 'nope' }])
    expect((replies[0] as { error: { code: number } }).error.code).toBe(-32601)
  })
})
