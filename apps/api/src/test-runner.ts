import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type Database from "better-sqlite3";
import { Ajv, type AnySchema } from "ajv";
import type {
  AssertionResult,
  DatasetManifest,
  JsonPathAssertion,
  SystemConnection,
  TestCaseDefinition,
  TestEnvironment,
  TestHttpMethod,
  TestOperation,
  TestPriority,
  TestResult,
  TestRun,
  TestRunCounters,
  TestRunInput,
  TestStep,
  TestStepResult,
  TestSuite,
  TestVerdict,
} from "@agentx/shared";
import { DatasetService } from "./dataset-service.js";
import { finalizeGate, getPolicy } from "./analytics.js";
import { HttpError } from "./http-error.js";
import {
  buildRequestUrl,
  connectionFromRow,
  getJsonPath,
  redact,
  redactUrl,
  resolveAuthHeaders,
  resolveTemplate,
  topologicalCases,
  validateMockBaseUrl,
} from "./test-safety.js";

interface ConnectionRow {
  id: string;
  name: string;
  system_type: string;
  environment: TestEnvironment;
  base_url: string;
  auth_type: SystemConnection["authType"];
  secret_ref: string | null;
  headers_json: string;
  timeout_ms: number;
  max_concurrency: number;
  enabled: number;
  created_at: string;
  updated_at: string;
}

interface RunRow {
  id: string;
  suite_id: string;
  suite_version_id: string;
  connection_id: string;
  dataset_id: string;
  status: TestRun["status"];
  snapshot_json: string;
  counters_json: string;
  namespace: string;
  cancel_requested: number;
  error: string | null;
  log_error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

interface StoredFixture {
  recordId: string;
  entity: string;
  scenarioId: string;
  expectedValid: boolean;
  payload: Record<string, unknown>;
}

interface CaseExecution {
  status: TestVerdict;
  steps: Record<string, Record<string, unknown>>;
}

interface RunSnapshot {
  suite: TestSuite;
  connection: SystemConnection;
  dataset: DatasetManifest;
  regressionEnabled?: boolean;
}

interface RunPlanItem {
  testCase: TestCaseDefinition;
  fixture?: StoredFixture;
}

interface RunServiceOptions {
  logDirectory?: string;
  fetchImpl?: typeof fetch;
  maximumConcurrentRuns?: number;
}

interface ResponseRead {
  body: unknown;
  truncated: boolean;
}

interface StepExecution {
  result: Omit<TestStepResult, "id">;
  verdict: TestVerdict;
  extracted: Record<string, unknown>;
  logEvent: Record<string, unknown>;
}

const maxPlannedTests = 2_000;
const maxResponseBytes = 64 * 1024;
const maxRequestBytes = 64 * 1024;
const maxRunNamespaceLength = 100;
const defaultLogDirectory = resolve(process.cwd(), "storage/logs");

function resolveLogDirectory(): string {
  const configured = process.env.AGENTX_LOG_DIR;
  if (!configured) return defaultLogDirectory;
  return isAbsolute(configured) ? configured : resolve(process.cwd(), configured);
}

export class TestRunService {
  private readonly logDirectory: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maximumConcurrentRuns: number;
  private readonly queue: string[] = [];
  private readonly activeControllers = new Map<string, Set<AbortController>>();
  private activeRunCount = 0;

  constructor(
    private readonly database: Database.Database,
    private readonly datasetService: DatasetService,
    options: RunServiceOptions = {},
  ) {
    this.logDirectory = options.logDirectory ?? resolveLogDirectory();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maximumConcurrentRuns = options.maximumConcurrentRuns ?? 2;
  }

