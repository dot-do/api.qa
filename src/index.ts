/** api.qa — public module surface. */

export * from './types.js'
export { verifyTarget, rejudge, VERIFIER_VERSION, type VerifyTargetOpts } from './verify.js'
export {
  verifyPinnedSpec,
  parsePinnedSpec,
  validateRequirements,
  verifySuite,
  parseSuite,
  type PinnedReport,
  type VerifyPinnedOpts,
  type SuiteReport,
  type VerifySuiteOpts,
} from './pinned.js'
export {
  observeTarget,
  deriveDiscovery,
  digestBundle,
  parseAgentsJson,
  parseOpenapi,
  ROLE,
} from './discovery.js'
export { runChecks } from './checks.js'
export { axScoreOf, gradeOf } from './grade.js'
export {
  attestReport,
  verifyAttestation,
  generateSigningKey,
  importSigningKey,
  importSigningKeyPair,
  exportPrivateKey,
  reportBody,
} from './attest.js'
export { reportMarkdown, reportHtml, pinnedMarkdown, suiteMarkdown, dataDrivenMarkdown } from './render.js'
export {
  parseDataset,
  verifySuiteDataDriven,
  type DatasetRow,
  type DatasetFormat,
  type ParseDatasetOpts,
  type MatrixCell,
  type IterationResult,
  type DataDrivenReport,
  type VerifySuiteDataDrivenOpts,
} from './dataset.js'
export { Observer, normalizeTarget, type Fetcher, type ObserverOpts } from './http.js'
export { canonicalJson, sha256Hex, seededRandom, sampleSeeded } from './digest.js'
export { validateSchema, readPath } from './schema.js'
export { createApp, type App, type Env, type TickSummary } from './worker.js'
export {
  MonitorStore,
  parseIntervalSec,
  monitorId,
  DEFAULT_MAX_PER_TICK,
  RUN_HISTORY_CAP,
  type MonitorRecord,
  type MonitorRunRecord,
} from './monitors.js'
export * from './self.js'
