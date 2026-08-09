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
  type ObserveTargetOpts,
  type TestSuiteClaim,
} from './discovery.js'
// ── The `api.qa/vitest@1` executable dialect (AXP A.8.6) ────────────────────
// The SHARED subset harness + the runner seam are public: the CLI's local
// verb, a property's own CI, and the hosted verifier all run the ONE
// implementation (A.8.6.2's normative parity), and adopters need the gates
// and caps to publish artifacts that will verify.
export {
  VITEST_RUNNER,
  EXEC_WALL_MS,
  EXEC_CPU_MS,
  EXEC_MAX_COMBINED,
  EXEC_MAX_DOC_BYTES,
  EXEC_MAX_MODULE_BYTES,
  EXEC_MAX_OUTPUT_BYTES,
  isFloorBlockedHost,
  createGatedFetch,
  validateDialectSource,
  localExecRunner,
  loadHarnessModule,
  foldRunOutcome,
  type ExecRunRequest,
  type ExecRunOutcome,
  type ExecRunIo,
  type ExecSuiteRunner,
  type ExecTestResult,
  type GateViolation,
} from './exec/dialect.js'
export {
  workerLoaderExecRunner,
  unavailableExecRunner,
  buildWorkerCode,
  entrySource,
  gatewayFetch,
  createOutboundGateway,
  HARNESS_VERSION,
  EXEC_COMPATIBILITY_DATE,
  GATEWAY_MARKER_HEADER,
  GATEWAY_RECORD_UNREADABLE,
  RUNNER_UNAVAILABLE_NO_BINDING,
  RUNNER_UNAVAILABLE_NO_OUTBOUND,
  type OutboundGatewayLike,
  type WorkerLoaderLike,
  type WorkerCodeLike,
} from './exec/runner.js'
export { VITEST_SUBSET_SOURCE } from './exec/vitest-subset-source.js'
export {
  gateVitestSuiteCard,
  gateVitestSuiteDocument,
  gateVitestModuleArtifact,
  NATIVE_SERVING_BASE,
  SUITE_ROW_MAX_BODY_BYTES,
  type VitestCardGate,
  type VitestDocumentGate,
  type VitestModuleGate,
} from './test-suite.js'
export { parseExecSuiteDocument } from './suite-doc.js'
export { AXP_PINNED_SPEC } from './pinned.js'
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
