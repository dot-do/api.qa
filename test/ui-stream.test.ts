/**
 * AI SDK 5 UI-message-stream readiness (ax-rx1) — the streaming (SSE) analog of
 * the mcp-ui-* dimension. api.qa grades whether a target's DECLARED
 * `interfaces.uiMessageStream` face emits a spec-correct AI SDK 5 UI message
 * stream so an agent host (a chat surface) renders it TRUSTWORTHILY. Five
 * sub-signals, each graded ENFORCEMENT-FIRST (target-declared, verifier-armed):
 *   (1) transport   — `x-vercel-ai-ui-message-stream: v1` + `text/event-stream`
 *   (2) framing     — `data: {json}\n\n` chunks, a bare `data: [DONE]` terminal,
 *                     each payload a typed JSON part
 *   (3) part-shapes — every part spec-correct per AI SDK 5 (known type + fields;
 *                     flags delta/textDelta, args/input, result/output renames)
 *   (4) hygiene     — no secret in any part (reuses the shared secret detector)
 *   (5) parity      — tool-output-available `output` is byte/JSON-consistent
 *                     with the JSON twin (SKIP when no twin is observable)
 *
 * ACTIVATION: only when the card declares `interfaces.uiMessageStream`. A target
 * with NO stream face informationally SKIPs every sub-check (NOT a fail — it must
 * not tank the grade). A target that DECLARES the face but violates a sub-signal
 * FAILs and is graded DOWN honestly (a broken/leaky stream is worse than none).
 */

import { describe, it, expect } from 'vitest'
import { Observer } from '../src/http.js'
import { observeTarget } from '../src/discovery.js'
import { runChecks } from '../src/checks.js'
import { axScoreOf, gradeOf } from '../src/grade.js'
import { goodTargetRoutes, makeFetcher, GOOD, type Routes } from './helpers.js'
import type { CheckResult } from '../src/types.js'

const STREAM_PATH = '/api/chat/stream'
const TWIN_PATH = '/api/chat/data'
const STREAM_URL = `${GOOD}${STREAM_PATH}`
const TWIN_URL = `${GOOD}${TWIN_PATH}`

// The canonical projection the stream's tool-output MUST match (the parity twin).
const WIDGETS = { count: 3, widgets: [{ id: 'w1' }, { id: 'w2' }, { id: 'w3' }] }

/** A full, spec-correct AI SDK 5 UI-message-stream lifecycle (every part shape). */
function validParts(): Record<string, unknown>[] {
  return [
    { type: 'start' },
    { type: 'start-step' },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: 'Here are ' },
    { type: 'text-delta', id: 't1', delta: 'your widgets.' },
    { type: 'text-end', id: 't1' },
    { type: 'tool-input-start', toolCallId: 'c1', toolName: 'list_widgets' },
    { type: 'tool-input-delta', toolCallId: 'c1', inputTextDelta: '{}' },
    { type: 'tool-input-available', toolCallId: 'c1', toolName: 'list_widgets', input: {} },
    { type: 'tool-output-available', toolCallId: 'c1', output: WIDGETS },
    { type: 'data-widgets', id: 'd1', data: { count: 3 } },
    { type: 'finish-step' },
    { type: 'finish' },
  ]
}

interface DoneOpts {
  done?: boolean // append a terminal (default true)
  quotedDone?: boolean // append `data: "[DONE]"` (a JSON-quoted terminal — INVALID)
}

/** Serialize parts as an SSE UI-message-stream body. */
function sseFrom(parts: Record<string, unknown>[], o: DoneOpts = {}): string {
  let body = parts.map((p) => `data: ${JSON.stringify(p)}\n\n`).join('')
  if (o.quotedDone) body += `data: "[DONE]"\n\n`
  else if (o.done !== false) body += `data: [DONE]\n\n`
  return body
}

interface StreamOpts {
  noFace?: boolean // do NOT declare interfaces.uiMessageStream (⇒ every check SKIPs)
  parts?: Record<string, unknown>[]
  body?: string // raw SSE body override (for hand-crafted broken framing)
  header?: string | null // x-vercel-ai-ui-message-stream value; null ⇒ omit the header
  contentType?: string
  status?: number
  twin?: unknown // when defined, declare + serve a JSON twin at TWIN_PATH
  done?: boolean
  quotedDone?: boolean
}

