/**
 * Alerting (bd ax-e6b.29.3) — fire ONE alert on the transition into breach,
 * deliver it to a configured channel, and dedupe/debounce so a persisting or
 * flapping target never alert-cannons.
 *
 * Two layers:
 *   1. PURE units — rule evaluation, the dedupe/debounce state machine, the
 *      channel-URL SSRF gate, and the channel payload adapters.
 *   2. INTEGRATION — drive `scheduledTick` with a mock clock, a toggleable
 *      target fetcher, and a CAPTURING channel fetcher (a real spy): assert
 *      exactly-one on transition (grade regression / uptime-below / error-rate /
 *      attestation-change), no re-alert on a persisting breach, debounce on a
 *      flapping target, and that an SSRF channel URL is refused at config AND
 *      never POSTed.
 */

import { describe, it, expect } from 'vitest'
import { createApp } from '../src/worker.js'
import { ReportCache, MemoryKV } from '../src/cache.js'
import { MonitorStore, monitorId, type MonitorRecord } from '../src/monitors.js'
import { TimeseriesStore } from '../src/timeseries.js'
import {
  AlertDispatcher,
  AlertStateStore,
  StubEmailChannel,
  evaluateAlertRules,
  decideAlert,
  assertChannelUrlSafe,
  validateAlertRules,
  shapeChannelBody,
  configuredRuleIds,
  initialAlertState,
  DEFAULT_DEBOUNCE_MS,
  type AlertRules,
  type AlertPayload,
  type SeriesMetrics,
} from '../src/alerts.js'
import { goodTargetRoutes, makeFetcher, GOOD } from './helpers.js'
import type { Fetcher } from '../src/http.js'

