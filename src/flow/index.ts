/**
 * src/flow — DAG flow primitives (design: docs/design/flow-dag-formalization.md, TIN-1993).
 * 0.6.0 lane: core types, builder, plan projection, journal, fold. Flag-gated; nothing here
 * is wired into the legacy execution paths yet.
 */

export type { FlowStateSpec, JsonEncodableSpec, JsonValue, StateOf } from './state.js';
export type {
	BridgeBackend,
	LandingObservation,
	LandingOutcome,
	StationEvidence,
	StationId,
} from './station.js';
export {
	FUZZY_THRESHOLD,
	FuzzyMatchError,
	ServiceMatcher,
	ServiceMatcherLive,
	TOKEN_THRESHOLD,
	fuzzyConfidence,
	levenshtein,
	makeServiceMatcher,
	normalize,
	scoreLabel,
	tokenOverlap,
	type FuzzyMatcher,
	type FuzzyResolution,
	type FuzzyStrategy,
	type ServiceCandidate,
	type ServiceMatchQuery,
} from './fuzzy.js';
export type {
	FlowStep,
	FlowStepError,
	IdempotencyClass,
	StepMeta,
	StepOutcome,
	StepRunContext,
	StepTag,
} from './step.js';
export {
	canonicalJson,
	computePlanHash,
	validateFlowPlan,
	type FlowPlan,
	type FlowPlanNode,
	type RecoveryEdge,
} from './plan.js';
export {
	journalStepStatuses,
	renderFlowMermaid,
	type RenderFlowMermaidOptions,
} from './mermaid.js';
export {
	FlowValidationError,
	makeFlow,
	type Flow,
	type FlowBuilder,
	type FlowIdentity,
	type RecoveryChooser,
} from './flow.js';
export {
	FlowJournal,
	FlowJournalMemoryLive,
	JournalError,
	createInMemoryFlowJournal,
	createNoopFlowJournal,
	type CheckpointStatus,
	type FlowCheckpoint,
	type FlowJournalShape,
} from './journal.js';
export {
	DEFAULT_FLOW_JOURNAL_PURGE_INTERVAL_MS,
	DEFAULT_FLOW_JOURNAL_SAMPLE_RATE,
	DEFAULT_FLOW_JOURNAL_TTL_SECONDS,
	parseFlowJournalPurgeIntervalMs,
	parseFlowJournalSampleRate,
	parseFlowJournalTtlSeconds,
	shouldJournalReadFlow,
} from './journal-config.js';
export {
	DEFAULT_FLOW_JOURNAL_KEY_PREFIX,
	createRedisFlowJournal,
	type RedisFlowJournal,
	type RedisFlowJournalOptions,
} from './redis-journal.js';
export {
	FLOW_JOURNAL_SCHEMA_SQL,
	createPostgresFlowJournal,
	ensureFlowJournalSchema,
	purgeFlowCheckpoints,
	type PostgresFlowJournal,
	type PostgresFlowJournalOptions,
} from './postgres-journal.js';
export {
	FlowDivergedError,
	FlowRunError,
	runFlow,
	type FlowMetricsHook,
	type FlowStepLanding,
	type RunFlowOptions,
} from './run.js';
export {
	PiiRedactionAnnotationId,
	REDACTED_PLACEHOLDER,
	isRedacted,
	redactEncoded,
	redactable,
} from './redaction.js';
export type { FlowOutcome } from './outcome.js';
export { VendorFlowPack, type SelectorRegistry } from './vendor.js';
export {
	assertJsonEncodableSpec,
	jsonEncodableViolations,
	type SpecViolation,
} from './state-conformance.js';