  create(input: TestRunInput, localPort: number): TestRun {
    const suiteRow = this.database.prepare(`
      SELECT s.id, s.name, s.current_version, s.created_at, s.updated_at, v.id AS version_id, v.cases_json
      FROM test_suites s
      JOIN test_suite_versions v ON v.suite_id = s.id AND v.version = s.current_version
      WHERE s.id = ?
    `).get(input.suiteId) as {
      id: string;
      name: string;
      current_version: number;
      created_at: string;
      updated_at: string;
      version_id: string;
      cases_json: string;
    } | undefined;
    if (!suiteRow) throw new HttpError(404, "TEST_SUITE_NOT_FOUND", `Test suite ${input.suiteId} was not found.`);

    const connectionRow = this.database.prepare("SELECT * FROM connections WHERE id = ?").get(input.connectionId) as ConnectionRow | undefined;
    if (!connectionRow) throw new HttpError(404, "CONNECTION_NOT_FOUND", `Connection ${input.connectionId} was not found.`);
    const connection = connectionFromRow(connectionRow);
    if (!connection.enabled) throw new HttpError(409, "CONNECTION_DISABLED", `Connection ${connection.name} is disabled.`);
    validateMockBaseUrl(connection.baseUrl, localPort);
    const policy = getPolicy(this.database, input.policyId ?? `default-${connection.environment.toLowerCase()}`, connection.environment);

    const dataset = this.datasetService.getManifest(input.datasetId);
    if (dataset.status !== "READY") throw new HttpError(409, "DATASET_NOT_READY", "Only READY datasets can be executed.");
    const cases = JSON.parse(suiteRow.cases_json) as TestCaseDefinition[];
    const suite: TestSuite = {
      id: suiteRow.id,
      version: suiteRow.current_version,
      versionId: suiteRow.version_id,
      name: suiteRow.name,
      cases,
      createdAt: suiteRow.created_at,
      updatedAt: suiteRow.updated_at,
    };
    const fixtures = this.loadFixtures(input.datasetId);
    const plan = createRunPlan(cases, fixtures);
    if (plan.length > maxPlannedTests) {
      throw new HttpError(400, "RUN_PLAN_TOO_LARGE", `A run may include at most ${maxPlannedTests} logical test instances.`);
    }
    const payloadBytes = plan.reduce((total, item) => total + (item.fixture ? Buffer.byteLength(JSON.stringify(item.fixture.payload), "utf8") : 0), 0);
    if (payloadBytes > 16 * 1024 * 1024) {
      throw new HttpError(413, "RUN_INPUT_TOO_LARGE", "Selected synthetic input records exceed the 16 MB run limit.");
    }

    const runId = randomUUID();
    const namespace = `run-${runId.slice(0, 12)}`;
    if (namespace.length > maxRunNamespaceLength) throw new Error("Generated run namespace exceeds its configured length.");
    const createdAt = new Date().toISOString();
    const counters: TestRunCounters = {
      planned: plan.length,
      executed: 0,
      passed: 0,
      failed: 0,
      errors: 0,
      blocked: 0,
      cancelled: 0,
    };
    const snapshot: RunSnapshot = {
      suite,
      connection,
      dataset,
      regressionEnabled: (this.database.prepare("SELECT value FROM demo_settings WHERE key = 'regression'").get() as { value: string }).value === "true",
    };
    mkdirSync(this.logDirectory, { recursive: true });
    writeFileSync(this.logPath(runId), "", { encoding: "utf8", flag: "wx" });
    const insert = this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO test_runs (
          id, suite_id, suite_version_id, connection_id, dataset_id, status,
          snapshot_json, counters_json, namespace, created_at, policy_json
        ) VALUES (?, ?, ?, ?, ?, 'QUEUED', ?, ?, ?, ?, ?)
      `).run(
        runId,
        suite.id,
        suite.versionId,
        connection.id,
        dataset.id,
        JSON.stringify(redact(snapshot)),
        JSON.stringify(counters),
        namespace,
        createdAt,
        JSON.stringify(policy),
      );
    });
    insert();
    this.appendLog(runId, {
      event: "run-queued",
      runId,
      timestamp: createdAt,
      suiteId: suite.id,
      suiteVersion: suite.version,
      datasetId: dataset.id,
      planned: counters.planned,
      connectionId: connection.id,
    });
    setImmediate(() => this.enqueue(runId));
    return {
      id: runId,
      status: "QUEUED",
      suiteId: suite.id,
      suiteVersion: suite.version,
      suiteName: suite.name,
      connectionId: connection.id,
      connectionName: connection.name,
      datasetId: dataset.id,
      datasetName: dataset.name,
      namespace,
      counters,
      createdAt,
    };
  }

  list(): TestRun[] {
    const rows = this.database.prepare("SELECT * FROM test_runs ORDER BY created_at DESC LIMIT 100").all() as RunRow[];
    return rows.map((row) => this.toRun(row));
  }

  get(runId: string): TestRun {
    const row = this.getRunRow(runId);
    return this.toRun(row);
  }

  cancel(runId: string): TestRun {
    const row = this.getRunRow(runId);
    if (row.status !== "QUEUED" && row.status !== "RUNNING") {
      throw new HttpError(409, "RUN_NOT_CANCELLABLE", `Run ${runId} is already ${row.status.toLowerCase()}.`);
    }
    this.database.prepare("UPDATE test_runs SET cancel_requested = 1 WHERE id = ?").run(runId);
    const controllers = this.activeControllers.get(runId);
    if (controllers) {
      for (const controller of controllers) controller.abort("Cancelled by user.");
    }
    this.appendLog(runId, { event: "cancel-requested", runId, timestamp: new Date().toISOString() });
    return this.get(runId);
  }

  results(runId: string): TestResult[] {
    this.getRunRow(runId);
    const rows = this.database.prepare(`
      SELECT * FROM test_results WHERE run_id = ? ORDER BY started_at, case_key, input_record_id
    `).all(runId) as Array<{
      id: string;
      run_id: string;
      case_key: string;
      case_name: string;
      operation: TestOperation;
      entity: string;
      priority: TestPriority;
      critical: number;
      expected_outcome: "positive" | "negative";
      input_record_id: string;
      scenario_id: string;
      status: TestResult["status"];
      summary: string;
      error: string | null;
      pbi: string | null;
      correlation_id: string;
      started_at: string;
      completed_at: string;
      duration_ms: number;
    }>;
    const resultIds = rows.map((row) => row.id);
    const stepRows = resultIds.length === 0 ? [] : this.database.prepare(`
      SELECT * FROM test_step_results WHERE result_id IN (${resultIds.map(() => "?").join(",")})
      ORDER BY created_at, id
    `).all(...resultIds) as Array<{
      id: string;
      result_id: string;
      step_key: string;
      step_name: string;
      method: TestHttpMethod;
      url: string;
      request_json: string | null;
      response_status: number | null;
      response_json: string | null;
      response_truncated: number;
      latency_ms: number | null;
      assertions_json: string;
      error: string | null;
      correlation_id: string;
      created_at: string;
    }>;
    const stepsByResult = new Map<string, TestStepResult[]>();
    for (const row of stepRows) {
      const step: TestStepResult = {
        id: row.id,
        stepId: row.step_key,
        name: row.step_name,
        method: row.method,
        url: row.url,
        ...(row.request_json === null ? {} : { requestBody: JSON.parse(row.request_json) as unknown }),
        ...(row.response_status === null ? {} : { responseStatus: row.response_status }),
        ...(row.response_json === null ? {} : { responseBody: JSON.parse(row.response_json) as unknown }),
        responseTruncated: row.response_truncated === 1,
        ...(row.latency_ms === null ? {} : { latencyMs: row.latency_ms }),
        assertions: JSON.parse(row.assertions_json) as AssertionResult[],
        ...(row.error === null ? {} : { error: row.error }),
        correlationId: row.correlation_id,
        createdAt: row.created_at,
      };
      const steps = stepsByResult.get(row.result_id) ?? [];
      steps.push(step);
      stepsByResult.set(row.result_id, steps);
    }
    return rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      caseId: row.case_key,
      caseName: row.case_name,
      operation: row.operation,
      entity: row.entity,
      priority: row.priority,
      critical: row.critical === 1,
      expectedOutcome: row.expected_outcome,
      inputRecordId: row.input_record_id,
      scenarioId: row.scenario_id,
      status: row.status,
      summary: row.summary,
      ...(row.error ? { error: row.error } : {}),
      ...(row.pbi ? { pbi: row.pbi } : {}),
      startedAt: row.started_at,
      completedAt: row.completed_at,
      durationMs: row.duration_ms,
      steps: stepsByResult.get(row.id) ?? [],
    }));
  }

  result(resultId: string): TestResult {
    if (!/^[0-9a-f-]{36}$/i.test(resultId)) throw new HttpError(400, "INVALID_RESULT_ID", "Result ID must be a UUID.");
    const row = this.database.prepare("SELECT run_id FROM test_results WHERE id = ?").get(resultId) as
      { run_id: string } | undefined;
    if (!row) throw new HttpError(404, "TEST_RESULT_NOT_FOUND", `Result ${resultId} was not found.`);
    const result = this.results(row.run_id).find((item) => item.id === resultId);
    if (!result) throw new HttpError(404, "TEST_RESULT_NOT_FOUND", `Result ${resultId} was not found.`);
    return result;
  }

  logFile(runId: string): string {
    this.getRunRow(runId);
    const path = this.logPath(runId);
    if (!existsSync(path)) throw new HttpError(404, "RUN_LOG_NOT_FOUND", `JSONL log for run ${runId} is unavailable.`);
    return path;
  }

  recoverInterruptedRuns(): void {
    const rows = this.database.prepare(`
      SELECT id FROM test_runs WHERE status IN ('QUEUED', 'RUNNING')
    `).all() as Array<{ id: string }>;
    const now = new Date().toISOString();
    for (const { id } of rows) {
      try {
        this.appendLog(id, { event: "run-recovered-as-error", runId: id, timestamp: now });
      } catch (error) {
        this.database.prepare("UPDATE test_runs SET log_error = ? WHERE id = ?")
          .run(errorMessage(error), id);
      }
      try {
        this.finishUnfinished(id, "ERROR", "API process restarted during execution.");
      } catch (error) {
        this.database.prepare(`
          UPDATE test_runs SET status = 'ERROR', error = ?, completed_at = ?
          WHERE id = ? AND status IN ('QUEUED', 'RUNNING')
        `).run(errorMessage(error), new Date().toISOString(), id);
      }
    }
    const missingDecisions = this.database.prepare(`
      SELECT id FROM test_runs WHERE status NOT IN ('QUEUED', 'RUNNING')
        AND NOT EXISTS (SELECT 1 FROM gate_decisions WHERE run_id = test_runs.id)
    `).all() as Array<{ id: string }>;
    for (const { id } of missingDecisions) finalizeGate(this.database, id);
  }

  private enqueue(runId: string): void {
    this.queue.push(runId);
    this.pumpQueue();
  }

  private pumpQueue(): void {
    while (this.activeRunCount < this.maximumConcurrentRuns && this.queue.length > 0) {
      const runId = this.queue.shift();
      if (!runId) continue;
      this.activeRunCount += 1;
      void this.executeRun(runId).finally(() => {
        this.activeRunCount -= 1;
        this.pumpQueue();
      });
    }
  }

  private async executeRun(runId: string): Promise<void> {
    let fatalError: string | undefined;
    try {
      const row = this.getRunRow(runId);
      if (row.cancel_requested === 1) {
        await this.completeUnstartedRun(row, "CANCELLED", "Run cancelled before execution started.");
        return;
      }
      this.database.prepare("UPDATE test_runs SET status = 'RUNNING', started_at = ? WHERE id = ? AND status = 'QUEUED'")
        .run(new Date().toISOString(), runId);
      const runningRow = this.getRunRow(runId);
      const snapshot = JSON.parse(runningRow.snapshot_json) as RunSnapshot;
      const fixtures = this.loadFixtures(runningRow.dataset_id);
      const plan = createRunPlan(snapshot.suite.cases, fixtures);
      const orderedCases = topologicalCases(snapshot.suite.cases);
      const caseContexts = new Map<string, CaseExecution>();
      const casesById = new Map(orderedCases.map((testCase) => [testCase.id, testCase]));
      this.appendLog(runId, {
        event: "run-started",
        runId,
        timestamp: runningRow.started_at,
        planned: plan.length,
        maxConcurrency: snapshot.connection.maxConcurrency,
      });

      for (const testCase of orderedCases) {
        const instances = plan.filter((item) => item.testCase.id === testCase.id);
        await this.runCaseBatch(runId, snapshot, testCase, instances, caseContexts, casesById);
      }
    } catch (error) {
      fatalError = errorMessage(error);
      try {
        this.appendLog(runId, { event: "run-fatal-error", runId, timestamp: new Date().toISOString(), error: fatalError });
      } catch (logError) {
        this.database.prepare("UPDATE test_runs SET log_error = ? WHERE id = ?")
          .run(errorMessage(logError), runId);
      }
    } finally {
      this.activeControllers.delete(runId);
      try {
        const finalRow = this.getRunRow(runId);
        if (finalRow.status !== "QUEUED" && finalRow.status !== "RUNNING") return;
        if (fatalError) {
          this.finishUnfinished(runId, "ERROR", fatalError);
        } else {
          const cancelled = finalRow.cancel_requested === 1;
          this.finishUnfinished(runId, cancelled ? "CANCELLED" : "COMPLETED", cancelled ? "Run cancelled by user." : undefined);
        }
      } catch (error) {
        this.database.prepare("UPDATE test_runs SET status = 'ERROR', error = ?, completed_at = ? WHERE id = ?")
          .run(errorMessage(error), new Date().toISOString(), runId);
      }
    }
  }

  private async runCaseBatch(
    runId: string,
    snapshot: RunSnapshot,
    testCase: TestCaseDefinition,
    instances: RunPlanItem[],
    caseContexts: Map<string, CaseExecution>,
    casesById: Map<string, TestCaseDefinition>,
  ): Promise<void> {
    let nextIndex = 0;
    const workerCount = Math.min(snapshot.connection.maxConcurrency, instances.length || 1);
    const workers = Array.from({ length: workerCount }, async () => {
      while (nextIndex < instances.length) {
        if (this.isCancelRequested(runId)) break;
        const item = instances[nextIndex];
        nextIndex += 1;
        const execution = await this.executeCase(runId, snapshot, testCase, item, caseContexts, casesById);
        caseContexts.set(contextKey(testCase.id, item.fixture?.recordId ?? `missing:${testCase.id}`), execution);
      }
    });
    await Promise.all(workers);
    if (this.isCancelRequested(runId)) {
      for (; nextIndex < instances.length; nextIndex += 1) {
        const item = instances[nextIndex];
        const execution = await this.persistTerminalResult(
          runId,
          snapshot,
          testCase,
          item,
          "CANCELLED",
          "Run cancelled before this test started.",
        );
        caseContexts.set(contextKey(testCase.id, item.fixture?.recordId ?? `missing:${testCase.id}`), execution);
      }
    }
    if (instances.length === 0 && !this.isCancelRequested(runId)) {
      const item = { testCase };
      const execution = await this.persistTerminalResult(
        runId,
        snapshot,
        testCase,
        item,
        "BLOCKED",
        `No ${testCase.entity} records matched this case selector in the selected dataset.`,
      );
      caseContexts.set(contextKey(testCase.id, `missing:${testCase.id}`), execution);
    }
  }

  private async executeCase(
    runId: string,
    snapshot: RunSnapshot,
    testCase: TestCaseDefinition,
    item: RunPlanItem,
    caseContexts: Map<string, CaseExecution>,
    casesById: Map<string, TestCaseDefinition>,
  ): Promise<CaseExecution> {
    const fixtureKey = item.fixture?.recordId ?? `missing:${testCase.id}`;
    if (!item.fixture) {
      return this.persistTerminalResult(
        runId,
        snapshot,
        testCase,
        item,
        "BLOCKED",
        `No ${testCase.entity} records matched this case selector in the selected dataset.`,
      );
    }
    if (this.isCancelRequested(runId)) {
      return this.persistTerminalResult(runId, snapshot, testCase, item, "CANCELLED", "Run cancelled before this test started.");
    }
    const dependencies: Record<string, unknown> = {};
    for (const dependencyId of testCase.dependsOn) {
      const dependency = caseContexts.get(contextKey(dependencyId, fixtureKey));
      if (!dependency || dependency.status !== "PASS") {
        const dependencyName = casesById.get(dependencyId)?.name ?? dependencyId;
        return this.persistTerminalResult(
          runId,
          snapshot,
          testCase,
          item,
          "BLOCKED",
          `Prerequisite ${dependencyName} did not PASS for input record ${fixtureKey}.`,
        );
      }
      dependencies[dependencyId] = { steps: dependency.steps };
    }

    const resultId = randomUUID();
    const correlationId = randomUUID();
    const startedAt = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO test_results (
        id, run_id, case_key, case_name, operation, entity, priority, critical,
        expected_outcome, input_record_id, scenario_id, status, summary, pbi,
        input_json, correlation_id, started_at, completed_at, duration_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'RUNNING', ?, ?, ?, ?, ?, ?, 0)
    `).run(
      resultId,
      runId,
      testCase.id,
      testCase.name,
      testCase.operation,
      testCase.entity,
      testCase.priority,
      testCase.critical ? 1 : 0,
      testCase.expectedOutcome,
      item.fixture.recordId,
      item.fixture.scenarioId,
      "Test is running.",
      testCase.pbi ?? null,
      jsonText(redact(item.fixture.payload)),
      correlationId,
      startedAt,
      startedAt,
    );
    this.refreshCounters(runId);

