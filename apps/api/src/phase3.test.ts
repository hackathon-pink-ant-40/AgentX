import type Database from "better-sqlite3";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { Server } from "node:http";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { TestCaseDefinition, TestRun } from "@agentx/shared";
import { createApp } from "./app.js";
import { openDatabase } from "./database.js";
import { DatasetService } from "./dataset-service.js";
import { TestRunService } from "./test-runner.js";
import { recoverSprintEvents } from "./sprint-close.js";
import { demoSuiteName, demoTestCases } from "./demo-tests.js";

const sampleModel = readFileSync(new URL("../../../samples/customer-address.canonical.json", import.meta.url), "utf8");

describe("Phase 3 test configuration and execution", () => {
  let directory: string;
  let database: Database.Database;
  let datasetService: DatasetService;
  let server: Server | undefined;
  let baseUrl: string;
  let originalTestToken: string | undefined;
  let originalLogDir: string | undefined;

  async function startServer(fetchImpl: typeof fetch = fetch, useEnvironmentLogDir = false): Promise<void> {
    if (server) {
      const previousServer = server;
      server = undefined;
      await new Promise<void>((resolve, reject) => {
        previousServer.close((error) => error ? reject(error) : resolve());
      });
    }
    const runService = new TestRunService(database, datasetService, {
      ...(useEnvironmentLogDir ? {} : { logDirectory: join(directory, ".agentx-test", "logs") }),
      fetchImpl,
    });
    const app = createApp(database, datasetService, runService);
    server = app.listen(0, "127.0.0.1");
    const activeServer = server;
    await new Promise<void>((resolve, reject) => {
      activeServer.once("error", reject);
      activeServer.once("listening", resolve);
    });
    const address = activeServer.address();
    if (!address || typeof address === "string") throw new Error("Test API did not bind to a TCP port.");
    baseUrl = `http://127.0.0.1:${address.port}`;
  }

  async function createDataset(includeOrphanAddress = false): Promise<string> {
    const imported = await request(baseUrl).post("/api/models/import")
      .send({ sourceFormat: "canonical", content: sampleModel }).expect(201);
    const profileResponse = await request(baseUrl).post("/api/generation-profiles")
      .send({ modelVersionId: imported.body.model.id }).expect(201);
    const profile = profileResponse.body.profile as {
      id: string;
      recordCounts: Record<string, number>;
    };
    const configured = await request(baseUrl).patch(`/api/generation-profiles/${profile.id}`)
      .send({
        recordCounts: { ...profile.recordCounts, Customer: 1, Address: 1 },
        negativeScenarios: includeOrphanAddress ? ["orphan_fk"] : [],
      }).expect(200);
    const dataset = await request(baseUrl).post("/api/datasets")
      .send({ profileId: configured.body.profile.id, name: "Phase 3 integration dataset" }).expect(201);
    expect(dataset.body.dataset.status).toBe("READY");
    return dataset.body.dataset.id as string;
  }

  async function waitForTerminalRun(runId: string): Promise<TestRun> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const response = await request(baseUrl).get(`/api/test-runs/${runId}`).expect(200);
      const run = response.body.run as TestRun;
      if (run.status !== "QUEUED" && run.status !== "RUNNING") return run;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    throw new Error(`Test run ${runId} did not finish before the test timeout.`);
  }

  async function loadDemo(): Promise<{ connectionId: string; suiteId: string }> {
    const response = await request(baseUrl).post("/api/demo/load").send({}).expect(200);
    return { connectionId: response.body.connection.id, suiteId: response.body.suite.id };
  }

  beforeEach(async () => {
    originalLogDir = process.env.AGENTX_LOG_DIR;
    directory = mkdtempSync(join(tmpdir(), "agentx-phase3-"));
    database = openDatabase(join(directory, "test.sqlite"));
    datasetService = new DatasetService(database, join(directory, ".agentx-test", "exports"));
    await startServer();
  });

  afterEach(async () => {
    if (server) {
      const activeServer = server;
      server = undefined;
      await new Promise<void>((resolve, reject) => {
        activeServer.close((error) => error ? reject(error) : resolve());
      });
    }
    database.close();
    rmSync(directory, { recursive: true, force: true });
    if (originalTestToken === undefined) delete process.env.AGENTX_PHASE3_TEST_TOKEN;
    else process.env.AGENTX_PHASE3_TEST_TOKEN = originalTestToken;
    originalTestToken = undefined;
    if (originalLogDir === undefined) delete process.env.AGENTX_LOG_DIR;
    else process.env.AGENTX_LOG_DIR = originalLogDir;
    originalLogDir = undefined;
  });

  it("restricts targets to this server and versions suite edits", async () => {
    const demo = await loadDemo();
    const loadedAgain = await loadDemo();
    expect(loadedAgain).toEqual(demo);
    const connection = await request(baseUrl).get(`/api/connections/${demo.connectionId}`).expect(200);
    expect(connection.body.connection.baseUrl).toBe(`${baseUrl}/api/mock-api`);
    const check = await request(baseUrl).post(`/api/connections/${demo.connectionId}/check`).expect(200);
    expect(check.body).toMatchObject({ ok: true, status: 200 });

    const rejected = await request(baseUrl).post("/api/connections").send({
      name: "External target",
      systemType: "Customer MDM",
      environment: "QA",
      baseUrl: "https://example.test/api",
      authType: "none",
      headers: {},
      timeoutMs: 1000,
      maxConcurrency: 1,
      enabled: true,
    }).expect(400);
    expect(rejected.body.error.code).toBe("UNSAFE_CONNECTION_URL");

    const original = await request(baseUrl).get(`/api/test-suites/${demo.suiteId}`).expect(200);
    const updated = await request(baseUrl).patch(`/api/test-suites/${demo.suiteId}`)
      .send({ name: "Customer MDM acceptance v2" }).expect(200);
    expect(updated.body.suite.version).toBe(original.body.suite.version + 1);
    expect(updated.body.suite.versionId).not.toBe(original.body.suite.versionId);
    const firstVersion = await request(baseUrl)
      .get(`/api/test-suites/${demo.suiteId}/versions/${original.body.suite.version}`).expect(200);
    expect(firstVersion.body.suite.name).toBe(original.body.suite.name);
    expect(firstVersion.body.suite.cases).toEqual(original.body.suite.cases);
  });

  it("resolves relative log paths from the repository root", async () => {
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const logDirectory = join(directory, ".agentx-test", "relative-logs");
    process.env.AGENTX_LOG_DIR = relative(root, logDirectory);
    await startServer(fetch, true);
    const demo = await loadDemo();
    const datasetId = await createDataset(true);
    const created = await request(baseUrl).post("/api/test-runs").send({ ...demo, datasetId }).expect(202);
    await waitForTerminalRun(created.body.run.id);
    expect(existsSync(join(logDirectory, `${created.body.run.id}.jsonl`))).toBe(true);
    await request(baseUrl).get(`/api/test-runs/${created.body.run.id}/log`).expect(200);
  });

  it("does not overwrite unrelated configurations with demo names", async () => {
    const connection = await request(baseUrl).post("/api/connections").send({
      name: "Local Customer MDM Sandbox", systemType: "Other local setup", environment: "DEMO",
      baseUrl: `${baseUrl}/api/mock-api`, authType: "none", headers: {}, timeoutMs: 1200, maxConcurrency: 1, enabled: true,
    }).expect(201);
    const suite = await request(baseUrl).post("/api/test-suites").send({
      name: demoSuiteName, cases: [{ ...demoTestCases[0], name: "User-owned case" }],
    }).expect(201);
    const demo = (await request(baseUrl).post("/api/demo/load").send({}).expect(200)).body;
    expect(demo.connection.id).not.toBe(connection.body.connection.id);
    expect(demo.suite.id).not.toBe(suite.body.suite.id);
    expect((await request(baseUrl).get(`/api/connections/${connection.body.connection.id}`).expect(200)).body.connection.systemType).toBe("Other local setup");
    expect((await request(baseUrl).get(`/api/test-suites/${suite.body.suite.id}`).expect(200)).body.suite.cases[0].name).toBe("User-owned case");
    const reloaded = (await request(baseUrl).post("/api/demo/load").send({}).expect(200)).body;
    expect(reloaded.connection.updatedAt).toBe(demo.connection.updatedAt);
    expect(reloaded.suite.versionId).toBe(demo.suite.versionId);
  });

  it("loads the full demo idempotently and orchestrates sprint close without duplicate runs", async () => {
    const first = (await request(baseUrl).post("/api/demo/load").send({}).expect(200)).body;
    const again = (await request(baseUrl).post("/api/demo/load").send({}).expect(200)).body;
    expect(again.model.id).toBe(first.model.id);
    expect(again.profile.id).toBe(first.profile.id);
    expect(again.connection.id).toBe(first.connection.id);
    expect(again.suite.versionId).toBe(first.suite.versionId);
    expect(again.policy.id).toBe("default-demo");
    expect(again.profile.negativeScenarios).toContain("orphan_fk");
    expect((await request(baseUrl).get("/api/models").expect(200)).body.models).toHaveLength(1);
    expect((await request(baseUrl).get("/api/generation-profiles").expect(200)).body.profiles).toHaveLength(1);
    await request(baseUrl).patch(`/api/generation-profiles/${first.profile.id}`)
      .send({ recordCounts: { Customer: 1, Address: 1 } }).expect(200);
    expect((await request(baseUrl).post("/api/demo/load").send({}).expect(200)).body.profile.recordCounts.Customer).toBe(1);
    const input = {
      eventId: "sprint-event-one", sprintId: "sprint-1", profileId: first.profile.id, suiteId: first.suite.id,
      connectionId: first.connection.id, policyId: first.policy.id,
      workItems: ["PBI-DEMO-MDM-LIFECYCLE", "PBI-DEMO-MDM-NEGATIVE"],
    };
    const gap = await request(baseUrl).post("/api/sprint-events").send({ ...input, eventId: "missing-mapping", workItems: ["PBI-UNMAPPED"] }).expect(201);
    expect(gap.body.event).toMatchObject({ status: "MAPPING_GAPS", decision: "NO-GO", gaps: ["PBI-UNMAPPED"] });
    expect(gap.body.event.runId).toBeUndefined();
    const started = await request(baseUrl).post("/api/sprint-events").send(input).expect(202);
    const event = started.body.event;
    const repeated = await request(baseUrl).post("/api/sprint-events").send({ ...input, workItems: [...input.workItems].reverse() }).expect(200);
    expect(repeated.body.event.runId).toBe(event.runId);
    expect(repeated.body.event.datasetId).toBe(event.datasetId);
    await request(baseUrl).post("/api/sprint-events").send({ ...input, sprintId: "different" }).expect(409);
    await waitForTerminalRun(event.runId);
    const baseline = (await request(baseUrl).get(`/api/sprint-events/${input.eventId}`).expect(200)).body.event;
    expect(baseline).toMatchObject({ status: "COMPLETED", decision: "GO", gate: { decision: "GO" } });
    expect(database.prepare("SELECT COUNT(*) AS count FROM sprint_events WHERE run_id IS NOT NULL").get()).toEqual({ count: 1 });
    await request(baseUrl).post("/api/demo/regression").send({ enabled: true }).expect(200);
    const bad = await request(baseUrl).post("/api/sprint-events").send({ ...input, eventId: "sprint-event-regression" }).expect(202);
    await waitForTerminalRun(bad.body.event.runId);
    const regression = (await request(baseUrl).get("/api/sprint-events/sprint-event-regression").expect(200)).body.event;
    expect(regression).toMatchObject({ status: "COMPLETED", decision: "NO-GO", gate: { decision: "NO-GO" } });
    expect((await request(baseUrl).get("/api/defects").expect(200)).body.defects.length).toBeGreaterThan(0);
    const interruptedInput = { ...input, eventId: "interrupted" };
    database.prepare("INSERT INTO sprint_events (id, input_json, status, gaps_json, created_at) VALUES (?, ?, 'CREATING', '[]', ?)")
      .run(interruptedInput.eventId, JSON.stringify(interruptedInput), new Date().toISOString());
    recoverSprintEvents(database);
    expect((await request(baseUrl).get("/api/sprint-events/interrupted").expect(200)).body.event.status).toBe("ERROR");
    await startServer();
    expect((await request(baseUrl).get(`/api/sprint-events/${input.eventId}`).expect(200)).body.event.decision).toBe("GO");
    expect((await request(baseUrl).get("/api/sprint-events/sprint-event-regression").expect(200)).body.event.decision).toBe("NO-GO");
    await request(baseUrl).post("/api/demo/reset").send({}).expect(200);
    expect((await request(baseUrl).get("/api/health").expect(200)).body.counts).toEqual({ customers: 0, addresses: 0 });
    expect((await request(baseUrl).get(`/api/sprint-events/${input.eventId}`).expect(200)).body.event.decision).toBe("GO");
  });

  it("executes real lifecycle and rejection requests, persists results, and writes JSONL evidence", async () => {
    const demo = await loadDemo();
    const datasetId = await createDataset(true);
    originalTestToken = process.env.AGENTX_PHASE3_TEST_TOKEN;
    process.env.AGENTX_PHASE3_TEST_TOKEN = "phase3-test-value";
    const authenticatedConnection = await request(baseUrl).post("/api/connections").send({
      name: "Authenticated local sandbox",
      systemType: "Customer MDM",
      environment: "DEMO",
      baseUrl: `${baseUrl}/api/mock-api`,
      authType: "bearer",
      secretRef: "AGENTX_PHASE3_TEST_TOKEN",
      headers: {},
      timeoutMs: 5000,
      maxConcurrency: 1,
      enabled: true,
    }).expect(201);
    const created = await request(baseUrl).post("/api/test-runs").send({
      suiteId: demo.suiteId,
      connectionId: authenticatedConnection.body.connection.id,
      datasetId,
    }).expect(202);
    const runId = created.body.run.id as string;
    const completed = await waitForTerminalRun(runId);
    expect(completed.status).toBe("COMPLETED");
    expect(completed.counters).toMatchObject({
      planned: 4,
      executed: 4,
      passed: 4,
      failed: 0,
      errors: 0,
      blocked: 0,
    });

    const resultsResponse = await request(baseUrl).get(`/api/test-runs/${runId}/results`).expect(200);
    const results = resultsResponse.body.results as Array<{
      id: string;
      caseId: string;
      status: string;
      steps: Array<{ responseStatus?: number; responseBody?: { customer?: { firstName?: string } }; assertions: Array<{ passed: boolean }> }>;
    }>;
    expect(results.map((result) => [result.caseId, result.status]).sort((left, right) => left[0].localeCompare(right[0]))).toEqual([
      ["duplicateCustomer", "PASS"],
      ["lifecycle", "PASS"],
      ["missingRequired", "PASS"],
      ["orphanAddress", "PASS"],
    ]);
    const lifecycle = results.find((result) => result.caseId === "lifecycle");
    expect(lifecycle?.steps.map((step) => step.responseStatus)).toEqual([201, 200, 200, 201, 201, 200, 200, 200]);
    expect(lifecycle?.steps[2].responseBody?.customer?.firstName).toContain("Zoë-東京");
    expect(lifecycle?.steps.every((step) => step.assertions.every((assertion) => assertion.passed))).toBe(true);
    const detail = await request(baseUrl).get(`/api/results/${results[0].id}`).expect(200);
    expect(detail.body.result.steps).toHaveLength(8);

    const log = await request(baseUrl).get(`/api/test-runs/${runId}/log`).expect(200);
    const logText = log.text ?? log.body.toString("utf8");
    const events = logText.trim().split("\n").map((line: string) => JSON.parse(line) as Record<string, unknown>);
    expect(events[0].event).toBe("run-queued");
    expect(events.filter((event) => event.event === "http-step")).toHaveLength(11);
    expect(events.at(-1)).toMatchObject({ event: "run-finished", status: "COMPLETED" });
    expect(logText).not.toContain("phase3-test-value");
    await startServer();
    const persistedRun = await request(baseUrl).get(`/api/test-runs/${runId}`).expect(200);
    expect(persistedRun.body.run.counters.passed).toBe(4);
    const persistedResults = await request(baseUrl).get(`/api/test-runs/${runId}/results`).expect(200);
    expect(persistedResults.body.results).toHaveLength(4);
    const persistedLog = await request(baseUrl).get(`/api/test-runs/${runId}/log`).expect(200);
    expect(persistedLog.status).toBe(200);
  });

  it("persists baseline GO and real regression NO-GO with deduplicated evidence", async () => {
    const demo = await loadDemo();
    const datasetId = await createDataset(true);
    const run = async () => {
      const created = await request(baseUrl).post("/api/test-runs").send({ ...demo, datasetId }).expect(202);
      const id = created.body.run.id as string;
      expect((await waitForTerminalRun(id)).status).toBe("COMPLETED");
      return id;
    };
    const baselineId = await run();
    const baseline = await request(baseUrl).get(`/api/analytics/runs/${baselineId}`).expect(200);
    expect(baseline.body.gate.decision).toBe("GO");
    expect(baseline.body.metrics).toMatchObject({ planned: 4, executed: 4, passed: 4, passRate: 100, coverage: 100 });
    const filtered = await request(baseUrl).get(`/api/analytics/runs/${baselineId}?caseId=lifecycle`).expect(200);
    expect(filtered.body.metrics).toMatchObject({ planned: 1, executed: 1, passed: 1 });
    const policy = baseline.body.gate.policy;
    await request(baseUrl).put(`/api/release-policies/${policy.id}`).send({
      name: policy.name, environment: policy.environment, passThreshold: 100, minimumCoverage: 100,
      maxCriticalFailures: 0, allowErrors: false, allowBlocked: false,
    }).expect(200);
    expect((await request(baseUrl).get(`/api/analytics/runs/${baselineId}`).expect(200)).body.gate.policy.version).toBe(1);
    await request(baseUrl).post("/api/demo/regression").send({ enabled: true }).expect(200);
    const regressionId = await run();
    const nextRegressionId = await run();
    const regression = await request(baseUrl).get(`/api/analytics/runs/${regressionId}`).expect(200);
    expect(regression.body.gate).toMatchObject({ decision: "NO-GO", policy: { version: 2 } });
    expect(regression.body.metrics.failed).toBeGreaterThan(0);
    const evidence = await request(baseUrl).get(`/api/analytics/runs/${regressionId}/results?status=FAIL`).expect(200);
    const failedResult = evidence.body.results[0];
    expect(failedResult.steps.some((step: { assertions: Array<{ passed: boolean }> }) => step.assertions.some((assertion) => !assertion.passed))).toBe(true);
    const detail = await request(baseUrl).get(`/api/analytics/results/${failedResult.id}`).expect(200);
    expect(detail.body.source.record_id).toBe(failedResult.inputRecordId);
    expect(detail.body.expectedStatuses).toBeDefined();
    await request(baseUrl).get(`/api/datasets/${datasetId}/export/combined`).expect(200);
    const records = await request(baseUrl).get(`/api/analytics/records?datasetId=${datasetId}&search=${encodeURIComponent(failedResult.inputRecordId)}`).expect(200);
    expect(records.body.records.some((record: { recordId: string }) => record.recordId === failedResult.inputRecordId)).toBe(true);
    const defects = await request(baseUrl).get("/api/defects").expect(200);
    expect(defects.body.defects).toHaveLength(1);
    expect(defects.body.defects[0].occurrences.map((item: { runId: string }) => item.runId).sort()).toEqual([regressionId, nextRegressionId].sort());
    const exported = await request(baseUrl).get("/api/defects/export").expect(200);
    expect(exported.body.defects[0].occurrences).toHaveLength(2);
    database.prepare("DELETE FROM gate_decisions WHERE run_id = ?").run(regressionId);
    new TestRunService(database, datasetService, { logDirectory: join(directory, ".agentx-test", "logs") }).recoverInterruptedRuns();
    expect((await request(baseUrl).get("/api/defects").expect(200)).body.defects[0].occurrences).toHaveLength(2);
    await startServer();
    expect((await request(baseUrl).get(`/api/analytics/runs/${regressionId}`).expect(200)).body.gate.decision).toBe("NO-GO");
    expect((await request(baseUrl).get("/api/demo/regression").expect(200)).body.enabled).toBe(true);
    await request(baseUrl).post("/api/demo/regression").send({ enabled: false }).expect(200);
    await loadDemo();
    const restoredId = await run();
    expect((await request(baseUrl).get(`/api/analytics/runs/${restoredId}`).expect(200)).body.gate.decision).toBe("GO");
  });

  it("marks unexpected acceptance FAIL and blocks dependent cases", async () => {
    const acceptedFetch: typeof fetch = async () => new Response(
      JSON.stringify({ accepted: false, secretToken: "sensitive-assertion-value" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
    await startServer(acceptedFetch);
    const demo = await loadDemo();
    const datasetId = await createDataset();
    const cases: TestCaseDefinition[] = [
      {
        id: "rejectDuplicate",
        name: "Expected rejection must not be accepted",
        operation: "VALIDATE",
        entity: "Customer",
        recordSelector: { entity: "Customer", expectedValid: true },
        priority: "P1",
        critical: true,
        expectedOutcome: "negative",
        dependsOn: [],
        steps: [{
          id: "request",
          name: "Expect duplicate rejection",
          method: "POST",
          path: "customers",
          body: { customerId: "duplicate", firstName: "Test", lastName: "Record" },
          expectedStatuses: [409],
          assertions: [],
        }],
      },
      {
        id: "assertionMismatch",
        name: "Expected response assertion must pass",
        operation: "READ",
        entity: "Customer",
        recordSelector: { entity: "Customer", expectedValid: true },
        priority: "P1",
        critical: false,
        expectedOutcome: "positive",
        dependsOn: [],
        steps: [{
          id: "assertResponse",
          name: "Check response field",
          method: "GET",
          path: "customers",
          expectedStatuses: [200],
          assertions: [
            { path: "accepted", operator: "equals", expected: true },
            { path: "secretToken", operator: "equals", expected: "not-the-token" },
          ],
        }],
      },
      {
        id: "requiresRejection",
        name: "Dependent case",
        operation: "READ",
        entity: "Customer",
        recordSelector: { entity: "Customer", expectedValid: true },
        priority: "P2",
        critical: false,
        expectedOutcome: "positive",
        dependsOn: ["rejectDuplicate"],
        steps: [{
          id: "read",
          name: "Read only after prerequisite",
          method: "GET",
          path: "customers",
          expectedStatuses: [200],
          assertions: [],
        }],
      },
    ];
    const suite = await request(baseUrl).post("/api/test-suites")
      .send({ name: "Verdict semantics", cases }).expect(201);
    const run = await request(baseUrl).post("/api/test-runs").send({
      suiteId: suite.body.suite.id,
      connectionId: demo.connectionId,
      datasetId,
    }).expect(202);
    const completed = await waitForTerminalRun(run.body.run.id);
    expect(completed.counters).toMatchObject({ failed: 2, blocked: 1, executed: 2 });
    const results = (await request(baseUrl).get(`/api/test-runs/${run.body.run.id}/results`).expect(200)).body.results;
    expect(results.map((result: { caseId: string; status: string }) => [result.caseId, result.status]).sort())
      .toEqual([["assertionMismatch", "FAIL"], ["rejectDuplicate", "FAIL"], ["requiresRejection", "BLOCKED"]]);
    const gate = (await request(baseUrl).get(`/api/analytics/runs/${run.body.run.id}`).expect(200)).body.gate;
    expect(gate.decision).toBe("NO-GO");
    expect(gate.metrics).toMatchObject({ planned: 3, executed: 2, failed: 2, blocked: 1 });
    expect(gate.reasons.some((reason: string) => reason.includes("blocked"))).toBe(true);
    expect(JSON.stringify(results)).not.toContain("sensitive-assertion-value");
    const defectExport = await request(baseUrl).get("/api/defects/export").expect(200);
    expect(JSON.stringify(defectExport.body)).not.toContain("sensitive-assertion-value");
    const log = await request(baseUrl).get(`/api/test-runs/${run.body.run.id}/log`).expect(200);
    expect(log.text ?? log.body.toString("utf8")).not.toContain("sensitive-assertion-value");
  });

  it("records request timeouts as ERROR and supports cancellation", async () => {
    const hangingFetch: typeof fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) {
        reject(new Error("Expected executor abort signal."));
        return;
      }
      if (signal.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
    await startServer(hangingFetch);
    const demo = await loadDemo();
    const datasetId = await createDataset();
    const suite = await request(baseUrl).post("/api/test-suites").send({
      name: "Timeout semantics",
      cases: [{
        id: "timesOut",
        name: "Request times out",
        operation: "READ",
        entity: "Customer",
        recordSelector: { entity: "Customer", expectedValid: true },
        priority: "P1",
        critical: false,
        expectedOutcome: "positive",
        dependsOn: [],
        steps: [{
          id: "request",
          name: "Wait for timeout",
          method: "GET",
          path: "customers",
          expectedStatuses: [200],
          assertions: [],
          timeoutMs: 500,
        }],
      }],
    }).expect(201);
    const timeoutRun = await request(baseUrl).post("/api/test-runs").send({
      suiteId: suite.body.suite.id,
      connectionId: demo.connectionId,
      datasetId,
    }).expect(202);
    const timeoutCompleted = await waitForTerminalRun(timeoutRun.body.run.id);
    expect(timeoutCompleted.counters.errors).toBe(1);
    const timeoutResults = (await request(baseUrl).get(`/api/test-runs/${timeoutRun.body.run.id}/results`).expect(200)).body.results;
    expect(timeoutResults[0].status).toBe("ERROR");
    expect(timeoutResults[0].steps[0].error).toContain("timed out");
    const timeoutGate = (await request(baseUrl).get(`/api/analytics/runs/${timeoutRun.body.run.id}`).expect(200)).body.gate;
    expect(timeoutGate.decision).toBe("NO-GO");
    expect(timeoutGate.reasons.some((reason: string) => reason.includes("errors are disallowed"))).toBe(true);

    const cancelRun = await request(baseUrl).post("/api/test-runs").send({
      suiteId: suite.body.suite.id,
      connectionId: demo.connectionId,
      datasetId,
    }).expect(202);
    const cancelId = cancelRun.body.run.id as string;
    const pending = await request(baseUrl).get(`/api/analytics/runs/${cancelId}`).expect(200);
    expect(pending.body.gate.decision).toBe("PENDING");
    await request(baseUrl).post("/api/demo/regression").send({ enabled: true }).expect(409);
    await request(baseUrl).post("/api/demo/reset").send({}).expect(409);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const status = (await request(baseUrl).get(`/api/test-runs/${cancelId}`).expect(200)).body.run.status;
      if (status === "RUNNING") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await request(baseUrl).post(`/api/test-runs/${cancelId}/cancel`).expect(200);
    const cancelled = await waitForTerminalRun(cancelId);
    expect(cancelled.status).toBe("CANCELLED");
    const cancelledResults = (await request(baseUrl).get(`/api/test-runs/${cancelId}/results`).expect(200)).body.results;
    expect(cancelledResults[0].status).toBe("CANCELLED");
    expect((await request(baseUrl).get(`/api/analytics/runs/${cancelId}`).expect(200)).body.gate.decision).toBe("NO-GO");
  });

  it("uses unrounded thresholds and rejects empty, incomplete and critical non-pass runs", async () => {
    const demo = await loadDemo();
    const datasetId = await createDataset(true);
    const created = await request(baseUrl).post("/api/test-runs").send({ ...demo, datasetId }).expect(202);
    const id = created.body.run.id as string;
    await waitForTerminalRun(id);
    const row = database.prepare("SELECT policy_json FROM test_runs WHERE id = ?").get(id) as { policy_json: string };
    const policy = JSON.parse(row.policy_json) as Record<string, unknown>;
    const evaluate = async () => (await request(baseUrl).get(`/api/analytics/runs/${id}`).expect(200)).body.gate;
    const resetDecision = () => database.prepare("DELETE FROM gate_decisions WHERE run_id = ?").run(id);
    database.prepare("UPDATE test_results SET status = 'BLOCKED', critical = 0 WHERE run_id = ? AND case_key = 'orphanAddress'").run(id);
    database.prepare("UPDATE test_runs SET policy_json = ? WHERE id = ?").run(JSON.stringify({
      ...policy, passThreshold: 75.001, minimumCoverage: 75, allowBlocked: true,
    }), id);
    resetDecision();
    const justBelow = await evaluate();
    expect(justBelow.metrics).toMatchObject({ passRate: 75, coverage: 75 });
    expect(justBelow.decision).toBe("NO-GO");
    database.prepare("UPDATE test_runs SET policy_json = ? WHERE id = ?").run(JSON.stringify({
      ...policy, passThreshold: 75, minimumCoverage: 75, allowBlocked: true,
    }), id);
    resetDecision();
    expect((await evaluate()).decision).toBe("GO");
    database.prepare("UPDATE test_results SET critical = 1 WHERE run_id = ? AND case_key = 'orphanAddress'").run(id);
    resetDecision();
    expect((await evaluate()).decision).toBe("NO-GO");
    database.prepare("UPDATE test_runs SET status = 'CANCELLED' WHERE id = ?").run(id);
    resetDecision();
    expect((await evaluate()).reasons.some((reason: string) => reason.includes("CANCELLED"))).toBe(true);
    database.prepare("DELETE FROM test_results WHERE run_id = ?").run(id);
    database.prepare("UPDATE test_runs SET status = 'COMPLETED', counters_json = ? WHERE id = ?").run(JSON.stringify({ planned: 0 }), id);
    resetDecision();
    expect((await evaluate()).reasons).toContain("No tests were planned.");
  });
});
