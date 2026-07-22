/**
 * Report renderers — the api.qa/{domain} public grade page, in three
 * negotiated shapes: markdown (curl/agents), minimal HTML + JSON-LD
 * (browsers), and the raw JSON report (Accept: application/json).
 */

import type { VerificationReport } from './types.js'
import type { PinnedReport, SuiteReport } from './pinned.js'
import type { DataDrivenReport } from './dataset.js'

const MARK: Record<string, string> = { pass: 'PASS', fail: 'FAIL', skip: 'skip' }

export function reportMarkdown(r: VerificationReport): string {
  const host = r.target.replace(/^https?:\/\//, '')
  const lines: string[] = [
    `# api.qa report — ${host}`,
    '',
    `> **Grade ${r.grade}** · AX score **${r.axScore.points}/10** · ${r.mode} mode · ${r.attested ? 'attested' : 'NOT attested (advisory)'}`,
    '',
    `- verified: ${r.verifiedAt}`,
    `- verifier: api.qa v${r.verifierVersion} · seed ${r.seed} (replayable)`,
    `- evidence digest: \`${r.discovery.evidenceDigest}\``,
    ...(r.attestation ? [`- report digest: \`${r.attestation.reportDigest}\` (Ed25519-signed)`] : []),
    ...(r.pinnedSpecDigest ? [`- pinned spec digest: \`${r.pinnedSpecDigest}\` (the ratified digest this verdict binds to)`] : []),
    '',
    '## AX score (the 10-point checklist)',
    '',
    '| # | check | verdict |',
    '| --- | --- | --- |',
    ...r.axScore.items.map((i) => `| ${i.item} | ${i.title} | ${MARK[i.verdict]} |`),
    '',
    '## Check details',
    '',
  ]
  for (const c of r.checks) {
    lines.push(`### ${MARK[c.verdict]} — ${c.title} (\`${c.id}\`)`, '', c.detail, '')
  }
  if (r.gradeNotes.length > 0) {
    lines.push('## Grade notes', '', ...r.gradeNotes.map((n) => `- ${n}`), '')
  }
  lines.push(
    '## Replay this verdict',
    '',
    'The full evidence bundle is embedded in the JSON report. Judging is a pure',
    'function of the bundle — re-run the checks over it and you MUST get this',
    'same grade, or the report is forged / the verifier version changed:',
    '',
    '```sh',
    `curl -H 'accept: application/json' https://api.qa/${host} | npx autonomous-qa rejudge`,
    '```',
    '',
  )
  return lines.join('\n')
}

export function pinnedMarkdown(r: PinnedReport): string {
  const lines = [
    `# api.qa pinned-spec report — ${r.target.replace(/^https?:\/\//, '')}`,
    '',
    `> **${r.passed ? 'PASSED' : 'FAILED'}** against \`${r.spec.name}@${r.spec.version}\``,
    `> spec digest \`${r.spec.digest}\` · ${r.mode} mode · ${r.attested ? 'attested' : 'NOT attested (advisory)'}`,
    '',
    '| requirement | verdict | detail |',
    '| --- | --- | --- |',
    ...r.requirements.map((c) => `| ${c.title} (\`${c.id}\`) | ${MARK[c.verdict]} | ${c.detail.replace(/\|/g, '\\|')} |`),
    '',
  ]
  return lines.join('\n')
}

export function suiteMarkdown(r: SuiteReport): string {
  const lines = [
    `# api.qa suite report — ${r.target.replace(/^https?:\/\//, '')}`,
    '',
    `> **${r.passed ? 'PASSED' : 'FAILED'}** against \`${r.suite.name}@${r.suite.version}\` · environment \`${r.suite.environment}\``,
    `> suite digest \`${r.suite.digest}\` · ${r.mode} mode · ${r.attested ? 'attested' : 'NOT attested (advisory)'}`,
    '',
    '| # | probe | verdict | detail |',
    '| --- | --- | --- | --- |',
    ...r.requirements.map(
      (c, i) => `| ${i + 1} | ${c.title} (\`${c.id}\`) | ${MARK[c.verdict]} | ${c.detail.replace(/\|/g, '\\|')} |`,
    ),
    '',
  ]
  return lines.join('\n')
}

const CELL: Record<string, string> = { pass: 'PASS', fail: 'FAIL', skip: 'skip', error: 'ERR!' }

/**
 * Data-driven run: a per-iteration × per-probe pass/fail MATRIX plus an OVERALL
 * verdict. One row per dataset iteration, one column per suite probe.
 */
export function dataDrivenMarkdown(r: DataDrivenReport): string {
  const header = ['iter', ...r.probeIds.map((id) => `\`${id}\``), 'row verdict']
  const sep = header.map(() => '---')
  const rows = r.iterations.map((it) => {
    const cells = r.probeIds.map((id) => CELL[it.verdicts[id] ?? 'error'] ?? '?')
    const verdict = it.error ? `FAIL (refused: ${it.error.replace(/\|/g, '\\|')})` : it.passed ? 'PASS' : 'FAIL'
    return `| ${it.index} | ${cells.join(' | ')} | ${verdict} |`
  })
  return [
    `# api.qa data-driven suite report — ${r.suite.name}@${r.suite.version}`,
    '',
    `> **${r.passed ? 'PASSED' : 'FAILED'}** · ${r.passedCount}/${r.total} iterations passed · environment \`${r.suite.environment}\``,
    `> suite digest \`${r.suite.digest}\` · ${r.mode} mode · NOT attested (advisory)`,
    '',
    `| ${header.join(' | ')} |`,
    `| ${sep.join(' | ')} |`,
    ...rows,
    '',
  ].join('\n')
}

export function reportHtml(r: VerificationReport): string {
  const host = r.target.replace(/^https?:\/\//, '')
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'ClaimReview',
    url: `https://api.qa/${host}`,
    claimReviewed: `${host} is an agent-first API`,
    reviewRating: { '@type': 'Rating', ratingValue: r.axScore.points, bestRating: 10, worstRating: 0, alternateName: r.grade },
    author: { '@type': 'Organization', name: 'api.qa', url: 'https://api.qa' },
    datePublished: r.verifiedAt,
  }
  const rows = r.axScore.items
    .map((i) => `<tr><td>${i.item}</td><td>${esc(i.title)}</td><td class="${i.verdict}">${MARK[i.verdict]}</td></tr>`)
    .join('\n')
  const details = r.checks
    .map((c) => `<li><strong class="${c.verdict}">${MARK[c.verdict]}</strong> ${esc(c.title)} <code>${c.id}</code><br><small>${esc(c.detail)}</small></li>`)
    .join('\n')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>api.qa/${esc(host)} · Grade ${r.grade}</title>
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<style>
  :root{--bg:oklch(0.988 0.006 175);--fg:oklch(0.205 0.021 210);--mut:oklch(0.470 0.020 200);
    --line:oklch(0.905 0.013 190);--chip:oklch(0.958 0.010 185);
    --pass:oklch(0.560 0.140 158);--fail:oklch(0.560 0.198 27);--skip:oklch(0.640 0.018 200)}
  @media (prefers-color-scheme: dark){
    :root{--bg:oklch(0.165 0.021 220);--fg:oklch(0.935 0.012 185);--mut:oklch(0.660 0.022 195);
      --line:oklch(0.290 0.022 218);--chip:oklch(0.235 0.024 218);
      --pass:oklch(0.720 0.150 158);--fail:oklch(0.680 0.190 27);--skip:oklch(0.600 0.020 200)}
  }
  body{font:16px/1.5 system-ui,sans-serif;max-width:44rem;margin:2rem auto;padding:0 1rem;
    background:var(--bg);color:var(--fg);font-variant-numeric:tabular-nums}
  h1 small{color:var(--mut);font-weight:400}
  .grade{font-size:4rem;font-weight:800;line-height:1;margin:.25rem 0}
  .tblwrap{overflow-x:auto}
  table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid var(--line);padding:.35rem .5rem;text-align:left}
  th{color:var(--mut);font-weight:600}
  .pass{color:var(--pass)}.fail{color:var(--fail)}.skip{color:var(--skip)}
  small{color:var(--mut)}
  code{background:var(--chip);padding:.1rem .3rem;border-radius:4px;
    font-family:ui-monospace,'SF Mono',Menlo,Consolas,monospace;font-size:.9em}
  li{margin:.5rem 0}
</style>
</head>
<body>
<h1>api.qa <small>/${esc(host)}</small></h1>
<p class="grade ${r.grade === 'F' || r.grade === 'D' ? 'fail' : ''}">${r.grade}</p>
<p>AX score <strong>${r.axScore.points}/10</strong> · ${r.mode} mode · ${r.attested ? 'attested (Ed25519)' : 'not attested (advisory)'}<br>
<small>verified ${esc(r.verifiedAt)} · seed ${r.seed} · evidence <code>${r.discovery.evidenceDigest.slice(0, 16)}…</code></small></p>
<div class="tblwrap"><table><thead><tr><th>#</th><th>check</th><th>verdict</th></tr></thead><tbody>
${rows}
</tbody></table></div>
<h2>Details</h2>
<ul>
${details}
</ul>
${r.gradeNotes.length ? `<h2>Grade notes</h2><ul>${r.gradeNotes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
<p><small>Agents: <code>curl https://api.qa/${esc(host)}</code> returns this report as markdown;
<code>accept: application/json</code> returns the full report with the replayable evidence bundle.</small></p>
</body>
</html>`
}

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