    const steps: Record<string, Record<string, unknown>> = {};
    let verdict: TestVerdict = "PASS";
    let summary = "All expected HTTP statuses, response schemas, and assertions passed.";
    let errorMessageForCase: string | undefined;
    for (const step of testCase.steps) {
      if (this.isCancelRequested(runId)) {
        verdict = "CANCELLED";
        summary = "Run cancelled between request steps.";
        break;
      }
      const context: Record<string, unknown> = {
        record: item.fixture.payload,
        run: { id: runId, namespace: snapshotNamespace(runId), recordId: item.fixture.recordId },
        dependencies,
        steps,
      };
      let stepExecution: StepExecution;
      try {
        stepExecution = await this.executeStep(
          runId,
          resultId,
          testCase,
          step,
          snapshot.connection,
          context,
        );
      } catch (error) {
        const cancelled = this.isCancelRequested(runId);
        verdict = cancelled ? "CANCELLED" : "ERROR";
        errorMessageForCase = errorMessage(error);
        summary = cancelled ? "Request cancelled by user." : `Execution error: ${errorMessageForCase}`;
        this.persistFailedStep(runId, resultId, testCase, step, snapshot.connection, item.fixture, context, error);
        break;
      }

      try {
        this.persistStepResult(resultId, runId, stepExecution.result);
        this.appendLog(runId, stepExecution.logEvent);
      } catch (error) {
        verdict = "ERROR";
        errorMessageForCase = `Execution evidence could not be persisted: ${errorMessage(error)}`;
        summary = errorMessageForCase;
        this.database.prepare("UPDATE test_runs SET log_error = ? WHERE id = ?").run(errorMessage(error), runId);
        break;
      }
      steps[step.id] = stepExecution.extracted;
      if (stepExecution.verdict !== "PASS") {
        verdict = stepExecution.verdict;
        const failedAssertion = stepExecution.result.assertions.find((assertion) => !assertion.passed);
        summary = stepExecution.result.error
          ?? failedAssertion?.message
          ?? `Expected HTTP ${step.expectedStatuses.join(" or ")}, received ${stepExecution.result.responseStatus ?? "no response"}.`;
        errorMessageForCase = stepExecution.result.error;
        break;
      }
    }
    const completedAt = new Date().toISOString();
    const durationMs = Math.max(0, Date.parse(completedAt) - Date.parse(startedAt));
    this.database.prepare(`
      UPDATE test_results
      SET status = ?, summary = ?, error = ?, completed_at = ?, duration_ms = ?
      WHERE id = ? AND status = 'RUNNING'
    `).run(verdict, summary, errorMessageForCase ?? null, completedAt, durationMs, resultId);
    this.refreshCounters(runId);
    const execution: CaseExecution = { status: verdict, steps };
    try {
      this.appendLog(runId, {
        event: "case-result",
        runId,
        caseId: testCase.id,
        recordId: item.fixture.recordId,
        scenarioId: item.fixture.scenarioId,
        verdict,
        summary,
        timestamp: completedAt,
        correlationId,
      });
    } catch (error) {
      this.database.prepare("UPDATE test_runs SET log_error = ? WHERE id = ?").run(errorMessage(error), runId);
    }
    return execution;
  }

