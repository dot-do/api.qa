/**
 * Alerting (bd ax-e6b.29.3) — fire an ALERT when a monitored target crosses a
 * configured threshold over its time-series, REGRESSES a grade, or its ATTESTED
 * VERDICT changes; deliver it to a configured channel; and DEDUPE/DEBOUNCE so a
 * persisting or flapping breach never alert-cannons.
 *
 * This module builds ON TOP of the estate's existing substrate — it never
 * re-probes and never re-judges. Rules evaluate over the ax-e6b.29.2 time-series
 * (uptime / latency / error-rate) plus the current-vs-prior run record (grade,
 * and the STABLE attested-verdict digest — attest.ts `verdictDigest`, seed-
 * independent, unlike the per-run evidence digest). Everything here is pure
 * except the delivery POST.
 *
 * SSRF (the load-bearing safety property). A channel URL is USER-CONFIGURED and
 * api.qa POSTs to it — a brand-new OUTBOUND-fetch surface. A private / loopback /
 * link-local / metadata channel URL (or a non-http(s) scheme) would turn api.qa
 * into an SSRF POST engine. So a channel URL is validated with the SAME
 * private-host primitive the rest of api.qa uses (`isPrivateHost`, the core of
 * both `normalizeTarget` and `isPubliclyRoutableSameOrigin`) at BOTH config time
 * (`assertChannelUrlSafe`, called from the /monitors registration route) AND
 * immediately before EVERY delivery POST (belt + suspenders — a stored monitor
 * whose env later flips is still refused at send). Redirects on an alert POST are
 * REFUSED, never followed (`redirect: 'manual'` + a 3xx → delivery failure), so a
 * webhook that 3xx-redirects to 169.254.169.254 can never smuggle the POST there.
 * All checks fail CLOSED: an unparseable/unsafe URL is never fetched.
 */

import type { KVLike } from './cache.js'
import { isPrivateHost } from './http.js'
import { gradeRank } from './grade.js'
import type { Fetcher } from './http.js'

// ---------------------------------------------------------------------------
// Config: rules + channels
// ---------------------------------------------------------------------------

/** The five alertable conditions. Each is a distinct dedupe key per monitor. */
export type AlertRuleId =
  | 'uptimeBelowPct'
  | 'latencyAboveMs'
  | 'errorRateAbove'
  | 'gradeRegression'
  | 'attestationChange'

export const ALERT_RULE_IDS: AlertRuleId[] = [
  'uptimeBelowPct',
  'latencyAboveMs',
  'errorRateAbove',
  'gradeRegression',
  'attestationChange',
]

/**
 * A channel type selects the POST PAYLOAD SHAPE. `webhook` and `agent-callback`
 * are the two generic outbound-POST channels; `slack` and `pagerduty` are thin
 * adapters that re-shape the same payload into their provider's incoming-webhook
 * body; `email` is a provider integration behind the `EmailChannel` seam (a
 * documented stub — no real provider is built here).
 */
export type ChannelType = 'webhook' | 'agent-callback' | 'slack' | 'pagerduty' | 'email'

export interface AlertChannel {
  type: ChannelType
  /** POST target for webhook / agent-callback / slack / pagerduty. */
  url?: string
  /** Recipient for the `email` channel (delivered via the EmailChannel seam). */
  to?: string
}

