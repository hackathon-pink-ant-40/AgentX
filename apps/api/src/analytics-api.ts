import type Database from "better-sqlite3";
import { Router, type Request, type Response, type NextFunction } from "express";
import { filteredResults, gateForRun, localWorkItems, listPolicies, metricsForRun, savePolicy, type ResultFilters } from "./analytics.js";
import { HttpError } from "./http-error.js";
import { redact } from "./test-safety.js";
import type { TestRunService } from "./test-runner.js";

function text(value: unknown): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || value.length > 200) throw new HttpError(400, "INVALID_FILTER", "Filter values must be strings of at most 200 characters.");
  return value;
}

function pagination(request: Request): { page: number; pageSize: number } {
  const page = Number(request.query.page ?? 1);
  const pageSize = Number(request.query.pageSize ?? 25);
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new HttpError(400, "INVALID_PAGINATION", "Page must be positive and pageSize must be between 1 and 100.");
  }
  return { page, pageSize };
}

function resultFilters(request: Request): ResultFilters {
  return {
    entity: text(request.query.entity), operation: text(request.query.operation),
    status: text(request.query.status), caseId: text(request.query.caseId),
    pbi: text(request.query.pbi), search: text(request.query.search),
  };
}

export function createAnalyticsRouter(database: Database.Database, runService: TestRunService): Router {
  const router = Router();

  router.get("/release-policies", (_request, response) => response.json({ policies: listPolicies(database) }));
  router.post("/release-policies", (request, response) => response.status(201).json({ policy: savePolicy(database, request.body) }));
  router.put("/release-policies/:id", (request, response) => response.json({ policy: savePolicy(database, request.body, request.params.id) }));

  router.get("/analytics/runs", (request, response) => {
    const { page, pageSize } = pagination(request);
    const clauses: string[] = [];
    const values: string[] = [];
    for (const [key, sql] of [
      ["datasetId", "r.dataset_id = ?"], ["environment", "json_extract(r.snapshot_json, '$.connection.environment') = ?"],
      ["from", "r.created_at >= ?"], ["to", "substr(r.created_at, 1, 10) <= ?"],
    ] as const) {
      const value = text(request.query[key]);
      if (value) { clauses.push(sql); values.push(value); }
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const total = (database.prepare(`SELECT COUNT(*) AS count FROM test_runs r ${where}`).get(...values) as { count: number }).count;
    const rows = database.prepare(`SELECT r.id, r.dataset_id, r.status, r.created_at,
      json_extract(r.snapshot_json, '$.connection.environment') AS environment,
      json_extract(r.snapshot_json, '$.suite.name') AS suite_name
      FROM test_runs r ${where} ORDER BY r.created_at DESC LIMIT ? OFFSET ?`)
      .all(...values, pageSize, (page - 1) * pageSize) as Array<{
        id: string; dataset_id: string; status: string; created_at: string; environment: string; suite_name: string;
      }>;
    const filters = resultFilters(request);
    response.json({ total, page, pageSize, runs: rows.map((row) => ({
      id: row.id, datasetId: row.dataset_id, status: row.status, createdAt: row.created_at,
      environment: row.environment, suiteName: row.suite_name, metrics: metricsForRun(database, row.id, filters),
      decision: gateForRun(database, row.id).decision,
    })) });
  });

  router.get("/analytics/runs/:id", (request, response) => {
    const id = request.params.id;
    const filters = resultFilters(request);
    const rows = filteredResults(database, id, filters);
    const groups = (key: "entity" | "operation") => {
      const grouped = new Map<string, Record<string, number>>();
      for (const row of rows) {
        const counts = grouped.get(row[key]) ?? {};
        counts[row.status] = (counts[row.status] ?? 0) + 1;
        grouped.set(row[key], counts);
      }
      return [...grouped].map(([name, counts]) => ({ name, counts }));
    };
    response.json({ metrics: metricsForRun(database, id, filters), gate: gateForRun(database, id),
      entityGroups: groups("entity"), operationGroups: groups("operation") });
  });

  router.get("/analytics/runs/:id/results", (request, response) => {
    const { page, pageSize } = pagination(request);
    const rows = filteredResults(database, request.params.id, resultFilters(request));
    response.json({ total: rows.length, page, pageSize,
      results: rows.slice((page - 1) * pageSize, page * pageSize).map((row) => runService.result(row.id)) });
  });

  router.get("/analytics/results/:id", (request, response) => {
    const result = runService.result(request.params.id);
    const row = database.prepare(`SELECT r.dataset_id, t.input_json FROM test_results t
      JOIN test_runs r ON r.id = t.run_id WHERE t.id = ?`).get(result.id) as { dataset_id: string; input_json: string };
    const source = database.prepare(`SELECT record_id, entity_name, business_id, payload_json, scenario_id, expected_valid,
      reason, source_record_id, parent_record_id, created_at FROM synthetic_records
      WHERE dataset_id = ? AND record_id = ?`).get(row.dataset_id, result.inputRecordId) as Record<string, unknown> | undefined;
    const run = database.prepare("SELECT snapshot_json FROM test_runs WHERE id = ?").get(result.runId) as { snapshot_json: string };
    const snapshot = JSON.parse(run.snapshot_json) as { suite: { cases: Array<{ id: string; steps: Array<{ id: string; expectedStatuses: number[] }> }> } };
    const steps = snapshot.suite.cases.find((item) => item.id === result.caseId)?.steps ?? [];
    response.json({ result, datasetId: row.dataset_id, input: JSON.parse(row.input_json) as unknown,
      source: source ? { ...source, payload_json: redact(JSON.parse(String(source.payload_json)) as unknown) } : null,
      expectedStatuses: Object.fromEntries(steps.map((step) => [step.id, step.expectedStatuses])) });
  });

  router.get("/analytics/records", (request, response) => {
    const { page, pageSize } = pagination(request);
    const clauses: string[] = [];
    const values: string[] = [];
    for (const [key, column] of [["datasetId", "dataset_id"], ["entity", "entity_name"]] as const) {
      const value = text(request.query[key]);
      if (value) { clauses.push(`${column} = ?`); values.push(value); }
    }
    const search = text(request.query.search);
    if (search) {
      clauses.push("(record_id LIKE ? ESCAPE '\\' OR COALESCE(business_id, '') LIKE ? ESCAPE '\\' OR payload_json LIKE ? ESCAPE '\\')");
      const term = `%${search.replace(/[\\%_]/g, "\\$&")}%`;
      values.push(term, term, term);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const total = (database.prepare(`SELECT COUNT(*) AS count FROM synthetic_records ${where}`).get(...values) as { count: number }).count;
    const rows = database.prepare(`SELECT dataset_id, record_id, entity_name, business_id, scenario_id, expected_valid, payload_json, created_at
      FROM synthetic_records ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...values, pageSize, (page - 1) * pageSize) as Array<{
        dataset_id: string; record_id: string; entity_name: string; business_id: string | null; scenario_id: string;
        expected_valid: number; payload_json: string; created_at: string;
      }>;
    response.json({ total, page, pageSize, records: rows.map((row) => ({
      datasetId: row.dataset_id, recordId: row.record_id, entity: row.entity_name, businessId: row.business_id,
      scenarioId: row.scenario_id, expectedValid: Boolean(row.expected_valid),
      payload: JSON.parse(row.payload_json) as unknown, createdAt: row.created_at,
    })) });
  });

  router.get("/defects", (_request, response) => response.json({ defects: localWorkItems.list(database) }));
  router.get("/defects/export", (_request, response) => {
    response.setHeader("Content-Disposition", 'attachment; filename="defect-candidates.json"');
    response.json({ exportedAt: new Date().toISOString(), defects: localWorkItems.list(database) });
  });
  router.get("/demo/regression", (_request, response) => {
    const row = database.prepare("SELECT value FROM demo_settings WHERE key = 'regression'").get() as { value: string };
    response.json({ enabled: row.value === "true" });
  });
  router.post("/demo/regression", (request, response) => {
    if (typeof request.body?.enabled !== "boolean") throw new HttpError(400, "INVALID_REGRESSION", "enabled must be a boolean.");
    if (database.prepare("SELECT 1 FROM test_runs WHERE status IN ('QUEUED', 'RUNNING') LIMIT 1").get()) {
      throw new HttpError(409, "RUN_IN_PROGRESS", "Wait for all runs to finish before changing regression mode.");
    }
    database.prepare("UPDATE demo_settings SET value = ? WHERE key = 'regression'").run(String(request.body.enabled));
    response.json({ enabled: request.body.enabled });
  });
  router.use((error: unknown, _request: Request, response: Response, next: NextFunction) => {
    if (error instanceof HttpError && !response.headersSent) {
      response.status(error.status).json({ error: { code: error.code, message: error.message } });
      return;
    }
    next(error);
  });
  return router;
}
