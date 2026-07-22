/**
 * Observer.readCapped memory-DoS fix (ax-e6b.38 MED): `await res.text()` used
 * to buffer the ENTIRE response body before slicing to `maxBodyBytes` — peak
 * memory was unbounded, so a malicious target streaming a huge/unbounded body
 * could exhaust memory on ANY api.qa fetch call site (every role's evidence
 * goes through this one function). The fix is two layers:
 *
 *   1. A declared `Content-Length` that already exceeds the cap is rejected
 *      BEFORE reading any of the body (the stream is never pulled at all).
 *   2. Otherwise, the body is read via a STREAMING reader that accumulates
 *      chunks only up to the cap, then cancels the rest of the stream — so a
 *      target with no (or an understated) Content-Length can never force an
 *      unbounded buffer either.
 *
 * These tests prove BOTH layers directly against `Observer.observe`, using a
 * hand-rolled `ReadableStream` whose `pull()` we count — the count itself is
 * the proof that the observer never drained more of the stream than the cap
 * requires.
 */

import { describe, it, expect } from 'vitest'
import { Observer, type Fetcher } from '../src/http.js'

describe('Content-Length fast-path: a declared oversized body is refused before reading', () => {
  it('never reads or accumulates any body bytes when Content-Length already exceeds maxBodyBytes', async () => {
    // A bare `ReadableStream` eagerly invokes `pull()` ONCE right after
    // construction regardless of whether anything ever reads from it — that
    // is inherent Streams-spec queue-priming behavior, not something the
    // observer controls or can prevent. What the observer MUST guarantee is
    // that it never calls `reader.read()` (so it never accumulates any of
    // that data) and cancels the stream immediately — bounding retained
    // memory to (at most) whatever the stream's own priming enqueued, never
    // the declared 10MB body.
    let pulls = 0
    let readCalls = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++
        controller.enqueue(new Uint8Array(1024))
      },
    })
    const realGetReader = stream.getReader.bind(stream)
    stream.getReader = (() => {
      readCalls++
      return realGetReader()
    }) as typeof stream.getReader
    const fetcher: Fetcher = async () =>
      new Response(stream, {
        status: 200,
        headers: { 'content-length': String(10_000_000), 'content-type': 'text/plain' },
      })
    const observer = new Observer({ fetcher, delayMs: 0, maxBodyBytes: 100 })
    const ev = await observer.observe('probe:test', 'https://example.test/big', { accept: '*/*' })
    expect(ev.status).toBe(200)
    expect(ev.body).toBe('')
    // The observer never even asks for a reader — let alone reads from one —
    // so it can never accumulate the declared-oversized body.
    expect(readCalls).toBe(0)
    // At most the stream's own automatic queue-priming pull ran; the observer
    // triggered no additional pulls of its own.
    expect(pulls).toBeLessThanOrEqual(1)
  })

  it('a Content-Length AT or under the cap is read normally (no behavior change for honest bodies)', async () => {
    const fetcher: Fetcher = async () =>
      new Response('hello world', {
        status: 200,
        headers: { 'content-length': '11', 'content-type': 'text/plain' },
      })
    const observer = new Observer({ fetcher, delayMs: 0, maxBodyBytes: 100 })
    const ev = await observer.observe('probe:test', 'https://example.test/small', { accept: '*/*' })
    expect(ev.body).toBe('hello world')
  })
})

describe('streaming cap: a body with no/understated Content-Length is bounded without full buffering', () => {
  it('stops pulling the stream once maxBodyBytes is reached, far short of the full size', async () => {
    const CHUNK = new Uint8Array(64 * 1024).fill(97) // 64KB chunks of 'a'
    const TOTAL_CHUNKS = 200 // ~12.8MB if fully drained
    let pulls = 0
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++
        if (pulls > TOTAL_CHUNKS) {
          controller.close()
          return
        }
        controller.enqueue(CHUNK)
      },
      cancel() {
        cancelled = true
      },
    })
    const maxBodyBytes = 1000
    const fetcher: Fetcher = async () =>
      new Response(stream, { status: 200, headers: { 'content-type': 'text/plain' } }) // NO content-length
    const observer = new Observer({ fetcher, delayMs: 0, maxBodyBytes })
    const ev = await observer.observe('probe:test', 'https://example.test/huge', { accept: '*/*' })
    expect(ev.status).toBe(200)
    expect(ev.body?.length).toBe(maxBodyBytes)
    // The proof: only a tiny handful of chunks were ever pulled (NOT all 200+),
    // and the stream was actively cancelled rather than drained to completion.
    expect(pulls).toBeLessThan(5)
    expect(cancelled).toBe(true)
  })

  it('decodes the accumulated bytes as UTF-8, preserving normal (under-cap) body behavior', async () => {
    const fetcher: Fetcher = async () => new Response('{"hello":"world"}', { status: 200 })
    const observer = new Observer({ fetcher, delayMs: 0, maxBodyBytes: 262_144 })
    const ev = await observer.observe('probe:test', 'https://example.test/json', { accept: 'application/json' })
    expect(ev.body).toBe('{"hello":"world"}')
    expect(JSON.parse(ev.body!)).toEqual({ hello: 'world' })
  })

  it('a multi-byte UTF-8 body under the cap decodes correctly (no byte-boundary corruption)', async () => {
    const body = '日本語 café 🎉'.repeat(50)
    const fetcher: Fetcher = async () => new Response(body, { status: 200 })
    const observer = new Observer({ fetcher, delayMs: 0, maxBodyBytes: 262_144 })
    const ev = await observer.observe('probe:test', 'https://example.test/utf8', { accept: '*/*' })
    expect(ev.body).toBe(body)
  })
})