export interface AlertRules {
  /** Fire when windowed uptime % is BELOW this (0..100). */
  uptimeBelowPct?: number
  /** Fire when windowed p95 latency (ms) is ABOVE this. */
  latencyAboveMs?: number
  /** Fire when windowed error-rate (0..1) is ABOVE this. */
  errorRateAbove?: number
  /** Fire when this run's grade dropped vs the prior run. */
  gradeRegression?: boolean
  /** Fire when the attested VERDICT digest changed vs the prior run. */
  attestationChange?: boolean
  /** Window (ms) the uptime/latency/error-rate thresholds evaluate over. */
  windowMs?: number
  /**
   * Minimum ms between successive alerts for the SAME (monitor, rule) — the
   * DEBOUNCE that stops a flapping target (breach→resolve→breach…) from alert-
   * cannoning: after one alert, further transitions are suppressed until this
   * long has passed. Default `DEFAULT_DEBOUNCE_MS`.
   */
  debounceMs?: number
  /**
   * Re-notify interval (ms): re-alert a STILL-firing rule this long after the
   * last notification (escalation). Omit → never re-notify while firing (the
   * pure transition-only dedupe).
   */
  renotifyMs?: number
  /** Also send a `resolved` notification when a firing rule clears. Default off. */
  resolveNotify?: boolean
  /** Where to deliver. At least one channel is required for a rule to alert. */
  channels: AlertChannel[]
}

/** Sensible default gap between alerts for one rule (15 min) — bounds flapping. */
export const DEFAULT_DEBOUNCE_MS = 15 * 60 * 1000
/** Default window the numeric thresholds evaluate over (1h). */
export const DEFAULT_ALERT_WINDOW_MS = 60 * 60 * 1000

// ---------------------------------------------------------------------------
// Evaluation inputs + outputs
// ---------------------------------------------------------------------------

/** The windowed series metrics a numeric rule reads (from the .29.2 query). */
export interface SeriesMetrics {
  uptimePct: number
  errorRate: number
  latencyP95: number
  /** Samples in the window — a numeric rule never fires on an empty window. */
  count: number
}

export interface RunFacts {
  at: number
  grade: string
  /** The run's evidence digest (the per-run attestation anchor). */
  digest: string
  /** The STABLE attested-verdict digest (attest.ts `verdictDigest`). */
  verdictDigest: string
}

export interface PriorFacts {
  grade: string
  digest: string
  verdictDigest?: string
}

/** One breached rule: which rule, a human condition, and actual vs threshold. */
export interface AlertBreach {
  rule: AlertRuleId
  condition: string
  actual: number | string
  threshold: number | string
}

export interface EvalContext {
  series?: SeriesMetrics
  run: RunFacts
  prior?: PriorFacts
}

/** Which rules are CONFIGURED (present) on this rule set, in stable order. */
export function configuredRuleIds(rules: AlertRules): AlertRuleId[] {
  return ALERT_RULE_IDS.filter((id) => {
    const v = (rules as unknown as Record<string, unknown>)[id]
    return v !== undefined && v !== false
  })
}

/**
 * PURE rule evaluation: which configured rules are BREACHED given the windowed
 * series + this-run-vs-prior-run facts. Numeric rules require a non-empty window;
 * grade/attestation rules require a prior run (the first run of a monitor can
 * never regress against nothing).
 */