  private async executeStep(
    runId: string,
    resultId: string,
    testCase: TestCaseDefinition,
    step: TestStep,
    connection: SystemConnection,
    context: Record<string, unknown>,
  ): Promise<StepExecution> {
    const correlationId = randomUUID();
    const url = buildRequestUrl(connection, step.path, step.query, context);
    const displayedUrl = redactUrl(url);
    const resolvedBody = step.body === undefined ? undefined : resolveTemplate(step.body, context);
    const bodyText = resolvedBody === undefined ? undefined : JSON.stringify(resolvedBody);
    if (bodyText && Buffer.byteLength(bodyText, "utf8") > maxRequestBytes) {
      throw new HttpError(413, "TEST_REQUEST_TOO_LARGE", `Request body for ${testCase.name}/${step.name} exceeds 64 KB.`);
    }
    if (step.method === "GET" && bodyText !== undefined) {
      throw new HttpError(400, "GET_REQUEST_BODY_UNSUPPORTED", `${testCase.name}/${step.name} cannot send a body with GET.`);
    }
    const headers = resolveAuthHeaders(connection);
    if (bodyText !== undefined) headers["content-type"] = "application/json";
    const timeoutMs = Math.min(step.timeoutMs ?? connection.timeoutMs, connection.timeoutMs, 30_000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);
    this.addController(runId, controller);
    const started = Date.now();
    let response: Response;
    let responseRead: ResponseRead;
    let latencyMs = 0;
    try {
      if (this.isCancelRequested(runId)) throw new RequestExecutionError("Request cancelled by user.", "CANCELLED");
      response = await this.fetchImpl(url, {
        method: step.method,
        headers,
        ...(bodyText === undefined ? {} : { body: bodyText }),
        redirect: "manual",
        signal: controller.signal,
      });
      responseRead = await readResponseBody(response, maxResponseBytes);
      latencyMs = Date.now() - started;
    } catch (error) {
      latencyMs = Date.now() - started;
      const cancelled = this.isCancelRequested(runId);
      if (cancelled) throw new RequestExecutionError("Request cancelled by user.", "CANCELLED");
      if (controller.signal.aborted) {
        throw new RequestExecutionError(`Request timed out after ${timeoutMs} ms.`, "TIMEOUT");
      }
      throw new RequestExecutionError(`HTTP request failed: ${errorMessage(error)}`, "TRANSPORT");
    } finally {
      clearTimeout(timer);
      this.removeController(runId, controller);
    }
    const responseBody = responseRead.body;
    const assertions = evaluateAssertions(step.assertions, responseBody, context);
    let schemaError: string | undefined;
    if (step.responseSchema !== undefined) {
      const validator = new Ajv({ allErrors: true, strict: false }).compile(step.responseSchema as AnySchema);
      if (!validator(responseBody)) schemaError = `Response schema validation failed: ${new Ajv().errorsText(validator.errors)}.`;
    }
    const expectedStatus = step.expectedStatuses.includes(response.status);
    const failedAssertion = assertions.find((assertion) => !assertion.passed);
    let verdict: TestVerdict = expectedStatus && !schemaError && !failedAssertion ? "PASS" : "FAIL";
    const resultError = schemaError;
    let extraction: Record<string, unknown> = {};
    let extractionError: string | undefined;
    try {
      extraction = extractValues(step.extract, responseBody);
    } catch (error) {
      extractionError = errorMessage(error);
      verdict = "ERROR";
    }
    const createdAt = new Date().toISOString();
    const result: Omit<TestStepResult, "id"> = {
      stepId: step.id,
      name: step.name,
      method: step.method,
      url: displayedUrl,
      ...(resolvedBody === undefined ? {} : { requestBody: redact(resolvedBody) }),
      responseStatus: response.status,
      ...(responseBody === undefined ? {} : { responseBody: redact(responseBody) }),
      responseTruncated: responseRead.truncated,
      latencyMs,
      assertions,
      ...(resultError || extractionError ? { error: resultError ?? extractionError } : {}),
      correlationId,
      createdAt,
    };
    return {
      result,
      verdict,
      extracted: extraction,
      logEvent: {
        event: "http-step",
        runId,
        caseId: testCase.id,
        recordId: String((context.run as { recordId?: string }).recordId ?? ""),
        stepId: step.id,
        timestamp: createdAt,
        latencyMs,
        status: response.status,
        correlationId,
        request: {
          method: step.method,
          url: displayedUrl,
          body: resolvedBody === undefined ? undefined : redact(resolvedBody),
        },
        response: { status: response.status, body: redact(responseBody), truncated: responseRead.truncated },
        assertions,
        ...(resultError || extractionError ? { error: resultError ?? extractionError } : {}),
      },
    };
  }

