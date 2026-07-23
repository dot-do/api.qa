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

  it('a NON-2xx status (500) with an otherwise-valid v1 SSE stream → transport FAILs (response.ok is false)', async () => {
    const { checks } = await judge({ status: 500, twin: WIDGETS })
    expect(verdictOf(checks, 'ui-stream-transport'), detailOf(checks, 'ui-stream-transport')).toBe('fail')
    expect(detailOf(checks, 'ui-stream-transport')).toMatch(/500|non-2xx|response\.ok/i)
    // the downstream sub-signals do NOT false-pass on a non-consumable stream
    expect(verdictOf(checks, 'ui-stream-framing')).toBe('skip')
    expect(verdictOf(checks, 'ui-stream-part-shapes')).toBe('skip')
    expect(verdictOf(checks, 'ui-stream-envelope-hygiene')).toBe('skip')
  })

  it('a NON-2xx status (404) with a valid stream → transport FAILs and caps the grade', async () => {
    const { checks, grade } = await judge({ status: 404, twin: WIDGETS })
    expect(verdictOf(checks, 'ui-stream-transport')).toBe('fail')
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

  it('standard SSE fields (event:/id:/retry:) interleaved with valid data: chunks → framing PASSes (ignored, non-fatal)', async () => {
    const body =
      `event: message\n` +
      `id: 42\n` +
      `data: ${JSON.stringify({ type: 'start' })}\n\n` +
      `retry: 1500\n` +
      `data: ${JSON.stringify({ type: 'text-start', id: 't1' })}\n\n` +
      `data: ${JSON.stringify({ type: 'text-delta', id: 't1', delta: 'hi' })}\n\n` +
      `data: ${JSON.stringify({ type: 'text-end', id: 't1' })}\n\n` +
      `data: ${JSON.stringify({ type: 'finish' })}\n\n` +
      `data: [DONE]\n\n`
    const { checks } = await judge({ body })
    expect(verdictOf(checks, 'ui-stream-framing'), detailOf(checks, 'ui-stream-framing')).toBe('pass')
    expect(verdictOf(checks, 'ui-stream-part-shapes')).toBe('pass')
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

  it('a dotted ya29. Google OAuth token under a BENIGN field name (note) → hygiene FAILs', async () => {
    const parts = [{ type: 'data-widgets', id: 'd1', data: { note: 'ya29.a0AfB_longopaqueaccesstokenbody1234567890', count: 3 } }]
    const { checks } = await judge({ parts })
    expect(verdictOf(checks, 'ui-stream-envelope-hygiene')).toBe('fail')
    expect(detailOf(checks, 'ui-stream-envelope-hygiene')).toMatch(/secret|credential|ya29/i)
  })

  it('a dotted 1// Google OAuth refresh token under a benign field name → hygiene FAILs', async () => {
    const parts = [{ type: 'data-widgets', id: 'd1', data: { ref: '1//0longopaquerefreshtokenbody1234567890abcd' } }]
    const { checks } = await judge({ parts })
    expect(verdictOf(checks, 'ui-stream-envelope-hygiene')).toBe('fail')
  })

  it('benign DOTTED strings (domain / version / dotted field-path) do NOT false-positive → hygiene PASSes', async () => {
    const parts = [{ type: 'data-widgets', id: 'd1', data: { homepage: 'api.example.com', version: 'v1.2.3-beta.4', path: 'a.b.c', pkg: 'com.example.myapp' } }]
    const { checks } = await judge({ parts })
    expect(verdictOf(checks, 'ui-stream-envelope-hygiene'), detailOf(checks, 'ui-stream-envelope-hygiene')).toBe('pass')
  })
})

// ---------------------------------------------------------------------------
// (f2) DATA: URI EXEMPTION (ax-17j) — a well-formed data: URI is inline CONTENT,
//   not a credential-by-entropy. Its base64 payload must not false-flag as a
//   high-entropy secret; but a data: URI CARRYING a recognizable credential
//   (raw or base64-encoded) still FAILs.
// ---------------------------------------------------------------------------

// A 1x1 transparent PNG, an inline SVG, and a font blob — legit inline content.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const WOFF_B64 = 'dGhpcyBpcyBhIGZha2UgZm9udCBibG9iIGZvciB0ZXN0aW5nIHB1cnBvc2VzIG9ubHkgMTIzNDU='
// base64 of the literal 'sk-live0deadbeefdeadbeef01234567' — a key smuggled inside a data: URI.
const SK_KEY_B64 = 'c2stbGl2ZTBkZWFkYmVlZmRlYWRiZWVmMDEyMzQ1Njc='
// An OPAQUE 43-char high-entropy secret with NO known VALUE_SECRET_PATTERNS prefix —
// exactly what the entropy heuristic exists to catch. It must FAIL both bare AND when
// laundered inside a text/json/tiny-binary data: URI (the ax-17j evasion, gate af8cb0ca).
const OPAQUE_SECRET = 'Xk7Qm2Zp9Rf4Vb8Nc1Ld6Wg0Ht3Jy5Uq7Es2Ao4Ti'
// A REALISTIC ≥512-byte inline image (16×16 PNG, 671 decoded bytes) — legit high-entropy
// media that must stay EXEMPT from the entropy heuristic.
const PNG_LARGE_B64 = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAACZklEQVR4nA3MkYI0OxCA0cYfg4vBxeBgcDA4WNhY2FjYWNgYHAwOBgeDi8GLeYPv9nmAs23bRtj+EbdA2n7IW6Rsv8iW0O2BbRnfntSt0LYXfRPGtjM3ZW0H2xb+EUIghh9SiOTwSwkJCQ80ZCw88VCo4UULQg87IygzHKxgdxADIf4QYyTFX3JMlPhAYkbjE4sFjy9qFFrc6VEZ8WBGY8XzDtIPIUVi+iWlRE4PSspIeqKpYOmFJ6GmnZaUng5GMmY6WcnvIEdC/iXmRMoPcs6U/ERyQfMLy4LnnZqVlg96NkY+mdlZ+bqD8ksoiVgepJLJ5UkpBSkvtAhWdrwotRy0YvRyMoozy8Uq9Q4kEeRBlEySJ1kKRV6ICCo7JorLQRWjyUkXZ8jFlMqS9x3og6CZqE+SFrK+KCqI7qgqpgeuRtWTpk7Xi6GVqW+WtjuwTLAn0QrJXmQTiu2IKWoHZobbSTWn2UW3yrA30xrLPnfgT4IXor9ILmTfKa6IH6gb5ifuTvWL5pXub4Y3pn9Y3u+gFkJ9EauQ6k6uSqkHUg2tJ1Ydrxe1Vlp902tj1A+zdlb93kF7EZoQ205qSm4HpRnSTrQ51i68VWp701qjtw+jdWb7stq4gy6EvhO7kvpB7kbpJ9Id7RfWK97f1N5o/UPvndG/zD5Y/e8Oxk4YShwHaRh5nJThyLjQUbHxxkejjg9tdPr4MsZgjj/WmHcwlTAP4jTSPMnTKfNCZkXnG5sNnx/q7LT5pc/BmH/MOVnzvztYB2EZcZ2k5eR1UVZF1htdDVsffHXq+tLWoK8/xprM9R9rLf4HPKlnH95EcQMAAAAASUVORK5CYII='
// A ≥512-byte binary font-ish blob (600 decoded bytes) — legit high-entropy media.
const FONT_LARGE_B64 = 'KYrrTK0Ob9Awk/JVtBd22TuY+V6/HH3iQqEAZ8YlhOtNrg9oySqL9FS3FnHQM5L9X7wdets4mQZmxSSD4kGgD2HCI4TlRqcYeNs6nfxfvhFz0DGW91S1KorpSK8ObcwjheZHoAFiwzyc/165GHvaNZf0VbITcNFOrg1syyqJ6Ee5GnvcPZ7/QKADYsUkh+ZJqwhpzi+M7XLSMZD3VrUUe90+n/hZuhtkxCeG4UCjAm3PLI3qS6gJlvZVtBNy0TCf8VKzFHXWN4joS6oNbM8ugeNAoQZnxCW6GnnYP579XLMVdtcwkfJTrAxvzimI60qlB2TFIoPgQd4+nfxbuhl41wmqy2yNLk/wELPSdZQ3VvkbuNl+nzxdwmKBIEfmBaTLbY4vSOkKq9R0lzZR8BOy3X+cPVr7GLkmRuUEo8JhgC9B4gOkxWaHOFj7Gr3cf54xU/ARttd0lQqqyWiPLk3sA6XGZ4AhQuMcvN9+mThb+hW31HWSM1Dxbo4tTOsKqchnmTpb/B2+32CAI0LlBKfGaYsoSe4PrM1S8hGw13aVNFv9Hr/YeZo7ROQHpsFggyJN7wytymuIKbbWdZQzUvEQv9FykzRV9heoyGuKLUzvDqHDYIEmR+QFmjpZ+B++3XyTNVb3ELHSc4wsT+4JqMtqhSdE5QKjwGH+Hr3ce5o5WPdpyqsM7U4vkHDTshX0VzaZe9i5Hv9cPaIC4UAnhmXEqw3uTyiJasu0FPdWMZBz0r0f/F06m3jZRiaFZMOiAeBPIYJjxKUG51g4m3rdvB/+UTOQcda3FPVq'
const b64of = (s: string) => Buffer.from(s, 'latin1').toString('base64')

describe('data: URI hygiene (ax-17j): inline content PASSes, smuggled credentials still FAIL', () => {
  it('(a) a data:image/png;base64 blob in a tool-output → hygiene PASSes (not a high-entropy credential)', async () => {
    const parts = [{ type: 'tool-output-available', toolCallId: 'c1', output: { thumbnail: `data:image/png;base64,${PNG_B64}`, count: 3 } }]
    const { checks } = await judge({ parts })
    expect(verdictOf(checks, 'ui-stream-envelope-hygiene'), detailOf(checks, 'ui-stream-envelope-hygiene')).toBe('pass')
  })

  it('(a) an inline data:image/svg+xml (no base64) → hygiene PASSes', async () => {
    const parts = [{ type: 'data-widgets', id: 'd1', data: { icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8"/></svg>', count: 3 } }]
    const { checks } = await judge({ parts })
    expect(verdictOf(checks, 'ui-stream-envelope-hygiene'), detailOf(checks, 'ui-stream-envelope-hygiene')).toBe('pass')
  })

  it('(a) a data:font/woff2;base64 blob → hygiene PASSes', async () => {
    const parts = [{ type: 'data-widgets', id: 'd1', data: { font: `data:font/woff2;base64,${WOFF_B64}`, count: 3 } }]
    const { checks } = await judge({ parts })
    expect(verdictOf(checks, 'ui-stream-envelope-hygiene'), detailOf(checks, 'ui-stream-envelope-hygiene')).toBe('pass')
  })

  it('(b) a data:text/plain;base64 that DECODES to an sk- key → hygiene still FAILs', async () => {
    const parts = [{ type: 'tool-output-available', toolCallId: 'c1', output: { blob: `data:text/plain;base64,${SK_KEY_B64}` } }]
    const { checks } = await judge({ parts })
    expect(verdictOf(checks, 'ui-stream-envelope-hygiene'), detailOf(checks, 'ui-stream-envelope-hygiene')).toBe('fail')
    expect(detailOf(checks, 'ui-stream-envelope-hygiene')).toMatch(/sk-|secret|credential/i)
  })

  it('(b) a data: URI whose RAW text carries a ya29. token → hygiene still FAILs', async () => {
    const parts = [{ type: 'data-widgets', id: 'd1', data: { note: 'data:text/plain,ya29.a0AfB_longopaqueaccesstokenbody1234567890' } }]
    const { checks } = await judge({ parts })
    expect(verdictOf(checks, 'ui-stream-envelope-hygiene'), detailOf(checks, 'ui-stream-envelope-hygiene')).toBe('fail')
  })

  it('(b) a data: URI whose RAW text carries an AKIA key → hygiene still FAILs', async () => {
    const parts = [{ type: 'data-widgets', id: 'd1', data: { note: 'data:text/plain,AKIAIOSFODNN7EXAMPLE' } }]
    const { checks } = await judge({ parts })
    expect(verdictOf(checks, 'ui-stream-envelope-hygiene'), detailOf(checks, 'ui-stream-envelope-hygiene')).toBe('fail')
  })

  it('(c) NO REGRESSION: the SAME base64 blob bare (not a data: URI) still FAILs as high-entropy', async () => {
    const parts = [{ type: 'data-widgets', id: 'd1', data: { opaque: WOFF_B64 } }]
    const { checks } = await judge({ parts })
    expect(verdictOf(checks, 'ui-stream-envelope-hygiene'), detailOf(checks, 'ui-stream-envelope-hygiene')).toBe('fail')
  })

  // (d) EVASION CLOSED (gate af8cb0ca): an OPAQUE high-entropy secret laundered inside a
  //   TEXT-ish or tiny-binary data: URI must NOT be exempted — the entropy heuristic still
  //   catches it. The MIME-scoped + size-scoped exemption only covers genuine inline media.
  it('(d) an OPAQUE secret laundered as data:text/plain;base64 → hygiene still FAILs (not exempt)', async () => {
    const parts = [{ type: 'data-widgets', id: 'd1', data: { blob: `data:text/plain;base64,${b64of(OPAQUE_SECRET)}` } }]
    const { checks } = await judge({ parts })
    expect(verdictOf(checks, 'ui-stream-envelope-hygiene'), detailOf(checks, 'ui-stream-envelope-hygiene')).toBe('fail')
  })

  it('(d) an OPAQUE secret as raw data:text/plain,<opaque> → hygiene still FAILs', async () => {
    const parts = [{ type: 'data-widgets', id: 'd1', data: { blob: `data:text/plain,${OPAQUE_SECRET}` } }]
    const { checks } = await judge({ parts })
    expect(verdictOf(checks, 'ui-stream-envelope-hygiene'), detailOf(checks, 'ui-stream-envelope-hygiene')).toBe('fail')
  })

  it('(d) an OPAQUE secret in data:application/json;base64,{token:…} → hygiene still FAILs', async () => {
    const parts = [{ type: 'data-widgets', id: 'd1', data: { blob: `data:application/json;base64,${b64of(JSON.stringify({ token: OPAQUE_SECRET }))}` } }]
    const { checks } = await judge({ parts })
    expect(verdictOf(checks, 'ui-stream-envelope-hygiene'), detailOf(checks, 'ui-stream-envelope-hygiene')).toBe('fail')
  })

  it('(d) an OPAQUE secret in a TINY data:application/octet-stream;base64 → hygiene still FAILs (below media-size floor)', async () => {
    const parts = [{ type: 'data-widgets', id: 'd1', data: { blob: `data:application/octet-stream;base64,${b64of(OPAQUE_SECRET)}` } }]
    const { checks } = await judge({ parts })
    expect(verdictOf(checks, 'ui-stream-envelope-hygiene'), detailOf(checks, 'ui-stream-envelope-hygiene')).toBe('fail')
  })

  it('(d) NO OVER-BLOCK: a REALISTIC ≥512-byte data:image/png and data:font/woff2 blob → hygiene PASSes (legit media exempt)', async () => {
    const parts = [{ type: 'data-widgets', id: 'd1', data: { img: `data:image/png;base64,${PNG_LARGE_B64}`, font: `data:font/woff2;base64,${FONT_LARGE_B64}`, count: 3 } }]
    const { checks } = await judge({ parts })
    expect(verdictOf(checks, 'ui-stream-envelope-hygiene'), detailOf(checks, 'ui-stream-envelope-hygiene')).toBe('pass')
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

  it('an ENVELOPED twin {ok:true,data:WIDGETS} vs an output emitting the WIDGETS slice → parity PASSes (single-level unwrap)', async () => {
    const { checks } = await judge({ twin: { ok: true, data: WIDGETS } })
    expect(verdictOf(checks, 'ui-stream-parity'), detailOf(checks, 'ui-stream-parity')).toBe('pass')
  })

  it('a twin wrapping the slice under `result` → parity PASSes', async () => {
    const { checks } = await judge({ twin: { result: WIDGETS } })
    expect(verdictOf(checks, 'ui-stream-parity'), detailOf(checks, 'ui-stream-parity')).toBe('pass')
  })

  it('a GENUINE divergence inside an envelope ({ok,data:DIFFERENT}) still FAILs (unwrap is not a blanket pass)', async () => {
    const { checks } = await judge({ twin: { ok: true, data: { count: 4, widgets: [{ id: 'x' }] } } })
    expect(verdictOf(checks, 'ui-stream-parity')).toBe('fail')
    expect(detailOf(checks, 'ui-stream-parity')).toMatch(/diverge|register divergence/i)
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