export function evaluateAlertRules(rules: AlertRules, ctx: EvalContext): AlertBreach[] {
  const out: AlertBreach[] = []
  const s = ctx.series

  if (rules.uptimeBelowPct !== undefined && s && s.count > 0 && s.uptimePct < rules.uptimeBelowPct) {
    out.push({
      rule: 'uptimeBelowPct',
      condition: `uptime ${round1(s.uptimePct)}% < ${rules.uptimeBelowPct}%`,
      actual: round1(s.uptimePct),
      threshold: rules.uptimeBelowPct,
    })
  }
  if (rules.latencyAboveMs !== undefined && s && s.count > 0 && s.latencyP95 > rules.latencyAboveMs) {
    out.push({
      rule: 'latencyAboveMs',
      condition: `p95 latency ${s.latencyP95}ms > ${rules.latencyAboveMs}ms`,
      actual: s.latencyP95,
      threshold: rules.latencyAboveMs,
    })
  }
  if (rules.errorRateAbove !== undefined && s && s.count > 0 && s.errorRate > rules.errorRateAbove) {
    out.push({
      rule: 'errorRateAbove',
      condition: `error-rate ${round3(s.errorRate)} > ${rules.errorRateAbove}`,
      actual: round3(s.errorRate),
      threshold: rules.errorRateAbove,
    })
  }
  if (
    rules.gradeRegression &&
    ctx.prior &&
    gradeRank(ctx.run.grade) >= 0 &&
    gradeRank(ctx.prior.grade) >= 0 &&
    gradeRank(ctx.run.grade) < gradeRank(ctx.prior.grade)
  ) {
    out.push({
      rule: 'gradeRegression',
      condition: `grade ${ctx.prior.grade} → ${ctx.run.grade} regressed`,
      actual: ctx.run.grade,
      threshold: ctx.prior.grade,
    })
  }
  if (
    rules.attestationChange &&
    ctx.prior &&
    ctx.prior.verdictDigest !== undefined &&
    ctx.run.verdictDigest !== ctx.prior.verdictDigest
  ) {
    out.push({
      rule: 'attestationChange',
      condition: `attested verdict digest changed (${short(ctx.prior.verdictDigest)} → ${short(ctx.run.verdictDigest)})`,
      actual: short(ctx.run.verdictDigest),
      threshold: short(ctx.prior.verdictDigest),
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Dedupe / debounce state machine (pure)
// ---------------------------------------------------------------------------

/** Per (monitor, rule) alert state. */
export interface AlertState {
  firing: boolean
  /** ms epoch of the last notification actually SENT (null = never). */
  lastNotifiedAt: number | null
  /**
   * The offending `AlertBreach.actual` AT the time of the last notification
   * (null = never notified). Lets a STILL-firing severity/regression rule
   * re-notify when the breach gets STRICTLY WORSE than what was last
   * reported — a grade cratering A+→B→C→D→F must not go silent after the
   * first (mildest) drop just because it never "resolves" in between.
   */
  lastAlertedValue?: number | string | null
}

export function initialAlertState(): AlertState {
  return { firing: false, lastNotifiedAt: null, lastAlertedValue: null }
}

export type AlertDecision = { deliver: 'firing' | 'resolved' | null; nextState: AlertState }

/**
 * Rules whose `actual` has a meaningful "worse than before" ordering — the
 * only rules eligible for worsening-breach re-notification. `attestationChange`
 * is a binary change-event (not a severity scale) and is intentionally
 * excluded: it already re-fires exactly when the verdict digest itself
 * changes, via the normal transition path.
 */
function isSeverityRule(rule: AlertRuleId): boolean {
  return rule === 'gradeRegression' || rule === 'uptimeBelowPct' || rule === 'latencyAboveMs' || rule === 'errorRateAbove'
}

/**
 * Is `actual` STRICTLY WORSE than `lastAlertedValue` for this rule? Grade
 * regressions compare by `gradeRank` (lower rank = worse); uptime breaches
 * get worse as the actual % drops further below the threshold; latency/
 * error-rate breaches get worse as the actual climbs further above it. A
 * missing/unparseable `lastAlertedValue` is treated as "nothing to compare
 * against yet" (never worse) — callers only reach here once already firing,
 * so this is a defensive fallback, not the common path.
 */
function isWorseBreach(rule: AlertRuleId, actual: number | string, lastAlertedValue: number | string | null | undefined): boolean {
  if (lastAlertedValue === null || lastAlertedValue === undefined) return false
  if (rule === 'gradeRegression') {
    const curRank = gradeRank(String(actual))
    const lastRank = gradeRank(String(lastAlertedValue))
    return curRank >= 0 && lastRank >= 0 && curRank < lastRank
  }
  const cur = Number(actual)
  const last = Number(lastAlertedValue)
  if (!Number.isFinite(cur) || !Number.isFinite(last)) return false
  if (rule === 'uptimeBelowPct') return cur < last
  // latencyAboveMs / errorRateAbove
  return cur > last
}

/**
 * The PURE dedupe/debounce decision for ONE rule given whether it is breached
 * NOW and its stored state:
 *   - alert on the TRANSITION into breach (not every tick in breach — dedupe);
 *   - optionally re-alert a still-firing rule after `renotifyMs`;
 *   - for severity/regression rules, ALSO re-alert when the breach gets
 *     STRICTLY WORSE than the last-alerted value (escalation) — a steady or
 *     improving breach stays deduped;
 *   - suppress any alert within `debounceMs` of the last one (debounce flapping);
 *   - optionally emit a `resolved` notification when a firing rule clears.
 * Every actual delivery advances `lastNotifiedAt` (and `lastAlertedValue`), so
 * the debounce spacing holds across resolve→re-breach cycles — a flapping
 * target gets at most one alert per debounce window.
 *
 * `breach` is optional (and omitted by pure state-machine tests that only
 * exercise transition/renotify/debounce) — without it, escalation never
 * triggers and behavior is exactly the prior transition-only dedupe.
 */
export function decideAlert(
  breached: boolean,
  state: AlertState,
  now: number,
  rules: AlertRules,
  breach?: AlertBreach,
): AlertDecision {
  const debounceMs = rules.debounceMs ?? DEFAULT_DEBOUNCE_MS
  const debounced = state.lastNotifiedAt !== null && now - state.lastNotifiedAt < debounceMs

  if (breached) {
    const transition = !state.firing
    const renotifyDue =
      rules.renotifyMs !== undefined &&
      state.lastNotifiedAt !== null &&
      now - state.lastNotifiedAt >= rules.renotifyMs
    const worsening =
      !transition &&
      breach !== undefined &&
      isSeverityRule(breach.rule) &&
      isWorseBreach(breach.rule, breach.actual, state.lastAlertedValue)
    if ((transition || renotifyDue || worsening) && !debounced) {
      return {
        deliver: 'firing',
        nextState: { firing: true, lastNotifiedAt: now, lastAlertedValue: breach?.actual ?? state.lastAlertedValue ?? null },
      }
    }
    // Persisting (unchanged or improving-but-still-breached), or debounced:
    // stay firing, do NOT re-notify, keep the last-alerted value as-is.
    return { deliver: null, nextState: { firing: true, lastNotifiedAt: state.lastNotifiedAt, lastAlertedValue: state.lastAlertedValue ?? null } }
  }

  // Not breached now.
  if (state.firing) {
    if (rules.resolveNotify && !debounced) {
      return { deliver: 'resolved', nextState: { firing: false, lastNotifiedAt: now, lastAlertedValue: state.lastAlertedValue ?? null } }
    }
    return { deliver: null, nextState: { firing: false, lastNotifiedAt: state.lastNotifiedAt, lastAlertedValue: state.lastAlertedValue ?? null } }
  }
  return { deliver: null, nextState: state }
}

// ---------------------------------------------------------------------------
// Alert state store (pure KV)
// ---------------------------------------------------------------------------

/** Per (monitor, rule) alert-state store over the injectable KVLike. */
export class AlertStateStore {
  constructor(private readonly kv: KVLike) {}

  private key(monitorId: string, rule: AlertRuleId): string {
    return `alert:${monitorId}:${rule}`
  }

  async get(monitorId: string, rule: AlertRuleId): Promise<AlertState> {
    const raw = await this.kv.get(this.key(monitorId, rule))
    if (!raw) return initialAlertState()
    try {
      const s = JSON.parse(raw) as Partial<AlertState>
      return {
        firing: !!s.firing,
        lastNotifiedAt: typeof s.lastNotifiedAt === 'number' ? s.lastNotifiedAt : null,
        lastAlertedValue:
          typeof s.lastAlertedValue === 'number' || typeof s.lastAlertedValue === 'string' ? s.lastAlertedValue : null,
      }
    } catch {
      return initialAlertState()
    }
  }

  async put(monitorId: string, rule: AlertRuleId, state: AlertState): Promise<void> {
    await this.kv.put(this.key(monitorId, rule), JSON.stringify(state))
  }
}

// ---------------------------------------------------------------------------
// The alert payload (names target + condition + offending run)
// ---------------------------------------------------------------------------

export interface AlertPayload {
  $type: 'api.qa/Alert'
  status: 'firing' | 'resolved'
  monitorId: string
  target: string
  rule: AlertRuleId
  /** Human condition: which rule + actual vs threshold. */
  condition: string
  actual: number | string
  threshold: number | string
  /** The offending run: its instant, grade, and evidence digest. */
  run: { at: number; grade: string; digest: string }
  /** The prior run this run was compared against, when relevant. */
  prior?: { grade: string; digest: string }
  firedAt: number
}

// ---------------------------------------------------------------------------
// Channel URL SSRF gate (reuses the estate's isPrivateHost primitive)
// ---------------------------------------------------------------------------

export type ChannelUrlCheck = { ok: true; url: string } | { ok: false; error: string }

/**
 * The single channel-URL SSRF gate, used at BOTH config time and send time. A
 * channel URL is safe only when it parses, is http(s) (no file:/gopher:/…), and
 * — unless `allowPrivate` (the dev/CLI escape hatch, same signal as
 * normalizeTarget) — resolves to a public host (not private/loopback/link-local/
 * metadata, and not a bare single-label host). Fails closed on anything else.
 */
export function assertChannelUrlSafe(rawUrl: string | undefined, allowPrivate = false): ChannelUrlCheck {
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
    return { ok: false, error: 'channel url is required' }
  }
  let u: URL
  try {
    u = new URL(rawUrl.trim())
  } catch {
    return { ok: false, error: `channel url is not a valid URL: ${rawUrl}` }
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, error: `refusing non-http(s) channel url scheme: ${u.protocol}` }
  }
  if (!allowPrivate) {
    if (isPrivateHost(u.hostname)) {
      return { ok: false, error: `refusing private/metadata channel url (SSRF): ${u.hostname}` }
    }
    if (!u.hostname.includes('.')) {
      return { ok: false, error: `refusing single-label channel host: ${u.hostname}` }
    }
  }
  return { ok: true, url: u.toString() }
}

/**
 * Validate a whole rule set's channels at CONFIG time (registration). Returns
 * the first error, or null when every channel is deliverable. Email channels are
 * validated for a recipient only (they never POST — they go through the seam).
 */
export function validateAlertRules(rules: AlertRules, allowPrivate = false): string | null {
  if (!Array.isArray(rules.channels) || rules.channels.length === 0) {
    return 'alert rules must include at least one channel'
  }
  const anyCondition = configuredRuleIds(rules).length > 0
  if (!anyCondition) return 'alert rules must configure at least one condition'
  for (const num of ['uptimeBelowPct', 'latencyAboveMs', 'errorRateAbove', 'windowMs', 'debounceMs', 'renotifyMs'] as const) {
    const v = rules[num]
    if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v < 0)) {
      return `alert rule "${num}" must be a non-negative number`
    }
  }
  for (const ch of rules.channels) {
    if (ch.type === 'email') {
      if (typeof ch.to !== 'string' || ch.to.trim() === '') return 'email channel requires "to"'
      continue
    }
    const safe = assertChannelUrlSafe(ch.url, allowPrivate)
    if (!safe.ok) return safe.error
  }
  return null
}