  private persistFailedStep(
    runId: string,
    resultId: string,
    testCase: TestCaseDefinition,
    step: TestStep,
    connection: SystemConnection,
    fixture: StoredFixture,
    context: Record<string, unknown>,
    error: unknown,
  ): void {
    const id = randomUUID();
    const correlationId = randomUUID();
    const createdAt = new Date().toISOString();
    let url = connection.baseUrl;
    try {
      url = redactUrl(buildRequestUrl(connection, step.path, step.query, context));
    } catch {
      url = `${connection.baseUrl}/[unresolved-path]`;
    }
    const message = errorMessage(error);
    const timedOut = error instanceof RequestExecutionError && error.code === "TIMEOUT";
    const cancelled = error instanceof RequestExecutionError && error.code === "CANCELLED";
    this.database.prepare(`
      INSERT INTO test_step_results (
        id, result_id, run_id, step_key, step_name, method, url, request_json,
        response_status, response_json, response_truncated, latency_ms,
        assertions_json, error, correlation_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, NULL, '[]', ?, ?, ?)
    `).run(
      id,
      resultId,
      runId,
      step.id,
      step.name,
      step.method,
      url,
      jsonText(redact(step.body)),
      message,
      correlationId,
      createdAt,
    );
    const event = {
      event: "http-step",
      runId,
      caseId: testCase.id,
      recordId: fixture.recordId,
      stepId: step.id,
      timestamp: createdAt,
      latencyMs: undefined,
      status: undefined,
      correlationId,
      request: { method: step.method, url, body: redact(step.body) },
      response: undefined,
      assertions: [],
      error: message,
      errorType: timedOut ? "TIMEOUT" : cancelled ? "CANCELLED" : "EXECUTION",
    };
    try {
      this.appendLog(runId, event);
    } catch (logError) {
      this.database.prepare("UPDATE test_runs SET log_error = ? WHERE id = ?").run(errorMessage(logError), runId);
    }
  }

