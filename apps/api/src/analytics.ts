import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  DefectCandidate, DefectOccurrence, GateDecision, ReleasePolicy, ReleasePolicyInput,
  RunMetrics, TestCaseDefinition, TestEnvironment,
} from "@agentx/shared";
import { HttpError } from "./http-error.js";

interface PolicyRow {
  id: string;
  version: number;
  name: string;
  environment: TestEnvironment;
  settings_json: string;
  created_at: string;
}

interface RunRow {
  id: string;
  status: string;
  dataset_id: string;
  snapshot_json: string;
  policy_json: string | null;
  counters_json: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

interface ResultRow {
  id: string;
  run_id: string;
  case_key: string;
  case_name: string;
  entity: string;
  operation: string;
  status: string;
  critical: number;
  pbi: string | null;
  input_record_id: string;
  scenario_id: string;
  summary: string;
  error: string | null;
  input_json: string;
  started_at: string;
  completed_at: string;
  duration_ms: number;
  correlation_id: string;
}

export interface ResultFilters {
  entity?: string;
  operation?: string;
  status?: string;
  caseId?: string;
  pbi?: string;
  search?: string;
}

function policyFromRow(row: PolicyRow): ReleasePolicy {
  const settings = JSON.parse(row.settings_json) as Omit<ReleasePolicyInput, "name" | "environment">;
  return { id: row.id, version: row.version, name: row.name, environment: row.environment, ...settings, createdAt: row.created_at };
}

export function listPolicies(database: Database.Database): ReleasePolicy[] {
  return (database.prepare(`
    SELECT p.* FROM release_policies p
    WHERE p.version = (SELECT MAX(v.version) FROM release_policies v WHERE v.id = p.id)
    ORDER BY p.environment, p.name
  `).all() as PolicyRow[]).map(policyFromRow);
}

export function getPolicy(database: Database.Database, id: string, environment?: TestEnvironment): ReleasePolicy {
  const row = database.prepare("SELECT * FROM release_policies WHERE id = ? ORDER BY version DESC LIMIT 1").get(id) as PolicyRow | undefined;
  if (!row) throw new HttpError(404, "POLICY_NOT_FOUND", `Policy ${id} was not found.`);
  const policy = policyFromRow(row);
  if (environment && policy.environment !== environment) {
    throw new HttpError(400, "POLICY_ENVIRONMENT_MISMATCH", "Policy environment must match the connection environment.");
  }
  return policy;
}

export function savePolicy(database: Database.Database, value: unknown, id?: string): ReleasePolicy {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, "INVALID_POLICY", "Policy must be a JSON object.");
  }
  const input = value as Record<string, unknown>;
  const allowed = ["name", "environment", "passThreshold", "minimumCoverage", "maxCriticalFailures", "allowErrors", "allowBlocked"];
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw new HttpError(400, "INVALID_POLICY", "Policy contains unsupported fields.");
  if (typeof input.name !== "string" || !input.name.trim() || input.name.trim().length > 100 ||
      typeof input.environment !== "string" || !["DEMO", "DEV", "QA", "UAT"].includes(input.environment) ||
      typeof input.passThreshold !== "number" || !Number.isFinite(input.passThreshold) || input.passThreshold < 0 || input.passThreshold > 100 ||
      typeof input.minimumCoverage !== "number" || !Number.isFinite(input.minimumCoverage) || input.minimumCoverage < 0 || input.minimumCoverage > 100 ||
      typeof input.maxCriticalFailures !== "number" || !Number.isInteger(input.maxCriticalFailures) || input.maxCriticalFailures < 0 ||
      typeof input.allowErrors !== "boolean" || typeof input.allowBlocked !== "boolean") {
    throw new HttpError(400, "INVALID_POLICY", "Provide a name, environment, percentage thresholds from 0 to 100, a nonnegative critical limit, and boolean error/blocked settings.");
  }
  const previous = id ? getPolicy(database, id) : undefined;
  if (previous && previous.environment !== input.environment) throw new HttpError(400, "POLICY_ENVIRONMENT_IMMUTABLE", "Create a new policy for a different environment.");
  const policy: ReleasePolicy = {
    id: id ?? randomUUID(),
    version: previous ? previous.version + 1 : 1,
    name: input.name.trim(),
    environment: input.environment as TestEnvironment,
    passThreshold: input.passThreshold,
    minimumCoverage: input.minimumCoverage,
    maxCriticalFailures: input.maxCriticalFailures,
    allowErrors: input.allowErrors,
    allowBlocked: input.allowBlocked,
    createdAt: new Date().toISOString(),
  };
  database.prepare("INSERT INTO release_policies (id, version, name, environment, settings_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(policy.id, policy.version, policy.name, policy.environment, JSON.stringify({
      passThreshold: policy.passThreshold, minimumCoverage: policy.minimumCoverage,
      maxCriticalFailures: policy.maxCriticalFailures, allowErrors: policy.allowErrors, allowBlocked: policy.allowBlocked,
    }), policy.createdAt);
  return policy;
}