// ---------------------------------------------------------------------------
// Channel payload adapters (thin re-shapes over the same POST)
// ---------------------------------------------------------------------------

function summaryLine(p: AlertPayload): string {
  const verb = p.status === 'firing' ? 'ALERT' : 'RESOLVED'
  return `[api.qa ${verb}] ${p.target} — ${p.rule}: ${p.condition} (run @${p.run.at}, grade ${p.run.grade}, digest ${short(p.run.digest)})`
}

/** Re-shape the canonical payload into the wire body a channel type expects. */
export function shapeChannelBody(type: ChannelType, p: AlertPayload): unknown {
  switch (type) {
    case 'webhook':
      return p
    case 'agent-callback':
      // An agent callback: the same payload wrapped so the receiving agent can
      // route it as an api.qa alert callback.
      return { $type: 'api.qa/AgentCallback', event: 'alert', alert: p }
    case 'slack':
      // Slack incoming-webhook shape (a thin adapter over the same POST).
      return { text: summaryLine(p) }
    case 'pagerduty':
      // PagerDuty Events API v2 shape (a thin adapter over the same POST).
      return {
        event_action: p.status === 'firing' ? 'trigger' : 'resolve',
        dedup_key: `${p.monitorId}:${p.rule}`,
        payload: {
          summary: summaryLine(p),
          source: p.target,
          severity: p.status === 'firing' ? 'error' : 'info',
          custom_details: p,
        },
      }
    case 'email':
      return p // never posted — email goes through the EmailChannel seam
  }
}

