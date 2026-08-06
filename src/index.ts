/** api.qa — public module surface. */

export * from './types.js'
export { verifyTarget, rejudge, VERIFIER_VERSION, type VerifyTargetOpts } from './verify.js'
export {
  grade,
  gradePinned,
  type GradeTarget,
  type GradeOpts,
  type GradePinnedOpts,
  type FetchHandler,
  type FetchHandlerFn,
} from './local.js'
export {
  verifyPinnedSpec,
  parsePinnedSpec,
  validateRequirements,
  verifySuite,
  parseSuite,
  readCardDeclaration,
  type PinnedReport,
  type VerifyPinnedOpts,
  type SuiteReport,
  type VerifySuiteOpts,
  type CardDeclarationState,
} from './pinned.js'
// The optional-declared-interface registry is PUBLIC on purpose: a spec author
// needs to know which checks may be declaration-armed BEFORE writing a spec
// that throws, and an auditor needs to be able to read the closed list without
// reading the source. Exporting it does not widen it — it is frozen.
export {
  OPTIONAL_DECLARED_INTERFACES,
  OPTIONAL_INTERFACE_PATH_RE,
  eligibleOptionalChecks,
} from './optional-interfaces.js'
export {
  observeTarget,
  deriveDiscovery,
  digestBundle,
  parseAgentsJson,
  parseOpenapi,
  ROLE,
} from './discovery.js'
export { runChecks } from './checks.js'
export { contractDiff, enumerateOperations } from './contract.js'
export { axScoreOf, gradeOf } from './grade.js'
export {
  runEstateGate,
  formatScoreboard,
  type GateEntry,
  type GateRow,
  type GateResult,
} from './gate.js'
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