  private persistStepResult(resultId: string, runId: string, step: Omit<TestStepResult, "id">): void {
    this.database.prepare(`
      INSERT INTO test_step_results (
        id, result_id, run_id, step_key, step_name, method, url, request_json,
        response_status, response_json, response_truncated, latency_ms,
        assertions_json, error, correlation_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      resultId,
      runId,
      step.stepId,
      step.name,
      step.method,
      step.url,
      jsonText(step.requestBody),
      step.responseStatus ?? null,
      jsonText(step.responseBody),
      step.responseTruncated ? 1 : 0,
      step.latencyMs ?? null,
      JSON.stringify(redact(step.assertions)),
      step.error ?? null,
      step.correlationId,
      step.createdAt,
    );
  }

  private async persistTerminalResult(
    runId: string,
    snapshot: RunSnapshot,
    testCase: TestCaseDefinition,
    item: RunPlanItem,
    status: TestVerdict,
    summary: string,
  ): Promise<CaseExecution> {
    const now = new Date().toISOString();
    const inputRecordId = item.fixture?.recordId ?? `missing:${testCase.id}`;
    const resultId = randomUUID();
    this.database.prepare(`
      INSERT INTO test_results (
        id, run_id, case_key, case_name, operation, entity, priority, critical,
        expected_outcome, input_record_id, scenario_id, status, summary, pbi,
        input_json, correlation_id, started_at, completed_at, duration_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(
      resultId,
      runId,
      testCase.id,
      testCase.name,
      testCase.operation,
      testCase.entity,
      testCase.priority,
      testCase.critical ? 1 : 0,
      testCase.expectedOutcome,
      inputRecordId,
      item.fixture?.scenarioId ?? "no-matching-record",
      status,
      summary,
      testCase.pbi ?? null,
      jsonText(redact(item.fixture?.payload ?? {})),
      randomUUID(),
      now,
      now,
    );
    this.refreshCounters(runId);
    try {
      this.appendLog(runId, {
        event: "case-result",
        runId,
        caseId: testCase.id,
        recordId: inputRecordId,
        verdict: status,
        summary,
        timestamp: now,
        namespace: snapshotNamespace(runId),
      });
    } catch (error) {
      this.database.prepare("UPDATE test_runs SET log_error = ? WHERE id = ?").run(errorMessage(error), runId);
    }
    return { status, steps: {} };
  }

  private async completeUnstartedRun(row: RunRow, status: TestVerdict, message: string): Promise<void> {
    const snapshot = JSON.parse(row.snapshot_json) as RunSnapshot;
    const cases = topologicalCases(snapshot.suite.cases);
    const fixtures = this.loadFixtures(row.dataset_id);
    const plan = createRunPlan(cases, fixtures);
    for (const item of plan) {
      await this.persistTerminalResult(row.id, snapshot, item.testCase, item, status, message);
    }
    this.finishUnfinished(row.id, "CANCELLED", message);
  }

  private finishUnfinished(runId: string, status: TestRun["status"], reason?: string): void {
    const runRow = this.getRunRow(runId);
    if (runRow.status !== "QUEUED" && runRow.status !== "RUNNING") return;
    const now = new Date().toISOString();
    const unfinished = this.database.prepare(`
      SELECT id, case_key, input_record_id FROM test_results WHERE run_id = ? AND status = 'RUNNING'
    `).all(runId) as Array<{ id: string; case_key: string; input_record_id: string }>;
    for (const result of unfinished) {
      const finalStatus = status === "CANCELLED" ? "CANCELLED" : "ERROR";
      this.database.prepare(`
        UPDATE test_results SET status = ?, summary = ?, error = ?, completed_at = ?,
          duration_ms = MAX(0, CAST((julianday(?) - julianday(started_at)) * 86400000 AS INTEGER))
        WHERE id = ? AND status = 'RUNNING'
      `).run(finalStatus, reason ?? "Execution ended before test completion.", reason ?? null, now, now, result.id);
    }
    if (status === "ERROR" || status === "CANCELLED") {
      const snapshot = JSON.parse(runRow.snapshot_json) as RunSnapshot;
      const plan = createRunPlan(snapshot.suite.cases, this.loadFixtures(runRow.dataset_id));
      const existing = new Set((this.database.prepare(`
        SELECT case_key, input_record_id FROM test_results WHERE run_id = ?
      `).all(runId) as Array<{ case_key: string; input_record_id: string }>)
        .map((item) => contextKey(item.case_key, item.input_record_id)));
      const terminalStatus: TestVerdict = status === "CANCELLED" ? "CANCELLED" : "ERROR";
      for (const item of plan) {
        const inputRecordId = item.fixture?.recordId ?? `missing:${item.testCase.id}`;
        if (existing.has(contextKey(item.testCase.id, inputRecordId))) continue;
        const summary = reason ?? `Run ended as ${status.toLowerCase()} before this test started.`;
        this.database.prepare(`
          INSERT INTO test_results (
            id, run_id, case_key, case_name, operation, entity, priority, critical,
            expected_outcome, input_record_id, scenario_id, status, summary, pbi,
            input_json, correlation_id, started_at, completed_at, duration_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
        `).run(
          randomUUID(), runId, item.testCase.id, item.testCase.name, item.testCase.operation,
          item.testCase.entity, item.testCase.priority, item.testCase.critical ? 1 : 0,
          item.testCase.expectedOutcome, inputRecordId, item.fixture?.scenarioId ?? "no-matching-record",
          terminalStatus, summary, item.testCase.pbi ?? null, jsonText(redact(item.fixture?.payload ?? {})),
          randomUUID(), now, now,
        );
        try {
          this.appendLog(runId, {
            event: "case-result",
            runId,
            caseId: item.testCase.id,
            recordId: inputRecordId,
            verdict: terminalStatus,
            summary,
            timestamp: now,
          });
        } catch (error) {
          this.database.prepare("UPDATE test_runs SET log_error = ? WHERE id = ?").run(errorMessage(error), runId);
        }
      }
    }
    const completedAt = new Date().toISOString();
    const finalized = this.database.transaction(() => {
      const update = this.database.prepare(`
        UPDATE test_runs SET status = ?, error = COALESCE(?, error), completed_at = ?
        WHERE id = ? AND status IN ('QUEUED', 'RUNNING')
      `).run(status, reason ?? null, completedAt, runId);
      if (update.changes !== 1) return false;
      this.refreshCounters(runId);
      finalizeGate(this.database, runId);
      return true;
    })();
    if (!finalized) return;
    try {
      this.appendLog(runId, {
        event: "run-finished",
        runId,
        timestamp: completedAt,
        status,
        counters: this.readCounters(runId),
        ...(reason ? { error: reason } : {}),
      });
    } catch (error) {
      this.database.prepare("UPDATE test_runs SET log_error = ? WHERE id = ?").run(errorMessage(error), runId);
    }
  }

  private loadFixtures(datasetId: string): StoredFixture[] {
    const rows = this.database.prepare(`
      SELECT record_id, entity_name, payload_json, scenario_id, expected_valid
      FROM synthetic_records WHERE dataset_id = ? ORDER BY id
    `).all(datasetId) as Array<{
      record_id: string;
      entity_name: string;
      payload_json: string;
      scenario_id: string;
      expected_valid: number;
    }>;
    return rows.map((row) => ({
      recordId: row.record_id,
      entity: row.entity_name,
      scenarioId: row.scenario_id,
      expectedValid: row.expected_valid === 1,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    }));
  }

  private refreshCounters(runId: string): void {
    const counters = this.readCounters(runId);
    this.database.prepare("UPDATE test_runs SET counters_json = ? WHERE id = ?")
      .run(JSON.stringify(counters), runId);
  }

  private readCounters(runId: string): TestRunCounters {
    const counts = this.database.prepare(`
      SELECT
        COUNT(*) AS planned,
        SUM(CASE WHEN status IN ('PASS', 'FAIL', 'ERROR') THEN 1 ELSE 0 END) AS executed,
        SUM(CASE WHEN status = 'PASS' THEN 1 ELSE 0 END) AS passed,
        SUM(CASE WHEN status = 'FAIL' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN status = 'ERROR' THEN 1 ELSE 0 END) AS errors,
        SUM(CASE WHEN status = 'BLOCKED' THEN 1 ELSE 0 END) AS blocked,
        SUM(CASE WHEN status = 'CANCELLED' THEN 1 ELSE 0 END) AS cancelled
      FROM test_results WHERE run_id = ?
    `).get(runId) as {
      planned: number;
      executed: number | null;
      passed: number | null;
      failed: number | null;
      errors: number | null;
      blocked: number | null;
      cancelled: number | null;
    };
    const run = this.database.prepare("SELECT counters_json FROM test_runs WHERE id = ?").get(runId) as { counters_json: string } | undefined;
    const original = run ? JSON.parse(run.counters_json) as TestRunCounters : { planned: 0 };
    return {
      planned: Math.max(counts.planned, original.planned),
      executed: counts.executed ?? 0,
      passed: counts.passed ?? 0,
      failed: counts.failed ?? 0,
      errors: counts.errors ?? 0,
      blocked: counts.blocked ?? 0,
      cancelled: counts.cancelled ?? 0,
    };
  }

  private getRunRow(runId: string): RunRow {
    if (!/^[0-9a-f-]{36}$/i.test(runId)) throw new HttpError(400, "INVALID_RUN_ID", "Run ID must be a UUID.");
    const row = this.database.prepare("SELECT * FROM test_runs WHERE id = ?").get(runId) as RunRow | undefined;
    if (!row) throw new HttpError(404, "RUN_NOT_FOUND", `Run ${runId} was not found.`);
    return row;
  }

  private toRun(row: RunRow): TestRun {
    const snapshot = JSON.parse(row.snapshot_json) as RunSnapshot;
    return {
      id: row.id,
      status: row.status,
      suiteId: snapshot.suite.id,
      suiteVersion: snapshot.suite.version,
      suiteName: snapshot.suite.name,
      connectionId: snapshot.connection.id,
      connectionName: snapshot.connection.name,
      datasetId: snapshot.dataset.id,
      datasetName: snapshot.dataset.name,
      namespace: row.namespace,
      counters: JSON.parse(row.counters_json) as TestRunCounters,
      createdAt: row.created_at,
      ...(row.started_at ? { startedAt: row.started_at } : {}),
      ...(row.completed_at ? { completedAt: row.completed_at } : {}),
      ...(row.error ? { error: row.error } : {}),
      ...(row.log_error ? { logError: row.log_error } : {}),
    };
  }

  private appendLog(runId: string, event: Record<string, unknown>): void {
    const line = JSON.stringify(redact(event));
    appendFileSync(this.logPath(runId), `${line}\n`, "utf8");
  }

  private logPath(runId: string): string {
    return resolve(this.logDirectory, `${runId}.jsonl`);
  }

  private isCancelRequested(runId: string): boolean {
    const row = this.database.prepare("SELECT cancel_requested FROM test_runs WHERE id = ?").get(runId) as { cancel_requested: number } | undefined;
    return row?.cancel_requested === 1;
  }

  private addController(runId: string, controller: AbortController): void {
    const controllers = this.activeControllers.get(runId) ?? new Set<AbortController>();
    controllers.add(controller);
    this.activeControllers.set(runId, controllers);
  }

  private removeController(runId: string, controller: AbortController): void {
    const controllers = this.activeControllers.get(runId);
    controllers?.delete(controller);
    if (controllers?.size === 0) this.activeControllers.delete(runId);
  }

}

function createRunPlan(cases: TestCaseDefinition[], fixtures: StoredFixture[]): RunPlanItem[] {
  const plan: RunPlanItem[] = [];
  for (const testCase of topologicalCases(cases)) {
    const matched = fixtures.filter((fixture) =>
      fixture.entity === testCase.recordSelector.entity &&
      (testCase.recordSelector.expectedValid === undefined || fixture.expectedValid === testCase.recordSelector.expectedValid) &&
      (testCase.recordSelector.scenarioId === undefined || fixture.scenarioId === testCase.recordSelector.scenarioId));
    if (matched.length === 0) {
      plan.push({ testCase });
    } else {
      for (const fixture of matched) plan.push({ testCase, fixture });
    }
  }
  return plan;
}

function evaluateAssertions(
  assertions: JsonPathAssertion[],
  responseBody: unknown,
  context: Record<string, unknown>,
): AssertionResult[] {
  return assertions.map((assertion) => {
    const actual = getJsonPath(responseBody, assertion.path);
    const expected = assertion.operator === "compareToInput"
      ? getJsonPath(context.record, String(assertion.expected ?? "")).value
      : resolveTemplate(assertion.expected, context);
    let passed: boolean;
    switch (assertion.operator) {
      case "exists":
        passed = actual.exists;
        break;
      case "notExists":
        passed = !actual.exists;
        break;
      case "equals":
      case "compareToInput":
        passed = actual.exists && stableJson(actual.value) === stableJson(expected);
        break;
      case "contains":
        passed = actual.exists && (
          (typeof actual.value === "string" && typeof expected === "string" && actual.value.includes(expected)) ||
          (Array.isArray(actual.value) && actual.value.some((value) => stableJson(value) === stableJson(expected))) ||
          (isObject(actual.value) && typeof expected === "string" && Object.prototype.hasOwnProperty.call(actual.value, expected))
        );
        break;
      case "type":
        passed = actual.exists && valueType(actual.value) === expected;
        break;
      case "count":
        passed = actual.exists && countValue(actual.value) === expected;
        break;
      default:
        passed = false;
    }
    return {
      path: assertion.path,
      operator: assertion.operator,
      passed,
      ...(assertion.expected === undefined ? {} : { expected: redactAssertionValue(assertion.path, expected) }),
      ...(actual.exists ? { actual: redactAssertionValue(assertion.path, actual.value) } : {}),
      message: passed
        ? `${assertion.path} ${assertion.operator} assertion passed.`
        : `${assertion.path} ${assertion.operator} assertion failed.`,
    };
  });
}

function redactAssertionValue(path: string, value: unknown): unknown {
  const result = redact({ [path]: value }) as Record<string, unknown>;
  return result[path];
}

function extractValues(extract: Record<string, string> | undefined, responseBody: unknown): Record<string, unknown> {
  if (!extract) return {};
  const values: Record<string, unknown> = {};
  for (const [name, path] of Object.entries(extract)) {
    const result = getJsonPath(responseBody, path);
    if (!result.exists) {
      throw new RequestExecutionError(`Response extraction ${name} could not find ${path}.`, "EXTRACTION");
    }
    values[name] = result.value;
  }
  return values;
}

async function readResponseBody(response: Response, maxBytes: number): Promise<ResponseRead> {
  if (!response.body) return { body: undefined, truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const available = maxBytes - total;
    if (value.byteLength > available) {
      if (available > 0) chunks.push(value.slice(0, available));
      total = maxBytes;
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(joined);
  if (!text) return { body: undefined, truncated };
  try {
    return { body: JSON.parse(text) as unknown, truncated };
  } catch {
    return { body: text, truncated };
  }
}

function valueType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value === "object" ? "object" : typeof value;
}

function countValue(value: unknown): number | undefined {
  if (Array.isArray(value) || typeof value === "string") return value.length;
  if (isObject(value)) return Object.keys(value).length;
  return undefined;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function contextKey(caseId: string, recordId: string): string {
  return `${caseId}:${recordId}`;
}

function snapshotNamespace(runId: string): string {
  return `run-${runId.slice(0, 12)}`;
}

function jsonText(value: unknown): string | null {
  if (value === undefined) return null;
  return JSON.stringify(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class RequestExecutionError extends Error {
  constructor(message: string, readonly code: "TIMEOUT" | "TRANSPORT" | "CANCELLED" | "EXTRACTION") {
    super(message);
  }
}