// ---------------------------------------------------------------------------
// Email channel — a documented ADAPTER SEAM + stub (NOT a real provider)
// ---------------------------------------------------------------------------

/**
 * The email delivery seam. Email is a PROVIDER integration (SES / Postmark /
 * Resend / SMTP …) and is deliberately NOT built here — a real provider is
 * injected by wiring a concrete `EmailChannel` into the `AlertDispatcher`. The
 * shipped default is `StubEmailChannel`, which records-but-does-not-send, so the
 * alert pipeline is testable end-to-end without a mail provider.
 */
export interface EmailChannel {
  send(msg: { to: string; subject: string; body: string; alert: AlertPayload }): Promise<{ ok: boolean }>
}

/** The default no-op email channel: records the message, sends nothing. */
export class StubEmailChannel implements EmailChannel {
  readonly sent: Array<{ to: string; subject: string; body: string }> = []
  async send(msg: { to: string; subject: string; body: string }): Promise<{ ok: boolean }> {
    this.sent.push({ to: msg.to, subject: msg.subject, body: msg.body })
    // Documented seam: no real provider is wired — report not-sent so callers
    // never mistake the stub for a real delivery.
    return { ok: false }
  }
}

// ---------------------------------------------------------------------------
// The dispatcher — evaluate → decide → deliver
// ---------------------------------------------------------------------------

