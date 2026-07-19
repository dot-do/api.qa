/**
 * Report renderers — the api.qa/{domain} public grade page, in three
 * negotiated shapes: markdown (curl/agents), minimal HTML + JSON-LD
 * (browsers), and the raw JSON report (Accept: application/json).
 */

import type { VerificationReport } from './types.js'
import type { PinnedReport } from './pinned.js'

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
    ...(r.pinnedSpecDigest ? [`- pinned spec digest: \`${r.pinnedSpecDigest}\``] : []),
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
    .map((c) => `<li class="${c.verdict}"><strong>${MARK[c.verdict]}</strong> ${esc(c.title)} <code>${c.id}</code><br><small>${esc(c.detail)}</small></li>`)
    .join('\n')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>api.qa — ${esc(host)} — Grade ${r.grade}</title>
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<style>
  body{font:16px/1.5 system-ui,sans-serif;max-width:44rem;margin:2rem auto;padding:0 1rem;color:#111}
  .grade{font-size:4rem;font-weight:800}
  table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:.35rem .5rem;text-align:left}
  .pass{color:#087443}.fail{color:#b42318}.skip{color:#667085}
  code{background:#f4f4f5;padding:.1rem .3rem;border-radius:4px}
  li{margin:.5rem 0}
</style>
</head>
<body>
<h1>api.qa <small>/${esc(host)}</small></h1>
<p class="grade">${r.grade}</p>
<p>AX score <strong>${r.axScore.points}/10</strong> · ${r.mode} mode · ${r.attested ? 'attested (Ed25519)' : 'not attested — advisory'}<br>
<small>verified ${esc(r.verifiedAt)} · seed ${r.seed} · evidence <code>${r.discovery.evidenceDigest.slice(0, 16)}…</code></small></p>
<table><thead><tr><th>#</th><th>check</th><th>verdict</th></tr></thead><tbody>
${rows}
</tbody></table>
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
