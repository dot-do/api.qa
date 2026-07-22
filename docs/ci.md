# Running api.qa in CI (Newman parity)

`npx autonomous-qa` is a first-class CI citizen: a pinned reusable suite gates a
pipeline exactly the way Newman gates one — a **non-zero exit** on any failure,
plus **machine-readable reports** (JUnit XML + JSON) a CI system can parse and
render.

## The one property that matters: exit codes

A gate that exits `0` on a failure is a **silent green** — the worst possible
defect, because the pipeline goes green while the contract is broken. So:

| mode | command | exits non-zero when |
| --- | --- | --- |
| pinned spec | `autonomous-qa verify <target> --spec <file>` | any requirement fails, the digest pin mismatches, or the target is unreachable/refused |
| reusable suite | `autonomous-qa suite <file> --env <name>` | any probe fails (same digest / reachability rules) |
| data-driven | `autonomous-qa suite <file> --env <name> --iteration-data <dataset>` | **any** iteration fails (including an SSRF-refused row) |

Exit `0` happens **only** when everything passed. A digest-pin mismatch or an
unreachable target throws before a report exists; the CLI turns that into a
non-zero exit too. Reporting never masks a failure — the exit code is computed
from the run result independently of which reporters ran.

> **ONLY `verify` / `suite` / `suite --iteration-data` are safe to gate CI on.**
> The bare `autonomous-qa <target>` command is **advisory grade mode** — it
> exits `0` for **any** grade A through D, even with failing checks, and only
> exits non-zero on grade **F**. It exists to show *how close* a target is to
> agent-first, not to pass/fail a pipeline. Gating CI on the bare grade command
> is a silent-green footgun: a target can regress from A to D — real checks
> failing along the way — and the job stays green. The CLI prints a stderr
> warning every time the bare grade command runs, for exactly this reason. If
> you want a CI gate, pin a spec or suite and use `verify`/`suite` instead.

## Reporters

Pick one or more reporters, Newman-style. `--reporter` is repeatable and
comma-splittable.

```sh
autonomous-qa suite examples/golden-scenario.suite.json --env prod \
  --target https://your.api \
  --expect-digest <pin> \
  --reporter cli \
  --reporter junit --reporter-junit-out reports/api-qa.junit.xml \
  --reporter json  --reporter-json-out  reports/api-qa.json
```

- **`cli`** — the human/markdown output (the default when no `--reporter` is
  given), written to stdout.
- **`junit`** — a valid JUnit XML (`testsuites` / `testsuite` / `testcase` with
  `<failure>` / `<error>` / `<skipped>`). Each requirement/probe — and each
  data-driven **iteration × probe** — is one `<testcase>`; `failures`/`errors`
  counts are exact; names and details are XML-escaped. GitHub and GitLab parse
  this natively.
- **`json`** — a stable structured report (`$report: "api.qa.ci-run"`,
  `schemaVersion: 1`): target, verdict, per-probe pass/fail + detail + timing,
  and the pinned digest.

Output paths:

- `--reporter-junit-out <path>` / `--reporter-json-out <path>` — per-reporter.
- `--reporter-out <path>` — a shared fallback (only valid when a single file
  reporter is selected; using it with two file reporters is refused so one file
  can't clobber the other).
- A file reporter with no path writes to stdout.

## GitHub Actions

A working, copy-pasteable workflow lives at
[`.github/workflows/api-qa-example.yml`](../.github/workflows/api-qa-example.yml).
It:

1. checks out the repo and installs Node,
2. runs the **pinned** suite against `${{ vars.API_QA_TARGET }}` with
   `--expect-digest ${{ vars.API_QA_SUITE_DIGEST }}` — so a regression makes the
   step exit non-zero and the check goes **red**,
3. uploads the JUnit + JSON reports as artifacts on every run (`if: always()`),
   so failure detail survives a red gate,
4. publishes the JUnit XML as a test report.

Set two repository/environment variables:

- `API_QA_TARGET` — the deployed URL to verify.
- `API_QA_SUITE_DIGEST` — the ratified suite pin. Mint it once and re-mint only
  when you intentionally change what passing means:

  ```sh
  npx autonomous-qa spec-digest examples/golden-scenario.suite.json
  ```

## The estate gate — one scoreboard for a SET of surfaces

`autonomous-qa gate --estate <config.json>` runs the pinned gate across a whole
**estate** of surfaces and turns the set into **one** pass/fail plus a
scoreboard (`surface | target | grade | score | pinned spec | required`). It
reuses `gradePinned()` per entry — the same verdict the deployed api.qa returns
for a pinned contract — and **exits non-zero iff any REQUIRED surface fails its
pinned spec or errors**. Non-required entries are advisory-only and never change
the exit code; an entry with no `spec` reports its AX letter grade but cannot
fail the gate.

```jsonc
// examples/ax-estate.json
{
  "entries": [
    { "surface": "apis.ax", "target": "https://apis.ax",
      "spec": "ax/apis-ax-standard.spec.json",
      "expectDigest": "<sha256>", "required": true },
    { "surface": "api.qa", "target": "https://api.qa", "required": false }
  ]
}
```

```sh
node dist/cli/index.js gate --estate examples/ax-estate.json   # exits 1 if any required surface fails
```

`expectDigest` pins the spec text (anti-Goodhart): a silently-edited spec can
never make the gate pass. A shipped GitHub Actions workflow that runs exactly
this lives at
[`.github/workflows/ax-estate-gate.yml`](../.github/workflows/ax-estate-gate.yml).

### Pre-deploy (surfaces you can't reach by public URL)

A surface that is not publicly gradable (page.ax is `522`, apps.ax is `403`) is
graded **before deploy** — never faked. Two equivalent plug-ins:

- **In-process**, no server at all — grade the Worker's `{ fetch }` handler in
  memory with the `toConform` vitest matcher or `runEstateGate()` programmatically
  (each probe is dispatched to the handler in memory; `allowPrivate` stays false):

  ```ts
  import worker from '../src/worker.js'
  import spec from '../../examples/ax/ax-hi2-page-ax.spec.json?raw'
  it('page.ax conforms pre-deploy', async () => {
    await expect(worker).toConform(spec)
  })
  ```

- **Local dev server** — stand up `wrangler dev`, then gate the localhost URL
  with the per-entry `allowPrivate` opt-in (local-only; a remote target can never
  flip it on — the SSRF invariant):

  ```sh
  # page.ax: wrangler dev --port 8787 --var STRIPE_STUB:1  (then, from api.qa:)
  node dist/cli/index.js gate --estate examples/ax-estate.local.json
  ```

## GitLab CI

The same shape works on GitLab — the exit code fails the job, and the JUnit XML
feeds the merge-request test widget:

```yaml
api-qa:
  image: node:20
  script:
    - npx --yes autonomous-qa suite examples/golden-scenario.suite.json
        --env prod --target "$API_QA_TARGET" --expect-digest "$API_QA_SUITE_DIGEST"
        --reporter junit --reporter-junit-out reports/api-qa.junit.xml
  artifacts:
    when: always
    paths: [reports/]
    reports:
      junit: reports/api-qa.junit.xml
```