export interface DispatchInput {
  monitor: { id: string; target: string; alerts?: AlertRules }
  series?: SeriesMetrics
  run: RunFacts
  prior?: PriorFacts
  now: number
}

export interface DeliveryResult {
  channel: ChannelType
  target?: string
  ok: boolean
  /** Set when the channel URL was refused by the SSRF gate (never fetched). */
  refused?: boolean
  status?: number
  reason?: string
}

export interface DispatchResult {
  breaches: AlertBreach[]
  delivered: AlertPayload[]
  deliveries: DeliveryResult[]
}

export interface AlertDispatcherOpts {
  fetcher?: Fetcher
  allowPrivate?: boolean
  email?: EmailChannel
}

export class AlertDispatcher {
  private readonly fetcher: Fetcher
  private readonly allowPrivate: boolean
  readonly email: EmailChannel

  constructor(
    private readonly store: AlertStateStore,
    opts: AlertDispatcherOpts = {},
  ) {
    this.fetcher = opts.fetcher ?? ((u, i) => fetch(u, i))
    this.allowPrivate = opts.allowPrivate ?? false
    this.email = opts.email ?? new StubEmailChannel()
  }

  /**
   * Evaluate every configured rule for this run, apply the dedupe/debounce state
   * machine per (monitor, rule), and deliver any firing/resolved alerts to the
   * rule's channels. Returns what was evaluated + delivered (for tests/metrics).
   * Delivery failures never throw out of here — a bad channel must not break the
   * scheduled tick.
   */
  async dispatch(input: DispatchInput): Promise<DispatchResult> {
    const result: DispatchResult = { breaches: [], delivered: [], deliveries: [] }
    const rules = input.monitor.alerts
    if (!rules) return result

    const ctx: EvalContext = { series: input.series, run: input.run, prior: input.prior }
    const breaches = evaluateAlertRules(rules, ctx)
    result.breaches = breaches
    const breachByRule = new Map(breaches.map((b) => [b.rule, b]))

    for (const ruleId of configuredRuleIds(rules)) {
      const breached = breachByRule.has(ruleId)
      const state = await this.store.get(input.monitor.id, ruleId)
      const decision = decideAlert(breached, state, input.now, rules, breachByRule.get(ruleId))
      await this.store.put(input.monitor.id, ruleId, decision.nextState)
      if (!decision.deliver) continue

      const payload = this.buildPayload(input, ruleId, decision.deliver, breachByRule.get(ruleId))
      result.delivered.push(payload)
      for (const ch of rules.channels) {
        result.deliveries.push(await this.deliver(ch, payload))
      }
    }
    return result
  }

