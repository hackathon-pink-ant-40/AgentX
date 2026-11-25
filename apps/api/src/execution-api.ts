import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  ConnectionInput,
  SystemConnection,
  TestCaseDefinition,
  TestRunInput,
  TestSuite,
  TestSuiteInput,
} from "@agentx/shared";
import type { NextFunction, Request, Response } from "express";
import { Router } from "express";
import { DatasetService } from "./dataset-service.js";
import { demoSuiteName, demoTestCases } from "./demo-tests.js";
import { resetMockData } from "./demo-reset.js";
import { HttpError } from "./http-error.js";
import { getPolicy } from "./analytics.js";
import { loadDemoModelAndProfile } from "./models-api.js";
import { TestRunService } from "./test-runner.js";
import {
  connectionFromRow,
  normalizeSuite,
  parseConnectionInput,
  resolveAuthHeaders,
  topologicalCases,
} from "./test-safety.js";

interface ConnectionRow {
  id: string;
  name: string;
  system_type: string;
  environment: SystemConnection["environment"];
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

interface SuiteRow {
  id: string;
  name: string;
  current_version: number;
  created_at: string;
  updated_at: string;
  version_id: string;
  cases_json: string;
}

function route(
  handler: (request: Request, response: Response) => void | Promise<void>,
): (request: Request, response: Response, next: NextFunction) => void {
  return (request, response, next) => {
    Promise.resolve(handler(request, response)).catch(next);
  };
}

function requiredObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, "INVALID_REQUEST", `${label} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function routeId(request: Request, name: string): string {
  const value = request.params[name];
  if (typeof value !== "string" || !/^[0-9a-f-]{36}$/i.test(value)) {
    throw new HttpError(400, "INVALID_ID", `${name} must be a UUID.`);
  }
  return value;
}

function toSuite(row: SuiteRow): TestSuite {
  return {
    id: row.id,
    version: row.current_version,
    versionId: row.version_id,
    name: row.name,
    cases: JSON.parse(row.cases_json) as TestCaseDefinition[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createExecutionApiRouter(
  database: Database.Database,
  datasetService: DatasetService,
  runService: TestRunService,
): Router {
  const router = Router();

  router.get("/connections/local-default", (request, response) => {
    const port = request.socket.localPort;
    if (!port) throw new HttpError(400, "LOCAL_PORT_UNAVAILABLE", "Cannot determine the local API port.");
    response.json({ baseUrl: `http://127.0.0.1:${port}/api/mock-api` });
  });

  router.get("/connections", (_request, response) => {
    const rows = database.prepare("SELECT * FROM connections ORDER BY name, created_at").all() as ConnectionRow[];
    response.json({ connections: rows.map(connectionFromRow) });
  });

  router.get("/connections/:id", route((request, response) => {
    response.json({ connection: getConnection(database, routeId(request, "id")) });
  }));

  router.post("/connections", route((request, response) => {
    const connection = parseConnectionInput(request.body, localPort(request));
    response.status(201).json({ connection: insertConnection(database, connection) });
  }));

  router.patch("/connections/:id", route((request, response) => {
    const id = routeId(request, "id");
    const current = getConnection(database, id);
    const input = requiredObject(request.body, "Connection update");
    const connection = parseConnectionInput({ ...current, ...input }, localPort(request));
    const updatedAt = new Date().toISOString();
    database.prepare(`
      UPDATE connections SET
        name = ?, system_type = ?, environment = ?, base_url = ?, auth_type = ?,
        secret_ref = ?, headers_json = ?, timeout_ms = ?, max_concurrency = ?,
        enabled = ?, updated_at = ?
      WHERE id = ?
    `).run(
      connection.name,
      connection.systemType,
      connection.environment,
      connection.baseUrl,
      connection.authType,
      connection.secretRef ?? null,
      JSON.stringify(connection.headers),
      connection.timeoutMs,
      connection.maxConcurrency,
      connection.enabled ? 1 : 0,
      updatedAt,
      id,
    );
    response.json({ connection: getConnection(database, id) });
  }));

  router.delete("/connections/:id", route((request, response) => {
    const id = routeId(request, "id");
    getConnection(database, id);
    const used = database.prepare("SELECT 1 FROM test_runs WHERE connection_id = ? LIMIT 1").get(id);
    if (used) throw new HttpError(409, "CONNECTION_IN_USE", "A connection referenced by a test run cannot be deleted.");
    database.prepare("DELETE FROM connections WHERE id = ?").run(id);
    response.status(204).end();
  }));

  router.post("/connections/:id/check", route(async (request, response) => {
    const connection = getConnection(database, routeId(request, "id"));
    if (!connection.enabled) throw new HttpError(409, "CONNECTION_DISABLED", "Enable the connection before checking it.");
    const headers = resolveAuthHeaders(connection);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort("timeout"), Math.min(connection.timeoutMs, 5_000));
    const started = Date.now();
    try {
      const target = new URL(`${connection.baseUrl}/`);
      const result = await fetch(target, { method: "GET", headers, redirect: "manual", signal: controller.signal });
      if (result.status < 200 || result.status >= 300) {
        throw new HttpError(502, "CONNECTION_CHECK_FAILED", `The local mock service returned HTTP ${result.status}.`);
      }
      response.json({ ok: true, status: result.status, latencyMs: Date.now() - started });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (controller.signal.aborted) {
        throw new HttpError(504, "CONNECTION_CHECK_TIMEOUT", "The local mock service did not respond before the timeout.");
      }
      throw new HttpError(502, "CONNECTION_CHECK_FAILED", "The local mock service could not be reached.");
    } finally {
      clearTimeout(timeout);
    }
  }));

  router.get("/test-suites", (_request, response) => {
    const rows = database.prepare(`
      SELECT s.id, v.suite_name AS name, s.current_version, s.created_at, s.updated_at,
        v.id AS version_id, v.cases_json
      FROM test_suites s
      JOIN test_suite_versions v ON v.suite_id = s.id AND v.version = s.current_version
      ORDER BY s.updated_at DESC
    `).all() as SuiteRow[];
    response.json({
      suites: rows.map((row) => ({
        id: row.id,
        name: row.name,
        latestVersion: row.current_version,
        latestVersionId: row.version_id,
        caseCount: (JSON.parse(row.cases_json) as TestCaseDefinition[]).length,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
    });
  });

  router.post("/test-suites", route((request, response) => {
    const input = normalizeSuite(request.body);
    const suite = saveSuiteVersion(database, input);
    response.status(201).json({ suite });
  }));

  router.get("/test-suites/:id", route((request, response) => {
    response.json({ suite: getSuite(database, routeId(request, "id")) });
  }));

  router.get("/test-suites/:id/versions/:version", route((request, response) => {
    const id = routeId(request, "id");
    const version = Number(request.params.version);
    if (!Number.isInteger(version) || version < 1) {
      throw new HttpError(400, "INVALID_SUITE_VERSION", "Suite version must be a positive integer.");
    }
    const row = database.prepare(`
      SELECT s.id, v.suite_name AS name, s.created_at, s.updated_at, v.version, v.id AS version_id, v.cases_json
      FROM test_suites s JOIN test_suite_versions v ON v.suite_id = s.id
      WHERE s.id = ? AND v.version = ?
    `).get(id, version) as {
      id: string;
      name: string;
      created_at: string;
      updated_at: string;
      version: number;
      version_id: string;
      cases_json: string;
    } | undefined;
    if (!row) throw new HttpError(404, "TEST_SUITE_VERSION_NOT_FOUND", `Version ${version} was not found.`);
    response.json({
      suite: {
        id: row.id,
        version: row.version,
        versionId: row.version_id,
        name: row.name,
        cases: JSON.parse(row.cases_json) as TestCaseDefinition[],
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
    });
  }));

  router.patch("/test-suites/:id", route((request, response) => {
    const id = routeId(request, "id");
    const existing = getSuite(database, id);
    const body = requiredObject(request.body, "Test suite update");
    const normalized = normalizeSuite({
      name: body.name ?? existing.name,
      cases: body.cases ?? existing.cases,
    });
    response.json({ suite: saveSuiteVersion(database, normalized, id) });
  }));

  router.post("/test-cases", route((request, response) => {
    const body = requiredObject(request.body, "Test case request");
    const suiteId = typeof body.suiteId === "string" ? body.suiteId : "";
    if (!/^[0-9a-f-]{36}$/i.test(suiteId)) throw new HttpError(400, "INVALID_ID", "suiteId must be a UUID.");
    const existing = getSuite(database, suiteId);
    const normalized = normalizeSuite({ name: existing.name, cases: [...existing.cases, body.testCase] });
    response.status(201).json({ suite: saveSuiteVersion(database, normalized, suiteId) });
  }));

  router.patch("/test-cases/:id", route((request, response) => {
    const caseId = request.params.id;
    if (typeof caseId !== "string" || !/^[A-Za-z0-9_-]{1,60}$/.test(caseId)) {
      throw new HttpError(400, "INVALID_TEST_CASE_ID", "Case ID must use letters, numbers, underscores, and hyphens.");
    }
    const body = requiredObject(request.body, "Test case update");
    const suiteId = typeof body.suiteId === "string" ? body.suiteId : "";
    if (!/^[0-9a-f-]{36}$/i.test(suiteId)) throw new HttpError(400, "INVALID_ID", "suiteId must be a UUID.");
    const existing = getSuite(database, suiteId);
    const caseIndex = existing.cases.findIndex((testCase) => testCase.id === caseId);
    if (caseIndex < 0) throw new HttpError(404, "TEST_CASE_NOT_FOUND", `Case ${caseId} was not found.`);
    const cases = [...existing.cases];
    cases[caseIndex] = body.testCase as TestCaseDefinition;
    const normalized = normalizeSuite({ name: body.name ?? existing.name, cases });
    response.json({ suite: saveSuiteVersion(database, normalized, suiteId) });
  }));

  router.get("/datasets", (_request, response) => {
    response.json({ datasets: datasetService.list() });
  });

  router.get("/test-runs", (_request, response) => {
    response.json({ runs: runService.list() });
  });

  router.post("/test-runs", route((request, response) => {
    const body = requiredObject(request.body, "Test run request");
    const runInput: TestRunInput = {
      suiteId: String(body.suiteId ?? ""),
      connectionId: String(body.connectionId ?? ""),
      datasetId: String(body.datasetId ?? ""),
      ...(body.policyId === undefined ? {} : { policyId: String(body.policyId) }),
    };
    response.status(202).json({ run: runService.create(runInput, localPort(request)) });
  }));

  router.get("/test-runs/:id", route((request, response) => {
    response.json({ run: runService.get(routeId(request, "id")) });
  }));

  router.post("/test-runs/:id/cancel", route((request, response) => {
    response.json({ run: runService.cancel(routeId(request, "id")) });
  }));

  router.get("/test-runs/:id/results", route((request, response) => {
    const id = routeId(request, "id");
    response.json({ runId: id, results: runService.results(id) });
  }));

  router.get("/results/:id", route((request, response) => {
    response.json({ result: runService.result(routeId(request, "id")) });
  }));

  router.get("/test-runs/:id/log", route((request, response) => {
    const id = routeId(request, "id");
    response.download(runService.logFile(id), `${id}.jsonl`, { dotfiles: "allow" });
  }));

  router.post("/demo/load", route((request, response) => {
    const port = localPort(request);
    const connectionInput: ConnectionInput = parseConnectionInput({
      name: "Local Customer MDM Sandbox",
      systemType: "Customer MDM",
      environment: "DEMO",
      baseUrl: `http://127.0.0.1:${port}/api/mock-api`,
      authType: "none",
      headers: {},
      timeoutMs: 5_000,
      maxConcurrency: 1,
      enabled: true,
    }, port);
    const loaded = database.transaction(() => {
      const demoData = loadDemoModelAndProfile(database);
      const savedConnection = database.prepare("SELECT value FROM demo_settings WHERE key = 'demo_connection_id'").get() as { value: string } | undefined;
      const connectionRow = savedConnection
        ? database.prepare("SELECT * FROM connections WHERE id = ?").get(savedConnection.value) as ConnectionRow | undefined
        : undefined;
      const currentConnection = connectionRow ? connectionFromRow(connectionRow) : undefined;
      const connection = currentConnection
        ? (sameConnection(currentConnection, connectionInput) ? currentConnection : updateConnection(database, currentConnection.id, connectionInput))
        : insertConnection(database, connectionInput);
      database.prepare("INSERT OR REPLACE INTO demo_settings (key, value) VALUES ('demo_connection_id', ?)").run(connection.id);

      const savedSuite = database.prepare("SELECT value FROM demo_settings WHERE key = 'demo_suite_id'").get() as { value: string } | undefined;
      const suiteRow = savedSuite ? database.prepare("SELECT id FROM test_suites WHERE id = ?").get(savedSuite.value) as { id: string } | undefined : undefined;
      const demoSuite = normalizeSuite({ name: demoSuiteName, cases: demoTestCases });
      const currentSuite = suiteRow ? getSuite(database, suiteRow.id) : undefined;
      const suite = currentSuite
        ? (sameCases(currentSuite.cases, demoSuite.cases) && currentSuite.name === demoSuite.name
          ? currentSuite
          : saveSuiteVersion(database, demoSuite, currentSuite.id))
        : saveSuiteVersion(database, demoSuite);
      database.prepare("INSERT OR REPLACE INTO demo_settings (key, value) VALUES ('demo_suite_id', ?)").run(suite.id);
      return { ...demoData, connection, suite, policy: getPolicy(database, "default-demo", "DEMO") };
    })();
    response.json(loaded);
  }));

  router.post("/demo/reset", route((_request, response) => {
    resetMockData(database);
    response.json({ reset: true });
  }));

  router.use((error: unknown, _request: Request, response: Response, next: NextFunction) => {
    if (response.headersSent) {
      next(error);
      return;
    }
    if (error instanceof HttpError) {
      response.status(error.status).json({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
      });
      return;
    }
    next(error);
  });

  return router;
}

function localPort(request: Request): number {
  const port = request.socket.localPort;
  if (!port) throw new HttpError(400, "LOCAL_PORT_UNAVAILABLE", "Cannot determine the local API port.");
  return port;
}

function getConnection(database: Database.Database, id: string): SystemConnection {
  const row = database.prepare("SELECT * FROM connections WHERE id = ?").get(id) as ConnectionRow | undefined;
  if (!row) throw new HttpError(404, "CONNECTION_NOT_FOUND", `Connection ${id} was not found.`);
  return connectionFromRow(row);
}

function insertConnection(database: Database.Database, input: ConnectionInput): SystemConnection {
  const id = randomUUID();
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO connections (
      id, name, system_type, environment, base_url, auth_type, secret_ref,
      headers_json, timeout_ms, max_concurrency, enabled, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, input.name, input.systemType, input.environment, input.baseUrl, input.authType,
    input.secretRef ?? null, JSON.stringify(input.headers), input.timeoutMs, input.maxConcurrency,
    input.enabled ? 1 : 0, now, now,
  );
  return getConnection(database, id);
}

function updateConnection(database: Database.Database, id: string, input: ConnectionInput): SystemConnection {
  getConnection(database, id);
  database.prepare(`
    UPDATE connections SET
      name = ?, system_type = ?, environment = ?, base_url = ?, auth_type = ?,
      secret_ref = ?, headers_json = ?, timeout_ms = ?, max_concurrency = ?,
      enabled = ?, updated_at = ?
    WHERE id = ?
  `).run(
    input.name, input.systemType, input.environment, input.baseUrl, input.authType,
    input.secretRef ?? null, JSON.stringify(input.headers), input.timeoutMs, input.maxConcurrency,
    input.enabled ? 1 : 0, new Date().toISOString(), id,
  );
  return getConnection(database, id);
}

export function getSuite(database: Database.Database, id: string): TestSuite {
  const row = database.prepare(`
    SELECT s.id, v.suite_name AS name, s.current_version, s.created_at, s.updated_at,
      v.id AS version_id, v.cases_json
    FROM test_suites s
    JOIN test_suite_versions v ON v.suite_id = s.id AND v.version = s.current_version
    WHERE s.id = ?
  `).get(id) as SuiteRow | undefined;
  if (!row) throw new HttpError(404, "TEST_SUITE_NOT_FOUND", `Test suite ${id} was not found.`);
  return toSuite(row);
}

function saveSuiteVersion(database: Database.Database, input: TestSuiteInput, suiteId?: string): TestSuite {
  const normalized = normalizeSuite(input);
  topologicalCases(normalized.cases);
  const now = new Date().toISOString();
  const id = suiteId ?? randomUUID();
  const save = database.transaction(() => {
    const existing = database.prepare("SELECT current_version FROM test_suites WHERE id = ?").get(id) as
      { current_version: number } | undefined;
    const version = existing ? existing.current_version + 1 : 1;
    if (existing) {
      database.prepare("UPDATE test_suites SET name = ?, current_version = ?, updated_at = ? WHERE id = ?")
        .run(normalized.name, version, now, id);
    } else {
      database.prepare("INSERT INTO test_suites (id, name, current_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
        .run(id, normalized.name, version, now, now);
    }
    const versionId = randomUUID();
    database.prepare(`
      INSERT INTO test_suite_versions (id, suite_id, version, suite_name, cases_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(versionId, id, version, normalized.name, JSON.stringify(normalized.cases), now);
    const insertCase = database.prepare(`
      INSERT INTO test_cases (suite_version_id, case_key, case_json, position)
      VALUES (?, ?, ?, ?)
    `);
    normalized.cases.forEach((testCase, index) => insertCase.run(versionId, testCase.id, JSON.stringify(testCase), index));
  });
  save();
  return getSuite(database, id);
}

function sameCases(left: TestCaseDefinition[], right: TestCaseDefinition[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameConnection(current: SystemConnection, input: ConnectionInput): boolean {
  const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...settings } = current;
  return JSON.stringify(settings) === JSON.stringify(input);
}