function getRun(database: Database.Database, runId: string): RunRow {
  const row = database.prepare("SELECT * FROM test_runs WHERE id = ?").get(runId) as RunRow | undefined;
  if (!row) throw new HttpError(404, "RUN_NOT_FOUND", `Run ${runId} was not found.`);
  return row;
}

export function filteredResults(database: Database.Database, runId: string, filters: ResultFilters = {}): ResultRow[] {
  getRun(database, runId);
  const clauses = ["run_id = ?"];
  const args: string[] = [runId];
  for (const [field, column] of [["entity", "entity"], ["operation", "operation"], ["status", "status"], ["caseId", "case_key"], ["pbi", "pbi"]] as const) {
    if (filters[field]) {
      clauses.push(`${column} = ?`);
      args.push(filters[field]!);
    }
  }
  if (filters.search) {
    clauses.push("(input_record_id LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\' OR run_id LIKE ? ESCAPE '\\' OR case_key LIKE ? ESCAPE '\\' OR case_name LIKE ? ESCAPE '\\' OR entity LIKE ? ESCAPE '\\' OR input_json LIKE ? ESCAPE '\\' OR COALESCE(pbi, '') LIKE ? ESCAPE '\\')");
    const term = `%${filters.search.replace(/[\\%_]/g, "\\$&")}%`;
    args.push(term, term, term, term, term, term, term, term);
  }
  return database.prepare(`SELECT * FROM test_results WHERE ${clauses.join(" AND ")} ORDER BY started_at, rowid`).all(...args) as ResultRow[];
}

export function metricsForRun(database: Database.Database, runId: string, filters: ResultFilters = {}): RunMetrics {
  const run = getRun(database, runId);
  const results = filteredResults(database, runId, filters);
  const count = (status: string) => results.filter((result) => result.status === status).length;
  const passed = count("PASS");
  const failed = count("FAIL");
  const errors = count("ERROR");
  const blocked = count("BLOCKED");
  const cancelled = count("CANCELLED");
  const running = count("RUNNING");
  const executed = passed + failed + errors;
  const hasFilters = Object.values(filters).some(Boolean);
  const snapshotCounters = JSON.parse(run.counters_json) as { planned: number };
  const planned = hasFilters ? results.length : Math.max(results.length, snapshotCounters.planned);
  const end = run.completed_at ? Date.parse(run.completed_at) : Date.now();
  const start = run.started_at ? Date.parse(run.started_at) : Date.parse(run.created_at);
  return {
    planned, executed, passed, failed, errors, blocked, cancelled, running,
    criticalNonPass: results.filter((result) => result.critical === 1 && result.status !== "PASS").length,
    passRate: planned ? passed * 100 / planned : 0,
    coverage: planned ? executed * 100 / planned : 0,
    elapsedMs: Math.max(0, end - start),
  };
}