/** A good.example target that additionally declares (or omits) a stream face. */
function uiStreamTarget(opts: StreamOpts = {}): Routes {
  const base = goodTargetRoutes()
  const agentsOut = base['GET /.well-known/agents.json']!({ method: 'GET', accept: 'application/json' })
  const agentsDoc = JSON.parse(agentsOut.body!) as Record<string, unknown>
  if (!opts.noFace) {
    const iface = (agentsDoc.interfaces ?? {}) as Record<string, unknown>
    iface.uiMessageStream = {
      url: STREAM_URL,
      ...(opts.twin !== undefined ? { twin: TWIN_URL } : {}),
    }
    agentsDoc.interfaces = iface
    base['GET /.well-known/agents.json'] = () => ({ status: 200, contentType: 'application/json', body: JSON.stringify(agentsDoc) })
    base[`GET ${STREAM_PATH}`] = () => ({
      status: opts.status ?? 200,
      contentType: opts.contentType ?? 'text/event-stream',
      headers: (opts.header === null ? {} : { 'x-vercel-ai-ui-message-stream': opts.header ?? 'v1' }) as Record<string, string>,
      body: opts.body ?? sseFrom(opts.parts ?? validParts(), opts),
    })
    if (opts.twin !== undefined) {
      base[`GET ${TWIN_PATH}`] = () => ({ status: 200, contentType: 'application/json', body: JSON.stringify(opts.twin) })
    }
  }
  return base
}

async function judge(opts: StreamOpts = {}) {
  const fetcher = makeFetcher(uiStreamTarget(opts))
  const observer = new Observer({ fetcher, delayMs: 0, budget: 48 })
  const bundle = await observeTarget(GOOD, observer, 7)
  const checks = runChecks(bundle)
  const score = axScoreOf(checks)
  const { grade } = gradeOf(score, checks)
  return { bundle, checks, score, grade }
}

function verdictOf(checks: CheckResult[], id: string) {
  return checks.find((c) => c.id === id)?.verdict
}
function detailOf(checks: CheckResult[], id: string) {
  return checks.find((c) => c.id === id)?.detail ?? ''
}

const STREAM_IDS = [
  'ui-stream-transport',
  'ui-stream-framing',
  'ui-stream-part-shapes',
  'ui-stream-envelope-hygiene',
  'ui-stream-parity',
] as const

// ---------------------------------------------------------------------------
// (a) A conformant UI-message-stream target passes every readiness sub-signal.
// ---------------------------------------------------------------------------

describe('a conformant UI-message-stream target passes the readiness signal', () => {
  it('valid header + framing + part shapes + clean parts + parity → all pass', async () => {
    const { checks } = await judge({ twin: WIDGETS })
    for (const id of STREAM_IDS) expect(verdictOf(checks, id), `${id}: ${detailOf(checks, id)}`).toBe('pass')
  })

  it('the readiness dimension is ADDITIVE — a clean stream does not cap the grade (stays A+)', async () => {
    const { score, grade, checks } = await judge({ twin: WIDGETS })
    for (const c of checks) expect(c.verdict, `${c.id}: ${c.detail}`).not.toBe('fail')
    expect(score.points).toBe(10)
    expect(grade).toBe('A+')
  })

  it('is deterministic — judging the same bundle twice is byte-identical', async () => {
    const fetcher = makeFetcher(uiStreamTarget({ twin: WIDGETS }))
    const observer = new Observer({ fetcher, delayMs: 0, budget: 48 })
    const bundle = await observeTarget(GOOD, observer, 7)
    expect(JSON.stringify(runChecks(bundle))).toBe(JSON.stringify(runChecks(bundle)))
  })

  it('does NOT false-fail a valid stream that carries legitimate extra parts (error/abort)', async () => {
    const parts = [
      ...validParts(),
      { type: 'error', errorText: 'transient upstream hiccup' },
      { type: 'abort' },
    ]
    const { checks } = await judge({ parts, twin: WIDGETS })
    for (const id of STREAM_IDS) expect(verdictOf(checks, id), `${id}: ${detailOf(checks, id)}`).toBe('pass')
  })
})

