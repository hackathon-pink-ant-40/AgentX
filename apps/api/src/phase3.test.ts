import type Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { Server } from "node:http";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { TestCaseDefinition, TestRun } from "@agentx/shared";
import { createApp } from "./app.js";
import { openDatabase } from "./database.js";
import { DatasetService } from "./dataset-service.js";
import { TestRunService } from "./test-runner.js";

const sampleModel = readFileSync(new URL("../../../samples/customer-address.canonical.json", import.meta.url), "utf8");

describe("Phase 3 test configuration and execution", () => {
  let directory: string;
  let database: Database.Database;
  let datasetService: DatasetService;
  let server: Server | undefined;
  let baseUrl: string;
  let originalTestToken: string | undefined;

  async function startServer(fetchImpl: typeof fetch = fetch): Promise<void> {
    if (server) {
      const previousServer = server;
      server = undefined;
      await new Promise<void>((resolve, reject) => {
        previousServer.close((error) => error ? reject(error) : resolve());
      });
    }
    const runService = new TestRunService(database, datasetService, {
      logDirectory: join(directory, "logs"),
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
    directory = mkdtempSync(join(tmpdir(), "agentx-phase3-"));
    database = openDatabase(join(directory, "test.sqlite"));
    datasetService = new DatasetService(database, join(directory, "exports"));
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
      steps: Array<{ responseStatus?: number; assertions: Array<{ passed: boolean }> }>;
    }>;
    expect(results.map((result) => [result.caseId, result.status]).sort((left, right) => left[0].localeCompare(right[0]))).toEqual([
      ["duplicateCustomer", "PASS"],
      ["lifecycle", "PASS"],
      ["missingRequired", "PASS"],
      ["orphanAddress", "PASS"],
    ]);
    const lifecycle = results.find((result) => result.caseId === "lifecycle");
    expect(lifecycle?.steps.map((step) => step.responseStatus)).toEqual([201, 200, 200, 201, 201, 200, 200, 200]);
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

  it("marks unexpected acceptance FAIL and blocks dependent cases", async () => {
    const acceptedFetch: typeof fetch = async () => new Response(
      JSON.stringify({ accepted: false }),
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
          assertions: [{ path: "accepted", operator: "equals", expected: true }],
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
          timeoutMs: 100,
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

    const cancelRun = await request(baseUrl).post("/api/test-runs").send({
      suiteId: suite.body.suite.id,
      connectionId: demo.connectionId,
      datasetId,
    }).expect(202);
    const cancelId = cancelRun.body.run.id as string;
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
  });
});