export function gateForRun(database: Database.Database, runId: string): GateDecision {
  const run = getRun(database, runId);
  const stored = database.prepare("SELECT * FROM gate_decisions WHERE run_id = ?").get(runId) as {
    decision: "GO" | "NO-GO"; reasons_json: string; metrics_json: string; policy_json: string | null; evaluated_at: string;
  } | undefined;
  if (stored) return {
    runId, decision: stored.decision, reasons: JSON.parse(stored.reasons_json) as string[],
    metrics: JSON.parse(stored.metrics_json) as RunMetrics,
    policy: stored.policy_json ? JSON.parse(stored.policy_json) as ReleasePolicy : null,
    evaluatedAt: stored.evaluated_at,
  };
  if (run.status === "QUEUED" || run.status === "RUNNING") {
    return { runId, decision: "PENDING", reasons: ["Run has not finished."], metrics: metricsForRun(database, runId),
      policy: run.policy_json ? JSON.parse(run.policy_json) as ReleasePolicy : null };
  }
  return finalizeGate(database, runId);
}

export function finalizeGate(database: Database.Database, runId: string): GateDecision {
  const run = getRun(database, runId);
  if (run.status === "QUEUED" || run.status === "RUNNING") return gateForRun(database, runId);
  const existing = database.prepare("SELECT 1 FROM gate_decisions WHERE run_id = ?").get(runId);
  if (existing) return gateForRun(database, runId);
  const policy = run.policy_json ? JSON.parse(run.policy_json) as ReleasePolicy : null;
  const metrics = metricsForRun(database, runId);
  const reasons: string[] = [];
  if (run.status !== "COMPLETED") reasons.push(`Run ended ${run.status}; only completed runs can be promoted.`);
  if (!metrics.planned) reasons.push("No tests were planned.");
  if (metrics.running || metrics.cancelled || metrics.passed + metrics.failed + metrics.errors + metrics.blocked + metrics.cancelled < metrics.planned) {
    reasons.push("Run has incomplete or cancelled tests.");
  }
  if (!policy) reasons.push("No release policy was captured for this run.");
  if (metrics.criticalNonPass) reasons.push(`${metrics.criticalNonPass} critical tests did not pass.`);
  if (policy) {
    if (metrics.passRate < policy.passThreshold) reasons.push(`Pass rate ${metrics.passRate.toFixed(2)}% is below ${policy.passThreshold}%.`);
    if (metrics.coverage < policy.minimumCoverage) reasons.push(`Coverage ${metrics.coverage.toFixed(2)}% is below ${policy.minimumCoverage}%.`);
    if (metrics.criticalNonPass > policy.maxCriticalFailures) reasons.push(`${metrics.criticalNonPass} critical non-PASS results exceed limit ${policy.maxCriticalFailures}.`);
    if (!policy.allowErrors && metrics.errors) reasons.push(`${metrics.errors} infrastructure/execution errors are disallowed.`);
    if (!policy.allowBlocked && metrics.blocked) reasons.push(`${metrics.blocked} blocked tests are disallowed.`);
  }
  const decision = reasons.length ? "NO-GO" : "GO";
  if (decision === "GO") reasons.push("All configured release checks passed.");
  const evaluatedAt = new Date().toISOString();
  database.transaction(() => {
    database.prepare("INSERT INTO gate_decisions (run_id, policy_json, decision, reasons_json, metrics_json, evaluated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(runId, run.policy_json, decision, JSON.stringify(reasons), JSON.stringify(metrics), evaluatedAt);
    if (decision === "NO-GO") localWorkItems.recordFailures(database, run);
  })();
  return { runId, decision, reasons, metrics, policy, evaluatedAt };
}

export interface WorkItemProvider {
  recordFailures(database: Database.Database, run: RunRow): void;
  list(database: Database.Database): DefectCandidate[];
}

function createDefects(database: Database.Database, run: RunRow): void {
  const snapshot = JSON.parse(run.snapshot_json) as { connection: { environment: TestEnvironment }; suite: { id: string; cases: TestCaseDefinition[] } };
  const results = filteredResults(database, run.id).filter((result) => result.status === "FAIL" || result.status === "ERROR");
  for (const result of results) {
    const steps = database.prepare("SELECT * FROM test_step_results WHERE result_id = ? ORDER BY rowid").all(result.id) as Array<{
      step_key: string; method: string; url: string; request_json: string | null; response_status: number | null;
      response_json: string | null; assertions_json: string; error: string | null; correlation_id: string;
    }>;
    const step = steps.at(-1);
    const assertions = step ? JSON.parse(step.assertions_json) as Array<{ path: string; operator: string; passed: boolean }> : [];
    const failed = assertions.find((assertion) => !assertion.passed);
    const category = result.status === "ERROR" ? "infrastructure" : failed ? "assertion" : "response";
    const definition = snapshot.suite.cases.find((item) => item.id === result.case_key)?.steps.find((item) => item.id === step?.step_key);
    const signature = createHash("sha256").update(JSON.stringify([
      snapshot.suite.id, result.case_key, step?.method, definition?.path ?? step?.step_key,
      category, failed ? `${failed.path}:${failed.operator}` : step?.error?.replace(/\d+/g, "#") ?? "status",
      snapshot.connection.environment,
    ])).digest("hex");
    const now = new Date().toISOString();
    const id = randomUUID();
    database.prepare(`
      INSERT INTO defect_candidates (id, signature, title, severity, environment, case_key, pbi, category, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(signature) DO UPDATE SET updated_at = excluded.updated_at
    `).run(id, signature, `${result.case_name}: ${category} failure`, result.critical ? "critical" : "normal",
      snapshot.connection.environment, result.case_key, result.pbi, category, now, now);
    const defect = database.prepare("SELECT id FROM defect_candidates WHERE signature = ?").get(signature) as { id: string };
    const evidence = {
      summary: result.summary, scenarioId: result.scenario_id, input: JSON.parse(result.input_json) as unknown,
      stepsToReproduce: `Run suite ${snapshot.suite.id}, case ${result.case_key} with record ${result.input_record_id}.`,
      method: step?.method, endpoint: step?.url, expectedStatuses: definition?.expectedStatuses,
      actualStatus: step?.response_status, assertions, request: step?.request_json ? JSON.parse(step.request_json) as unknown : undefined,
      response: step?.response_json ? JSON.parse(step.response_json) as unknown : undefined,
      error: step?.error ?? result.error, correlationId: step?.correlation_id ?? result.correlation_id,
    };
    database.prepare(`
      INSERT OR IGNORE INTO defect_occurrences (id, defect_id, result_id, run_id, record_id, evidence_json, observed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), defect.id, result.id, run.id, result.input_record_id, JSON.stringify(evidence), now);
  }
}

export function listDefects(database: Database.Database): DefectCandidate[] {
  const defects = database.prepare("SELECT * FROM defect_candidates ORDER BY updated_at DESC").all() as Array<{
    id: string; signature: string; title: string; severity: string; environment: TestEnvironment; case_key: string;
    pbi: string | null; category: DefectCandidate["category"]; created_at: string; updated_at: string;
  }>;
  return defects.map((defect) => {
    const occurrences = database.prepare("SELECT * FROM defect_occurrences WHERE defect_id = ? ORDER BY observed_at").all(defect.id) as Array<{
      result_id: string; run_id: string; record_id: string; evidence_json: string; observed_at: string;
    }>;
    return {
      id: defect.id, signature: defect.signature, title: defect.title, severity: defect.severity, environment: defect.environment,
      caseId: defect.case_key, ...(defect.pbi ? { pbi: defect.pbi } : {}), category: defect.category,
      createdAt: defect.created_at, updatedAt: defect.updated_at,
      occurrences: occurrences.map((occurrence): DefectOccurrence => ({
        resultId: occurrence.result_id, runId: occurrence.run_id, recordId: occurrence.record_id,
        evidence: JSON.parse(occurrence.evidence_json) as unknown, observedAt: occurrence.observed_at,
      })),
    };
  });
}

export const localWorkItems: WorkItemProvider = {
  recordFailures: createDefects,
  list: listDefects,
};