  private buildPayload(
    input: DispatchInput,
    rule: AlertRuleId,
    status: 'firing' | 'resolved',
    breach: AlertBreach | undefined,
  ): AlertPayload {
    return {
      $type: 'api.qa/Alert',
      status,
      monitorId: input.monitor.id,
      target: input.monitor.target,
      rule,
      condition: breach?.condition ?? `${rule} resolved`,
      actual: breach?.actual ?? '',
      threshold: breach?.threshold ?? '',
      run: { at: input.run.at, grade: input.run.grade, digest: input.run.digest },
      ...(input.prior ? { prior: { grade: input.prior.grade, digest: input.prior.digest } } : {}),
      firedAt: input.now,
    }
  }

  private async deliver(channel: AlertChannel, payload: AlertPayload): Promise<DeliveryResult> {
    if (channel.type === 'email') {
      const to = channel.to ?? ''
      if (!to) return { channel: 'email', ok: false, reason: 'email channel missing "to"' }
      const r = await this.email.send({
        to,
        subject: summaryLine(payload),
        body: JSON.stringify(payload, null, 2),
        alert: payload,
      })
      return { channel: 'email', target: to, ok: r.ok }
    }

    // BELT + SUSPENDERS: re-gate the channel URL immediately before the POST,
    // even though registration already validated it — a stored monitor whose
    // env later flips (or was seeded around the config gate) is still refused
    // here and NEVER fetched.
    const safe = assertChannelUrlSafe(channel.url, this.allowPrivate)
    if (!safe.ok) {
      return { channel: channel.type, target: channel.url, ok: false, refused: true, reason: safe.error }
    }

    const body = shapeChannelBody(channel.type, payload)
    try {
      const res = await this.fetcher(safe.url, {
        method: 'POST',
        // Alert POSTs NEVER follow redirects — a 3xx to a metadata host is an
        // SSRF smuggle. Manual mode + a 3xx → delivery failure, not a hop.
        redirect: 'manual',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      // A redirect is refused whether the runtime surfaces it as an explicit
      // 3xx status (`res.status` 300..399) OR as an OPAQUE redirect — some
      // runtimes (e.g. undici) resolve a `redirect: 'manual'` 3xx into a
      // status-0 `type: 'opaqueredirect'` Response instead. Both shapes NEVER
      // followed the hop; this only affects how the refusal is REPORTED, so
      // reporting is consistent (and testable) across runtimes.
      const isRedirect = (res.status >= 300 && res.status < 400) || res.type === 'opaqueredirect' || res.status === 0
      if (isRedirect) {
        return {
          channel: channel.type,
          target: safe.url,
          ok: false,
          reason: `refusing to follow redirect on alert POST (status ${res.status}${res.type === 'opaqueredirect' ? ', opaqueredirect' : ''})`,
        }
      }
      return { channel: channel.type, target: safe.url, ok: res.ok, status: res.status }
    } catch (err) {
      return {
        channel: channel.type,
        target: safe.url,
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
      }
    }
  }
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function round1(n: number): number {
  return Math.round(n * 10) / 10
}
function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}
function short(digest: string): string {
  return digest.length > 12 ? digest.slice(0, 12) : digest
}