// ---------------------------------------------------------------------------
// (b) A target with NO stream face is informational not-ready (no over-block).
// ---------------------------------------------------------------------------

describe('a target with no UI-message-stream face is informational not-ready', () => {
  it('every readiness sub-check SKIPs and none fails', async () => {
    const { checks } = await judge({ noFace: true })
    for (const id of STREAM_IDS) expect(verdictOf(checks, id), `${id}: ${detailOf(checks, id)}`).toBe('skip')
    expect(detailOf(checks, 'ui-stream-transport')).toMatch(/no UI-message-stream face declared/i)
  })

  it('does not cap the grade — a non-streaming target still scores 10/10 and grades A+', async () => {
    const { score, grade, checks } = await judge({ noFace: true })
    for (const c of checks) expect(c.verdict, `${c.id}: ${c.detail}`).not.toBe('fail')
    expect(score.points).toBe(10)
    expect(grade).toBe('A+')
  })

  it('makes NO stream probe when the card declares no uiMessageStream interface', async () => {
    const { bundle } = await judge({ noFace: true })
    expect(bundle.items.find((e) => e.role === 'probe:ui-message-stream')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// (c) TRANSPORT — a bad/missing header or wrong content-type FAILs.
// ---------------------------------------------------------------------------

describe('transport: the v1 stream header + SSE content-type are enforced', () => {
  it('a MISSING x-vercel-ai-ui-message-stream header → transport FAILs', async () => {
    const { checks } = await judge({ header: null, twin: WIDGETS })
    expect(verdictOf(checks, 'ui-stream-transport')).toBe('fail')
    expect(detailOf(checks, 'ui-stream-transport')).toMatch(/x-vercel-ai-ui-message-stream/i)
  })

  it('a WRONG header value (v2) → transport FAILs', async () => {
    const { checks } = await judge({ header: 'v2' })
    expect(verdictOf(checks, 'ui-stream-transport')).toBe('fail')
  })

  it('a non-SSE content-type → transport FAILs', async () => {
    const { checks } = await judge({ contentType: 'application/json' })
    expect(verdictOf(checks, 'ui-stream-transport')).toBe('fail')
    expect(detailOf(checks, 'ui-stream-transport')).toMatch(/text\/event-stream/i)
  })

  it('a header/transport failure caps the grade below A+ (honesty cap)', async () => {
    const { grade } = await judge({ header: null, twin: WIDGETS })
    expect(grade).not.toBe('A+')
  })
})

// ---------------------------------------------------------------------------
// (d) FRAMING — broken SSE framing or a missing/quoted [DONE] FAILs.
// ---------------------------------------------------------------------------

describe('framing: SSE framing + a bare [DONE] terminal are enforced', () => {
  it('a chunk that is not `data: {json}` → framing FAILs', async () => {
    const body =
      `data: ${JSON.stringify({ type: 'start' })}\n\n` +
      `oops-this-is-not-a-data-line\n\n` +
      `data: [DONE]\n\n`
    const { checks } = await judge({ body })
    expect(verdictOf(checks, 'ui-stream-framing')).toBe('fail')
    expect(detailOf(checks, 'ui-stream-framing')).toMatch(/non-`?data/i)
  })

  it('no [DONE] terminal → framing FAILs', async () => {
    const { checks } = await judge({ done: false })
    expect(verdictOf(checks, 'ui-stream-framing')).toBe('fail')
    expect(detailOf(checks, 'ui-stream-framing')).toMatch(/\[DONE\]/)
  })

  it('a JSON-quoted terminal (`data: "[DONE]"`) → framing FAILs (must be bare)', async () => {
    const { checks } = await judge({ quotedDone: true, done: false })
    expect(verdictOf(checks, 'ui-stream-framing')).toBe('fail')
    expect(detailOf(checks, 'ui-stream-framing')).toMatch(/quoted|bare/i)
  })

  it('a data payload that is not JSON → framing FAILs', async () => {
    const body = `data: not-json-at-all\n\ndata: [DONE]\n\n`
    const { checks } = await judge({ body })
    expect(verdictOf(checks, 'ui-stream-framing')).toBe('fail')
    expect(detailOf(checks, 'ui-stream-framing')).toMatch(/not valid JSON|no typed data/i)
  })

  it('a payload with no `type` discriminator → framing FAILs', async () => {
    const body = `data: ${JSON.stringify({ hello: 'world' })}\n\ndata: [DONE]\n\n`
    const { checks } = await judge({ body })
    expect(verdictOf(checks, 'ui-stream-framing')).toBe('fail')
    expect(detailOf(checks, 'ui-stream-framing')).toMatch(/type|no typed data/i)
  })
})

// ---------------------------------------------------------------------------
// (e) PART SHAPES — a wrong/unknown part type or wrong required field FAILs.
// ---------------------------------------------------------------------------

describe('part shapes: every part must be spec-correct per AI SDK 5', () => {
  it('an UNKNOWN part type → part-shapes FAILs', async () => {
    const parts = [{ type: 'start' }, { type: 'chat-chunk', delta: 'hi' }, { type: 'finish' }]
    const { checks } = await judge({ parts })
    expect(verdictOf(checks, 'ui-stream-part-shapes')).toBe('fail')
    expect(detailOf(checks, 'ui-stream-part-shapes')).toMatch(/unknown part type/i)
  })

  it('text-delta with `textDelta` instead of `delta` → part-shapes FAILs', async () => {
    const parts = [
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', textDelta: 'hi' },
      { type: 'text-end', id: 't1' },
    ]
    const { checks } = await judge({ parts })
    expect(verdictOf(checks, 'ui-stream-part-shapes')).toBe('fail')
    expect(detailOf(checks, 'ui-stream-part-shapes')).toMatch(/textDelta/)
  })

  it('tool-input-available with `args` instead of `input` → part-shapes FAILs', async () => {
    const parts = [{ type: 'tool-input-available', toolCallId: 'c1', toolName: 'x', args: { a: 1 } }]
    const { checks } = await judge({ parts })
    expect(verdictOf(checks, 'ui-stream-part-shapes')).toBe('fail')
    expect(detailOf(checks, 'ui-stream-part-shapes')).toMatch(/args/)
  })

  it('tool-output-available with `result` instead of `output` → part-shapes FAILs', async () => {
    const parts = [{ type: 'tool-output-available', toolCallId: 'c1', result: WIDGETS }]
    const { checks } = await judge({ parts })
    expect(verdictOf(checks, 'ui-stream-part-shapes')).toBe('fail')
    expect(detailOf(checks, 'ui-stream-part-shapes')).toMatch(/result/)
  })

  it('a data-${name} part missing its `data` field → part-shapes FAILs', async () => {
    const parts = [{ type: 'data-widgets', id: 'd1' }]
    const { checks } = await judge({ parts })
    expect(verdictOf(checks, 'ui-stream-part-shapes')).toBe('fail')
    expect(detailOf(checks, 'ui-stream-part-shapes')).toMatch(/data/i)
  })
})

// ---------------------------------------------------------------------------
// (f) ENVELOPE HYGIENE — a secret in any part FAILs (reuses the shared detector).
// ---------------------------------------------------------------------------

describe('envelope hygiene: a leaked secret in any part FAILs', () => {
  it('a token in a tool-output-available `output` → hygiene FAILs', async () => {
    const leaky = { apiKey: 'sk-abcdef0123456789ABCDEF', count: 3 }
    const parts = [{ type: 'tool-output-available', toolCallId: 'c1', output: leaky }]
    const { checks } = await judge({ parts })
    expect(verdictOf(checks, 'ui-stream-envelope-hygiene')).toBe('fail')
    expect(detailOf(checks, 'ui-stream-envelope-hygiene')).toMatch(/secret|credential/i)
  })

  it('a secret in a data-${name} part → hygiene FAILs', async () => {
    const parts = [{ type: 'data-session', id: 'd1', data: { session_token: 'sess_abcdefghijklmnopqrstuvwxyz012345' } }]
    const { checks } = await judge({ parts })
    expect(verdictOf(checks, 'ui-stream-envelope-hygiene')).toBe('fail')
  })

  it('a leaked secret caps the grade below A+', async () => {
    const parts = [{ type: 'tool-output-available', toolCallId: 'c1', output: { apiKey: 'sk-abcdef0123456789ABCDEF' } }]
    const { grade } = await judge({ parts })
    expect(grade).not.toBe('A+')
  })
})

// ---------------------------------------------------------------------------
// (g) PROJECTION-PARITY — output must match the JSON twin; SKIP when no twin.
// ---------------------------------------------------------------------------

describe('projection-parity: tool-output-available output vs the JSON twin', () => {
  it('output CONSISTENT with the twin → parity PASSes', async () => {
    const { checks } = await judge({ twin: WIDGETS })
    expect(verdictOf(checks, 'ui-stream-parity')).toBe('pass')
  })

  it('output DIVERGENT from the twin → parity FAILs', async () => {
    const divergentTwin = { count: 4, widgets: [{ id: 'w1' }, { id: 'w2' }, { id: 'w3' }, { id: 'w4' }] }
    const { checks } = await judge({ twin: divergentTwin })
    expect(verdictOf(checks, 'ui-stream-parity')).toBe('fail')
    expect(detailOf(checks, 'ui-stream-parity')).toMatch(/diverge|register divergence/i)
  })

  it('a parity divergence caps the grade below A+', async () => {
    const { grade } = await judge({ twin: { count: 99 } })
    expect(grade).not.toBe('A+')
  })

  it('NO twin observable → parity SKIPs (not fabricated as a pass)', async () => {
    const { checks } = await judge() // no twin declared
    expect(verdictOf(checks, 'ui-stream-parity')).toBe('skip')
    expect(detailOf(checks, 'ui-stream-parity')).toMatch(/not applicable|no JSON\/MCP twin/i)
    // the other four sub-signals still PASS on the clean stream
    expect(verdictOf(checks, 'ui-stream-transport')).toBe('pass')
    expect(verdictOf(checks, 'ui-stream-framing')).toBe('pass')
    expect(verdictOf(checks, 'ui-stream-part-shapes')).toBe('pass')
    expect(verdictOf(checks, 'ui-stream-envelope-hygiene')).toBe('pass')
  })

  it('a twin is observable but the stream emits no tool-output part → parity SKIPs', async () => {
    const parts = [{ type: 'start' }, { type: 'text-start', id: 't1' }, { type: 'text-delta', id: 't1', delta: 'hi' }, { type: 'text-end', id: 't1' }, { type: 'finish' }]
    const { checks } = await judge({ parts, twin: WIDGETS })
    expect(verdictOf(checks, 'ui-stream-parity')).toBe('skip')
  })
})

// ---------------------------------------------------------------------------
// (h) SSRF — an off-origin declared stream url is NEVER fetched (→ SKIP).
// ---------------------------------------------------------------------------

describe('SSRF: an off-origin declared stream face is never fetched', () => {
  it('a hostile off-origin uiMessageStream.url records no stream evidence → checks SKIP', async () => {
    const base = goodTargetRoutes()
    const agentsOut = base['GET /.well-known/agents.json']!({ method: 'GET', accept: 'application/json' })
    const agentsDoc = JSON.parse(agentsOut.body!) as Record<string, unknown>
    ;(agentsDoc.interfaces as Record<string, unknown>).uiMessageStream = { url: 'http://169.254.169.254/latest/meta-data/stream' }
    base['GET /.well-known/agents.json'] = () => ({ status: 200, contentType: 'application/json', body: JSON.stringify(agentsDoc) })

    const fetcher = makeFetcher(base)
    const observer = new Observer({ fetcher, delayMs: 0, budget: 48 })
    const bundle = await observeTarget(GOOD, observer, 7)
    const checks = runChecks(bundle)
    // never fetched → no evidence → the face reads as not-declared → SKIP (safe).
    expect(bundle.items.find((e) => e.url.includes('169.254.169.254'))).toBeUndefined()
    for (const id of STREAM_IDS) expect(verdictOf(checks, id)).toBe('skip')
  })
})