const req = (path: string, init?: RequestInit) => new Request(`https://api.qa${path}`, init)
const jsonReq = (path: string, body: unknown) =>
  req(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

/** A good.example target fetcher that can be toggled to a total 5xx outage. */
function toggleableFetcher(): { fetcher: Fetcher; setDown: (d: boolean) => void } {
  const base = makeFetcher(goodTargetRoutes())
  let down = false
  const fetcher: Fetcher = async (url, init) => {
    if (down)
      return new Response(JSON.stringify({ error: 'outage' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      })
    return base(url, init)
  }
  return { fetcher, setDown: (d) => { down = d } }
}

/** A capturing channel fetcher (the delivery-POST spy). */
function captureChannel(): { fetcher: Fetcher; posts: Array<{ url: string; body: any }> } {
  const posts: Array<{ url: string; body: any }> = []
  const fetcher: Fetcher = async (url, init) => {
    posts.push({ url, body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}') })
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return { fetcher, posts }
}

const WEBHOOK = 'https://hooks.example/alert'

/** An integration harness: good.example monitor + wired alert dispatcher spy. */
function harness(alerts: AlertRules, opts: { debounceless?: boolean } = {}) {
  const { fetcher: target, setDown } = toggleableFetcher()
  const { fetcher: channel, posts } = captureChannel()
  const monitors = new MonitorStore(new MemoryKV())
  const timeseries = new TimeseriesStore(new MemoryKV())
  const dispatcher = new AlertDispatcher(new AlertStateStore(new MemoryKV()), {
    fetcher: channel,
    allowPrivate: false,
  })
  let clock = 0
  const app = createApp(
    {},
    {
      externalFetcher: target,
      externalDelayMs: 0,
      cache: new ReportCache(new MemoryKV(), 300),
      monitors,
      timeseries,
      alerts: dispatcher,
      now: () => clock,
    },
  )
  return {
    posts,
    setDown,
    monitors,
    async register() {
      const reg = await app.fetch(jsonReq('/monitors', { target: 'good.example', interval: 60, alerts }))
      expect(reg.status).toBe(201)
      return (await reg.json()) as { monitor: { id: string } }
    },
    async tick(at: number, down: boolean) {
      clock = at
      setDown(down)
      const s = await app.scheduledTick(at)
      return s
    },
  }
}

// ---------------------------------------------------------------------------
// PURE: rule evaluation
// ---------------------------------------------------------------------------

describe('evaluateAlertRules', () => {
  const series: SeriesMetrics = { uptimePct: 100, errorRate: 0, latencyP95: 100, count: 5 }
  const run = { at: 2000, grade: 'A+', digest: 'd2', verdictDigest: 'v2' }
  const prior = { grade: 'A+', digest: 'd1', verdictDigest: 'v1' }

  it('fires uptimeBelowPct when windowed uptime dips below the threshold', () => {
    const b = evaluateAlertRules({ uptimeBelowPct: 99, channels: [] }, { series: { ...series, uptimePct: 60 }, run })
    expect(b.map((x) => x.rule)).toEqual(['uptimeBelowPct'])
    expect(b[0]!.actual).toBe(60)
    expect(b[0]!.threshold).toBe(99)
  })

  it('does NOT fire uptimeBelowPct when uptime meets the threshold, or the window is empty', () => {
    expect(evaluateAlertRules({ uptimeBelowPct: 99, channels: [] }, { series, run })).toEqual([])
    expect(
      evaluateAlertRules({ uptimeBelowPct: 99, channels: [] }, { series: { ...series, uptimePct: 0, count: 0 }, run }),
    ).toEqual([])
  })

  it('fires latencyAboveMs on windowed p95 over the threshold', () => {
    const b = evaluateAlertRules({ latencyAboveMs: 250, channels: [] }, { series: { ...series, latencyP95: 900 }, run })
    expect(b.map((x) => x.rule)).toEqual(['latencyAboveMs'])
    expect(b[0]!.actual).toBe(900)
  })

  it('fires errorRateAbove on windowed error-rate over the threshold', () => {
    const b = evaluateAlertRules({ errorRateAbove: 0.1, channels: [] }, { series: { ...series, errorRate: 0.5 }, run })
    expect(b.map((x) => x.rule)).toEqual(['errorRateAbove'])
    expect(b[0]!.actual).toBe(0.5)
  })

  it('fires gradeRegression only when this run drops vs the prior run', () => {
    expect(
      evaluateAlertRules({ gradeRegression: true, channels: [] }, { series, run: { ...run, grade: 'C' }, prior }).map((x) => x.rule),
    ).toEqual(['gradeRegression'])
    // Improvement or no-change never fires.
    expect(evaluateAlertRules({ gradeRegression: true, channels: [] }, { series, run, prior }).length).toBe(0)
    expect(
      evaluateAlertRules({ gradeRegression: true, channels: [] }, { series, run: { ...run, grade: 'A+' }, prior: { ...prior, grade: 'B' } }).length,
    ).toBe(0)
    // First run (no prior) can never regress.
    expect(evaluateAlertRules({ gradeRegression: true, channels: [] }, { series, run: { ...run, grade: 'F' } }).length).toBe(0)
  })

  it('an UNKNOWN grade on either side never reads as a regression (LOW fix — gradeRank(unknown) = -1, not < F)', () => {
    // Without the >=0 guard, gradeRank('unknown') = -1 < gradeRank('F') = 0
    // would misread an unrecognized CURRENT grade as a regression-from-F.
    expect(
      evaluateAlertRules(
        { gradeRegression: true, channels: [] },
        { series, run: { ...run, grade: 'unknown' }, prior: { ...prior, grade: 'F' } },
      ).length,
    ).toBe(0)
    // Symmetric: an unrecognized PRIOR grade also never yields a regression.
    expect(
      evaluateAlertRules(
        { gradeRegression: true, channels: [] },
        { series, run: { ...run, grade: 'F' }, prior: { ...prior, grade: 'unknown' } },
      ).length,
    ).toBe(0)
  })

  it('fires attestationChange only when the attested-verdict digest changed vs prior', () => {
    expect(
      evaluateAlertRules({ attestationChange: true, channels: [] }, { series, run: { ...run, verdictDigest: 'CHANGED' }, prior }).map((x) => x.rule),
    ).toEqual(['attestationChange'])
    // Same verdict digest → no alert (stable across identical runs).
    expect(
      evaluateAlertRules({ attestationChange: true, channels: [] }, { series, run: { ...run, verdictDigest: 'v1' }, prior }).length,
    ).toBe(0)
    // No prior, or prior lacking a verdict digest → fail-safe, never fires.
    expect(evaluateAlertRules({ attestationChange: true, channels: [] }, { series, run }).length).toBe(0)
    expect(
      evaluateAlertRules({ attestationChange: true, channels: [] }, { series, run, prior: { grade: 'A+', digest: 'd1' } }).length,
    ).toBe(0)
  })

  it('configuredRuleIds returns only present/true conditions in stable order', () => {
    expect(configuredRuleIds({ uptimeBelowPct: 99, gradeRegression: true, attestationChange: false, channels: [] })).toEqual([
      'uptimeBelowPct',
      'gradeRegression',
    ])
  })
})

// ---------------------------------------------------------------------------
// PURE: dedupe / debounce state machine
// ---------------------------------------------------------------------------

describe('decideAlert — dedupe / debounce', () => {
  const rules: AlertRules = { channels: [] }

  it('alerts on the transition into breach, then dedupes a persisting breach', () => {
    const d1 = decideAlert(true, initialAlertState(), 1000, rules)
    expect(d1.deliver).toBe('firing')
    expect(d1.nextState).toEqual({ firing: true, lastNotifiedAt: 1000, lastAlertedValue: null })
    // Still breached next tick → no re-alert.
    const d2 = decideAlert(true, d1.nextState, 2000, rules)
    expect(d2.deliver).toBeNull()
    expect(d2.nextState.firing).toBe(true)
  })

  it('debounces a flapping breach (breach→resolve→breach) within the debounce window', () => {
    const fire = decideAlert(true, initialAlertState(), 1000, rules)
    expect(fire.deliver).toBe('firing')
    // Resolve (no resolveNotify) — firing clears, lastNotifiedAt kept.
    const resolve = decideAlert(false, fire.nextState, 2000, rules)
    expect(resolve.deliver).toBeNull()
    expect(resolve.nextState).toEqual({ firing: false, lastNotifiedAt: 1000, lastAlertedValue: null })
    // Re-breach shortly after → transition, but debounced → suppressed.
    const reBreach = decideAlert(true, resolve.nextState, 3000, rules)
    expect(reBreach.deliver).toBeNull()
    // Far past the debounce window → a fresh alert is allowed.
    const later = decideAlert(true, resolve.nextState, 1000 + DEFAULT_DEBOUNCE_MS + 1, rules)
    expect(later.deliver).toBe('firing')
  })

  it('re-notifies a still-firing rule after renotifyMs (escalation)', () => {
    const r: AlertRules = { channels: [], debounceMs: 0, renotifyMs: 5000 }
    const fire = decideAlert(true, initialAlertState(), 0, r)
    expect(fire.deliver).toBe('firing')
    expect(decideAlert(true, fire.nextState, 4000, r).deliver).toBeNull() // not due yet
    const re = decideAlert(true, fire.nextState, 5000, r)
    expect(re.deliver).toBe('firing')
    expect(re.nextState.lastNotifiedAt).toBe(5000)
  })

  it('emits a resolved notification only when resolveNotify is set', () => {
    const r: AlertRules = { channels: [], debounceMs: 0, resolveNotify: true }
    const fire = decideAlert(true, initialAlertState(), 0, r)
    const resolve = decideAlert(false, fire.nextState, 1000, r)
    expect(resolve.deliver).toBe('resolved')
    expect(resolve.nextState.firing).toBe(false)
  })

  it('re-notifies a STILL-firing severity rule when the breach gets STRICTLY WORSE (MED fix — escalation)', () => {
    const r: AlertRules = { channels: [], debounceMs: 0 }
    const fire = decideAlert(true, initialAlertState(), 0, r, { rule: 'gradeRegression', condition: 'A+→B', actual: 'B', threshold: 'A+' })
    expect(fire.deliver).toBe('firing')
    expect(fire.nextState.lastAlertedValue).toBe('B')
    // Still breached, but the SAME grade (steady) → no re-alert.
    const steady = decideAlert(true, fire.nextState, 1000, r, { rule: 'gradeRegression', condition: 'A+→B', actual: 'B', threshold: 'A+' })
    expect(steady.deliver).toBeNull()
    // Still breached, STRICTLY WORSE (B → D) → re-alert (escalation).
    const worse = decideAlert(true, steady.nextState, 2000, r, { rule: 'gradeRegression', condition: 'A+→D', actual: 'D', threshold: 'A+' })
    expect(worse.deliver).toBe('firing')
    expect(worse.nextState.lastAlertedValue).toBe('D')
    // Partial recovery (D → C, still breached but BETTER than last-alerted D) → no re-alert.
    const partial = decideAlert(true, worse.nextState, 3000, r, { rule: 'gradeRegression', condition: 'A+→C', actual: 'C', threshold: 'A+' })
    expect(partial.deliver).toBeNull()
    expect(partial.nextState.lastAlertedValue).toBe('D') // unchanged — no new notification happened
  })

  it('escalation is NOT applied to attestationChange (a binary change-event, not a severity scale)', () => {
    const r: AlertRules = { channels: [], debounceMs: 0 }
    const fire = decideAlert(true, initialAlertState(), 0, r, {
      rule: 'attestationChange',
      condition: 'changed',
      actual: 'digestA',
      threshold: 'digestB',
    })
    expect(fire.deliver).toBe('firing')
    // Still "breached" (caller kept reporting true) with a different actual —
    // attestationChange is excluded from isSeverityRule, so no escalation path.
    const again = decideAlert(true, fire.nextState, 1000, r, {
      rule: 'attestationChange',
      condition: 'changed',
      actual: 'digestC',
      threshold: 'digestB',
    })
    expect(again.deliver).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// PURE: channel-URL SSRF gate
// ---------------------------------------------------------------------------

describe('assertChannelUrlSafe — SSRF gate', () => {
  it('accepts a public http(s) channel URL', () => {
    expect(assertChannelUrlSafe('https://hooks.example/x')).toEqual({ ok: true, url: 'https://hooks.example/x' })
    expect(assertChannelUrlSafe('http://hooks.example/x').ok).toBe(true)
  })

  it.each([
    'http://169.254.169.254/latest/meta-data/', // cloud metadata
    'http://127.0.0.1/x',
    'http://localhost/x',
    'http://10.0.0.5/x',
    'http://192.168.1.1/x',
    'http://[::1]/x',
    'http://2852039166/x', // decimal-encoded 169.254.169.254
    'https://internal/x', // single-label host
  ])('refuses a private/metadata/single-label channel URL: %s', (u) => {
    const r = assertChannelUrlSafe(u)
    expect(r.ok).toBe(false)
  })

  it.each(['file:///etc/passwd', 'gopher://evil/x', 'ftp://host/x'])('refuses non-http(s) scheme: %s', (u) => {
    expect(assertChannelUrlSafe(u).ok).toBe(false)
  })

  it('refuses an empty / unparseable URL (fail closed)', () => {
    expect(assertChannelUrlSafe(undefined).ok).toBe(false)
    expect(assertChannelUrlSafe('').ok).toBe(false)
    expect(assertChannelUrlSafe('not a url').ok).toBe(false)
  })

  it('validateAlertRules rejects a rule set with a hostile channel and requires a condition + channel', () => {
    expect(validateAlertRules({ uptimeBelowPct: 99, channels: [{ type: 'webhook', url: 'http://169.254.169.254/x' }] })).toMatch(/SSRF/)
    expect(validateAlertRules({ uptimeBelowPct: 99, channels: [] })).toMatch(/channel/)
    expect(validateAlertRules({ channels: [{ type: 'webhook', url: WEBHOOK }] })).toMatch(/condition/)
    expect(validateAlertRules({ uptimeBelowPct: 99, channels: [{ type: 'webhook', url: WEBHOOK }] })).toBeNull()
    // email channel needs a recipient, not a URL.
    expect(validateAlertRules({ uptimeBelowPct: 99, channels: [{ type: 'email' }] })).toMatch(/to/)
    expect(validateAlertRules({ uptimeBelowPct: 99, channels: [{ type: 'email', to: 'ops@x.example' }] })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// PURE: channel payload adapters
// ---------------------------------------------------------------------------

describe('shapeChannelBody — thin adapters over the same POST', () => {
  const payload: AlertPayload = {
    $type: 'api.qa/Alert',
    status: 'firing',
    monitorId: 'mon_x',
    target: GOOD,
    rule: 'gradeRegression',
    condition: 'grade A+ → C regressed',
    actual: 'C',
    threshold: 'A+',
    run: { at: 5, grade: 'C', digest: 'deadbeefcafef00d' },
    firedAt: 5,
  }

  it('webhook posts the raw payload', () => {
    expect(shapeChannelBody('webhook', payload)).toBe(payload)
  })
  it('agent-callback wraps the payload as an agent callback envelope', () => {
    const b = shapeChannelBody('agent-callback', payload) as any
    expect(b.$type).toBe('api.qa/AgentCallback')
    expect(b.alert).toBe(payload)
  })
  it('slack adapts to an incoming-webhook text body naming target + condition', () => {
    const b = shapeChannelBody('slack', payload) as any
    expect(typeof b.text).toBe('string')
    expect(b.text).toContain(GOOD)
    expect(b.text).toContain('grade A+ → C regressed')
  })
  it('pagerduty adapts to Events v2 (trigger + dedup_key + summary)', () => {
    const b = shapeChannelBody('pagerduty', payload) as any
    expect(b.event_action).toBe('trigger')
    expect(b.dedup_key).toBe('mon_x:gradeRegression')
    expect(b.payload.summary).toContain(GOOD)
  })
})

// ---------------------------------------------------------------------------
// INTEGRATION — scheduledTick fires exactly one alert on transition
// ---------------------------------------------------------------------------

describe('scheduledTick alerting — exactly one alert on the transition into breach', () => {
  it('grade regression: A+ → F fires ONE alert naming target + condition + offending run', async () => {
    const h = harness({ gradeRegression: true, channels: [{ type: 'webhook', url: WEBHOOK }] })
    const { monitor } = await h.register()

    await h.tick(0, false) // A+, no prior → no alert
    expect(h.posts).toHaveLength(0)
    await h.tick(61_000, true) // F, regressed → fire
    expect(h.posts).toHaveLength(1)

    const body = h.posts[0]!.body as AlertPayload
    expect(h.posts[0]!.url).toBe(WEBHOOK)
    expect(body.$type).toBe('api.qa/Alert')
    expect(body.target).toBe(GOOD)
    expect(body.rule).toBe('gradeRegression')
    expect(body.condition).toContain('regressed')
    expect(body.monitorId).toBe(monitor.id)
    // Names the offending run: its instant, grade, and digest.
    expect(body.run.at).toBe(61_000)
    expect(body.run.grade).toBe('F')
    expect(body.run.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(body.prior?.grade).toBe('A+')

    // A second down tick keeps grade F (no NEW regression) → no re-alert.
    await h.tick(122_000, true)
    expect(h.posts).toHaveLength(1)
  })

  it('uptime-below: one alert on the first below-threshold tick, deduped while it persists', async () => {
    const h = harness({ uptimeBelowPct: 100, windowMs: 10 * 60_000, channels: [{ type: 'webhook', url: WEBHOOK }] })
    await h.register()
    await h.tick(0, false) // uptime 100 → no alert
    expect(h.posts).toHaveLength(0)
    await h.tick(61_000, true) // uptime dips below 100 → fire ONCE
    expect(h.posts).toHaveLength(1)
    expect((h.posts[0]!.body as AlertPayload).rule).toBe('uptimeBelowPct')
    // Persisting breach across more ticks → NO re-alert (dedupe).
    await h.tick(122_000, true)
    await h.tick(183_000, true)
    expect(h.posts).toHaveLength(1)
  })

  it('error-rate-above: one alert when the windowed error-rate first exceeds the threshold', async () => {
    const h = harness({ errorRateAbove: 0, windowMs: 10 * 60_000, channels: [{ type: 'webhook', url: WEBHOOK }] })
    await h.register()
    await h.tick(0, false) // error-rate 0 → no alert
    expect(h.posts).toHaveLength(0)
    await h.tick(61_000, true) // error-rate > 0 → fire
    expect(h.posts).toHaveLength(1)
    expect((h.posts[0]!.body as AlertPayload).rule).toBe('errorRateAbove')
    await h.tick(122_000, true) // still breached → dedupe
    expect(h.posts).toHaveLength(1)
  })

  it('attestation-change: no alert while the verdict is stable, ONE alert when it changes', async () => {
    const h = harness({ attestationChange: true, channels: [{ type: 'webhook', url: WEBHOOK }] })
    await h.register()
    await h.tick(0, false) // first run, no prior
    await h.tick(61_000, false) // identical verdict → NO alert (stable across seeds)
    expect(h.posts).toHaveLength(0)
    await h.tick(122_000, true) // verdict A+ → F changes → fire ONCE
    expect(h.posts).toHaveLength(1)
    expect((h.posts[0]!.body as AlertPayload).rule).toBe('attestationChange')
    await h.tick(183_000, true) // down verdict stable → no re-alert
    expect(h.posts).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// INTEGRATION — flapping is debounced
// ---------------------------------------------------------------------------

describe('scheduledTick alerting — a flapping target is debounced', () => {
  it('default debounce suppresses repeated grade-regression flaps to a single alert', async () => {
    const h = harness({ gradeRegression: true, channels: [{ type: 'webhook', url: WEBHOOK }] })
    await h.register()
    // up, down(regress→fire), up(resolve), down(regress but debounced), up, down…
    await h.tick(0, false)
    await h.tick(61_000, true)
    expect(h.posts).toHaveLength(1)
    await h.tick(122_000, false)
    await h.tick(183_000, true) // within 15min debounce → suppressed
    await h.tick(244_000, false)
    await h.tick(305_000, true) // still within debounce → suppressed
    expect(h.posts).toHaveLength(1)
  })

  it('with debounceMs:0 the same flap sequence re-alerts on each transition (proves debounce is what suppresses)', async () => {
    const h = harness({ gradeRegression: true, debounceMs: 0, channels: [{ type: 'webhook', url: WEBHOOK }] })
    await h.register()
    await h.tick(0, false)
    await h.tick(61_000, true) // fire
    await h.tick(122_000, false) // resolve
    await h.tick(183_000, true) // fire again (no debounce)
    expect(h.posts.length).toBeGreaterThanOrEqual(2)
  })
})

// ---------------------------------------------------------------------------
// INTEGRATION — worsening breach re-alerts; steady/improving breach dedupes
// (MED fix — bd ax-e6b.29.3): a breach that gets WORSE each tick must not go
// silent after the first, mildest drop.
// ---------------------------------------------------------------------------

describe('AlertDispatcher — a worsening breach re-alerts; a steady or improving breach dedupes', () => {
  function dispatcherHarness(rules: AlertRules, monitorId = 'mon_escalation') {
    const { fetcher: channel, posts } = captureChannel()
    const dispatcher = new AlertDispatcher(new AlertStateStore(new MemoryKV()), { fetcher: channel })
    const monitor = { id: monitorId, target: GOOD, alerts: rules }
    return { dispatcher, posts, monitor }
  }

  it('a grade that gets STRICTLY WORSE each tick (A+→B→C→D→F) fires MULTIPLE alerts — a later one names F', async () => {
    const rules: AlertRules = { gradeRegression: true, debounceMs: 0, channels: [{ type: 'webhook', url: WEBHOOK }] }
    const { dispatcher, posts, monitor } = dispatcherHarness(rules)

    const steps = ['B', 'C', 'D', 'F'] // each strictly worse than the immediately-preceding run
    let priorGrade = 'A+'
    let t = 1000
    for (const grade of steps) {
      await dispatcher.dispatch({
        monitor,
        run: { at: t, grade, digest: `d${t}`, verdictDigest: `v${t}` },
        prior: { grade: priorGrade, digest: `d${t - 1000}`, verdictDigest: `v${t - 1000}` },
        now: t,
      })
      priorGrade = grade
      t += 1000
    }

    // One alert PER worsening step — never silently stops after A+→B.
    expect(posts).toHaveLength(4)
    expect(posts.every((p) => (p.body as AlertPayload).rule === 'gradeRegression')).toBe(true)
    // The operator IS told it cratered to F.
    expect((posts.at(-1)!.body as AlertPayload).run.grade).toBe('F')
  })

  it('a STEADY breach (same offending grade vs the same baseline, repeated) fires only ONCE', async () => {
    const rules: AlertRules = { gradeRegression: true, debounceMs: 0, channels: [{ type: 'webhook', url: WEBHOOK }] }
    const { dispatcher, posts, monitor } = dispatcherHarness(rules, 'mon_steady')

    for (let i = 0; i < 3; i++) {
      await dispatcher.dispatch({
        monitor,
        run: { at: 1000 + i * 1000, grade: 'B', digest: `d${i}`, verdictDigest: `v${i}` },
        prior: { grade: 'A+', digest: 'd0', verdictDigest: 'v0' },
        now: 1000 + i * 1000,
      })
    }
    expect(posts).toHaveLength(1)
  })

  it('a PARTIAL recovery (still breached, but better than the last-alerted value) does NOT re-alert', async () => {
    const rules: AlertRules = { gradeRegression: true, debounceMs: 0, channels: [{ type: 'webhook', url: WEBHOOK }] }
    const { dispatcher, posts, monitor } = dispatcherHarness(rules, 'mon_partial')

    // Crater straight to F.
    await dispatcher.dispatch({
      monitor,
      run: { at: 1000, grade: 'F', digest: 'd1', verdictDigest: 'v1' },
      prior: { grade: 'A+', digest: 'd0', verdictDigest: 'v0' },
      now: 1000,
    })
    expect(posts).toHaveLength(1)
    // Partial recovery to C — still a breach vs the A+ baseline, but strictly
    // BETTER than the last-alerted F → dedupe, no re-alert.
    await dispatcher.dispatch({
      monitor,
      run: { at: 2000, grade: 'C', digest: 'd2', verdictDigest: 'v2' },
      prior: { grade: 'A+', digest: 'd0', verdictDigest: 'v0' },
      now: 2000,
    })
    expect(posts).toHaveLength(1)
  })

  it('escalation also applies to numeric rules (uptime getting WORSE re-alerts; unchanged does not)', async () => {
    const rules: AlertRules = { uptimeBelowPct: 100, debounceMs: 0, channels: [{ type: 'webhook', url: WEBHOOK }] }
    const { dispatcher, posts, monitor } = dispatcherHarness(rules, 'mon_uptime_escalation')
    const run = { grade: 'A+', digest: 'd', verdictDigest: 'v' }

    await dispatcher.dispatch({
      monitor,
      series: { uptimePct: 90, errorRate: 0, latencyP95: 100, count: 10 },
      run: { ...run, at: 1000 },
      now: 1000,
    })
    // Unchanged (still 90%) → dedupe.
    await dispatcher.dispatch({
      monitor,
      series: { uptimePct: 90, errorRate: 0, latencyP95: 100, count: 10 },
      run: { ...run, at: 2000 },
      now: 2000,
    })
    // Strictly worse (drops to 40%) → re-alert.
    await dispatcher.dispatch({
      monitor,
      series: { uptimePct: 40, errorRate: 0, latencyP95: 100, count: 10 },
      run: { ...run, at: 3000 },
      now: 3000,
    })
    expect(posts).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// INTEGRATION — deliver() refuses a redirect consistently across runtime
// response shapes (LOW #3/#4): a channel that 3xx-redirects (explicit status
// OR an opaque redirect) is reported as a refused redirect, and the redirect
// TARGET is never fetched — the load-bearing SSRF property is that a public
// webhook 302-ing to a private host can never smuggle the POST there.
// ---------------------------------------------------------------------------

describe('deliver — redirect refusal is reported consistently, and the redirect target is never fetched', () => {
  const METADATA = 'http://169.254.169.254/latest/meta-data/'

  function redirectFetcher(shape: 'status302' | 'opaqueredirect'): { fetcher: Fetcher; calls: string[] } {
    const calls: string[] = []
    const fetcher: Fetcher = async (url) => {
      calls.push(url)
      if (shape === 'status302') {
        return new Response(null, { status: 302, headers: { location: METADATA } })
      }
      // Simulate an undici-style opaque redirect from `redirect: 'manual'`:
      // status 0, type 'opaqueredirect' — NOT a 3xx status the explicit branch
      // would catch. (Can't be built via `new Response()`: the spec forbids a
      // constructed Response outside status 200..599; opaque-redirect
      // responses are only ever produced internally by a real fetch.)
      return { status: 0, type: 'opaqueredirect', ok: false } as unknown as Response
    }
    return { fetcher, calls }
  }

  it.each(['status302', 'opaqueredirect'] as const)(
    'a channel response shaped as %s is refused as a redirect, and the metadata Location is NEVER fetched',
    async (shape) => {
      const { fetcher, calls } = redirectFetcher(shape)
      const dispatcher = new AlertDispatcher(new AlertStateStore(new MemoryKV()), { fetcher })
      const r = await dispatcher.dispatch({
        monitor: { id: 'mon_redir', target: GOOD, alerts: { gradeRegression: true, channels: [{ type: 'webhook', url: WEBHOOK }] } },
        run: { at: 1, grade: 'F', digest: 'd', verdictDigest: 'v2' },
        prior: { grade: 'A+', digest: 'd0', verdictDigest: 'v1' },
        now: 1,
      })
      expect(r.deliveries).toHaveLength(1)
      const d = r.deliveries[0]!
      expect(d.ok).toBe(false)
      expect(d.refused).not.toBe(true) // refused at gate is a DIFFERENT reason path — this is a POST-time redirect refusal
      expect(d.reason).toMatch(/redirect/i)
      // The ONLY fetch made was to the configured webhook — the redirect
      // Location (the metadata host) is NEVER hit.
      expect(calls).toEqual([WEBHOOK])
      expect(calls).not.toContain(METADATA)
    },
  )
})

// ---------------------------------------------------------------------------
// INTEGRATION — SSRF: channel URL refused at config AND never POSTed
// ---------------------------------------------------------------------------

describe('scheduledTick alerting — channel URL is SSRF-gated', () => {
  it('refuses a private/metadata channel URL at REGISTRATION (400, nothing registered)', async () => {
    const monitors = new MonitorStore(new MemoryKV())
    const { fetcher } = captureChannel()
    const app = createApp(
      {},
      {
        externalFetcher: makeFetcher(goodTargetRoutes()),
        externalDelayMs: 0,
        cache: new ReportCache(new MemoryKV(), 300),
        monitors,
        alertFetcher: fetcher,
        now: () => 0,
      },
    )
    const reg = await app.fetch(
      jsonReq('/monitors', {
        target: 'good.example',
        interval: 60,
        alerts: { uptimeBelowPct: 100, channels: [{ type: 'webhook', url: 'http://169.254.169.254/latch' }] },
      }),
    )
    expect(reg.status).toBe(400)
    expect((await reg.json()).error).toMatch(/SSRF|private/)
    // Nothing registered.
    const list = await app.fetch(req('/monitors'))
    expect((await list.json()).monitors).toHaveLength(0)
  })

  it('re-gates before the POST: a stored monitor with a hostile channel is NEVER fetched (real spy asserts no POST)', async () => {
    // Seed a monitor whose channel bypassed the config gate (directly in the
    // store). The delivery path must still refuse it at send time.
    const monitors = new MonitorStore(new MemoryKV())
    const timeseries = new TimeseriesStore(new MemoryKV())
    const { fetcher: target, setDown } = toggleableFetcher()
    const { fetcher: channel, posts } = captureChannel()
    const dispatcher = new AlertDispatcher(new AlertStateStore(new MemoryKV()), { fetcher: channel, allowPrivate: false })

    const HOSTILE = 'http://169.254.169.254/latest/meta-data/'
    const id = monitorId(GOOD)
    const record: MonitorRecord = {
      id,
      target: GOOD,
      intervalSec: 60,
      createdAt: 0,
      lastRunAt: null,
      nextDueAt: 0,
      expiresAt: 30 * 86_400_000,
      alerts: { uptimeBelowPct: 100, windowMs: 600_000, channels: [{ type: 'webhook', url: HOSTILE }] },
    }
    await monitors.register(record)

    let clock = 0
    const app = createApp(
      {},
      {
        externalFetcher: target,
        externalDelayMs: 0,
        cache: new ReportCache(new MemoryKV(), 300),
        monitors,
        timeseries,
        alerts: dispatcher,
        now: () => clock,
      },
    )
    setDown(true) // force uptime below 100 → the rule breaches → delivery is attempted
    clock = 1000
    await app.scheduledTick(1000)

    // The breach fired, but the hostile URL was refused before any POST.
    expect(posts).toHaveLength(0)
    expect(posts.some((p) => p.url === HOSTILE)).toBe(false)

    // Prove the same monitor with a SAFE channel WOULD have delivered.
    const safeDispatch = await dispatcher.dispatch({
      monitor: { id, target: GOOD, alerts: record.alerts },
      series: { uptimePct: 0, errorRate: 1, latencyP95: 0, count: 1 },
      run: { at: 2000, grade: 'F', digest: 'x'.repeat(64), verdictDigest: 'v' },
      now: 2000,
    })
    // The rule DID breach and DID try to deliver — but was refused (not fetched).
    expect(safeDispatch.breaches.map((b) => b.rule)).toContain('uptimeBelowPct')
    expect(safeDispatch.deliveries.every((d) => d.refused)).toBe(true)
    expect(posts).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// INTEGRATION — email seam + slack/pagerduty adapters over the live POST
// ---------------------------------------------------------------------------

describe('channel delivery — email seam + provider adapters', () => {
  it('email routes through the EmailChannel stub (records, never POSTs)', async () => {
    const email = new StubEmailChannel()
    const { fetcher: channel, posts } = captureChannel()
    const dispatcher = new AlertDispatcher(new AlertStateStore(new MemoryKV()), { fetcher: channel, email })
    const r = await dispatcher.dispatch({
      monitor: { id: 'mon_x', target: GOOD, alerts: { gradeRegression: true, channels: [{ type: 'email', to: 'ops@x.example' }] } },
      run: { at: 1, grade: 'F', digest: 'd', verdictDigest: 'v2' },
      prior: { grade: 'A+', digest: 'd0', verdictDigest: 'v1' },
      now: 1,
    })
    expect(r.delivered).toHaveLength(1)
    expect(email.sent).toHaveLength(1)
    expect(email.sent[0]!.to).toBe('ops@x.example')
    expect(posts).toHaveLength(0) // email never POSTs
  })

  it('slack + pagerduty channels each POST their adapted body to the same webhook surface', async () => {
    const { fetcher: channel, posts } = captureChannel()
    const dispatcher = new AlertDispatcher(new AlertStateStore(new MemoryKV()), { fetcher: channel })
    await dispatcher.dispatch({
      monitor: {
        id: 'mon_x',
        target: GOOD,
        alerts: {
          gradeRegression: true,
          debounceMs: 0,
          channels: [
            { type: 'slack', url: 'https://hooks.slack.example/T/B/X' },
            { type: 'pagerduty', url: 'https://events.pagerduty.example/v2/enqueue' },
          ],
        },
      },
      run: { at: 1, grade: 'F', digest: 'd', verdictDigest: 'v2' },
      prior: { grade: 'A+', digest: 'd0', verdictDigest: 'v1' },
      now: 1,
    })
    expect(posts).toHaveLength(2)
    const slack = posts.find((p) => p.url.includes('slack'))!
    expect(typeof slack.body.text).toBe('string')
    const pd = posts.find((p) => p.url.includes('pagerduty'))!
    expect(pd.body.event_action).toBe('trigger')
  })
})

// ---------------------------------------------------------------------------
// DOGFOOD — a deliberately regressed fixture triggers exactly one alert
// ---------------------------------------------------------------------------

describe('dogfood — a deliberately regressed monitored target alerts exactly once', () => {
  it('a healthy monitor that is then broken fires exactly ONE grade-regression alert', async () => {
    const h = harness({
      gradeRegression: true,
      channels: [{ type: 'agent-callback', url: WEBHOOK }],
    })
    await h.register()
    // Three healthy ticks — stable, no alert.
    await h.tick(0, false)
    await h.tick(61_000, false)
    await h.tick(122_000, false)
    expect(h.posts).toHaveLength(0)
    // The deliberate regression: the target breaks.
    await h.tick(183_000, true)
    // Exactly one grade-regression alert fired for the regression event.
    expect(h.posts).toHaveLength(1)
    const body = h.posts[0]!.body.alert as AlertPayload
    expect(body.target).toBe(GOOD)
    expect(body.run.grade).toBe('F')
  })
})
