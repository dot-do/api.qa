/**
 * Observer body-read timeout (ax-gf2 slow-loris / slow-body-drip fix).
 *
 * The bug: `clearTimeout(timer)` fired BEFORE `readCapped(res)` streamed the
 * response body, so a server that returned 200 headers and then slow-lorised /
 * dripped the body held an api.qa probe open PAST timeoutMs (the 10s
 * AbortController), bounded only by maxBodyBytes (256KB). Affects EVERY api.qa
 * fetch, since all evidence flows through `observe`/`observeMcp` → `readCapped`.
 *
 * The fix keeps the abort timer ARMED across the body read: the AbortController
 * now fires DURING a slow body drip, aborts the underlying stream, and the read
 * surfaces a clean timeout error — so total connect+headers+body time is bounded
 * by timeoutMs, NOT just connect+headers.
 *
 * These tests wire a mock `Fetcher` that honors the observer's abort `signal`,
 * so a stalled body stream is actually errored when the timer fires — exactly
 * as real `fetch` aborts a body stream on `controller.abort()`.
 */

import { describe, it, expect } from 'vitest'
import { Observer, type Fetcher } from '../src/http.js'

/** An AbortError shaped exactly like the one real fetch throws on abort. */
function abortError(): Error {
  const e = new Error('The operation was aborted')
  e.name = 'AbortError'
  return e
}

describe('slow-body-drip is bounded by timeoutMs (ax-gf2)', () => {
  it('a 200-headers-then-drip body is aborted at ~timeoutMs, not held indefinitely', async () => {
    // A body stream that emits one tiny chunk then STALLS forever — the classic
    // slow-loris body. It errors (rejects the pending read) only when the
    // observer's abort signal fires, mirroring real fetch's body-stream abort.
    const fetcher: Fetcher = async (_url, init) => {
      const signal = init?.signal
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([104, 105])) // "hi"
          const onAbort = () => controller.error(abortError())
          if (signal) {
            if (signal.aborted) onAbort()
            else signal.addEventListener('abort', onAbort, { once: true })
          }
          // never enqueue more, never close → the next read() hangs until abort
        },
      })
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/plain' } })
    }
    const timeoutMs = 120
    const observer = new Observer({ fetcher, delayMs: 0, timeoutMs, maxBodyBytes: 262_144 })
    const t0 = Date.now()
    const ev = await observer.observe('probe:test', 'https://example.test/drip', { accept: '*/*' })
    const wall = Date.now() - t0

    // Bounded: the probe returned in roughly timeoutMs, NOT held open toward the
    // 256KB cap (which at drip speed would be effectively forever).
    expect(wall).toBeLessThan(timeoutMs * 8)
    // The drip is recorded as a clean timeout error — no hang, no unhandled
    // rejection, no crash. status is null (the request never completed).
    expect(ev.status).toBeNull()
    expect(ev.error).toMatch(/AbortError/)
  })

  it('observeMcp: a dripped MCP response body is also bounded by timeoutMs', async () => {
    const fetcher: Fetcher = async (_url, init) => {
      const signal = init?.signal
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([123])) // "{"
          const onAbort = () => controller.error(abortError())
          if (signal) {
            if (signal.aborted) onAbort()
            else signal.addEventListener('abort', onAbort, { once: true })
          }
        },
      })
      return new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const timeoutMs = 120
    const observer = new Observer({ fetcher, delayMs: 0, timeoutMs })
    const t0 = Date.now()
    const ev = await observer.observeMcp('mcp:remote', 'https://example.test/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize' })
    const wall = Date.now() - t0
    expect(wall).toBeLessThan(timeoutMs * 8)
    expect(ev.status).toBeNull()
    expect(ev.error).toMatch(/AbortError/)
  })
})

describe('no regression: legitimate bodies still read with the timer armed (ax-gf2)', () => {
  it('a normal fast streaming body is read fully and correctly (no false timeout)', async () => {
    const fetcher: Fetcher = async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"hello":"world"}'))
          controller.close()
        },
      })
      return new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } })
    }
    // A generous timeout that will NOT fire for a fast body.
    const observer = new Observer({ fetcher, delayMs: 0, timeoutMs: 5000, maxBodyBytes: 262_144 })
    const ev = await observer.observe('probe:test', 'https://example.test/json', { accept: 'application/json' })
    expect(ev.status).toBe(200)
    expect(ev.error).toBeUndefined()
    expect(ev.body).toBe('{"hello":"world"}')
    expect(JSON.parse(ev.body!)).toEqual({ hello: 'world' })
  })

  it('the maxBodyBytes cap still applies (fast oversized body truncates, no timeout error)', async () => {
    const maxBodyBytes = 1000
    const fetcher: Fetcher = async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          // 5 chunks * 64KB = 320KB, well over the 1000-byte cap, delivered fast.
          for (let i = 0; i < 5; i++) controller.enqueue(new Uint8Array(64 * 1024).fill(97))
          controller.close()
        },
      })
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/plain' } })
    }
    const observer = new Observer({ fetcher, delayMs: 0, timeoutMs: 5000, maxBodyBytes })
    const ev = await observer.observe('probe:test', 'https://example.test/big', { accept: '*/*' })
    expect(ev.status).toBe(200)
    expect(ev.error).toBeUndefined()
    expect(ev.body?.length).toBe(maxBodyBytes)
  })
})

describe('no regression: a normal (slow-headers) timeout still fires (ax-gf2)', () => {
  it('a target that stalls before returning headers is aborted at ~timeoutMs', async () => {
    // The fetch itself never resolves until the abort signal fires — the
    // pre-existing connect/headers timeout path, unchanged by this fix.
    const fetcher: Fetcher = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        if (signal) {
          if (signal.aborted) reject(abortError())
          else signal.addEventListener('abort', () => reject(abortError()), { once: true })
        }
      })
    const timeoutMs = 120
    const observer = new Observer({ fetcher, delayMs: 0, timeoutMs })
    const t0 = Date.now()
    const ev = await observer.observe('probe:test', 'https://example.test/stall', { accept: '*/*' })
    const wall = Date.now() - t0
    expect(wall).toBeLessThan(timeoutMs * 8)
    expect(ev.status).toBeNull()
    expect(ev.error).toMatch(/AbortError/)
  })
})
