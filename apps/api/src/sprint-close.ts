import type Database from "better-sqlite3";
import type { SprintCloseEvent, SprintCloseInput, SystemConnection, TestCaseDefinition } from "@agentx/shared";
import { Router, type ErrorRequestHandler } from "express";
import { gateForRun, getPolicy } from "./analytics.js";
import { DatasetService } from "./dataset-service.js";
import { getSuite } from "./execution-api.js";
import { HttpError } from "./http-error.js";
import { getProfile } from "./models-api.js";
import { connectionFromRow, validateMockBaseUrl } from "./test-safety.js";
import { TestRunService } from "./test-runner.js";

interface SprintRow {
  id: string;
  input_json: string;
  status: SprintCloseEvent["status"];
  gaps_json: string;
  dataset_id: string | null;
  run_id: string | null;
  decision: "GO" | "NO-GO" | null;
  error: string | null;
  created_at: string;
  completed_at: string | null;
}

interface ConnectionRow {
  id: string; name: string; system_type: string; environment: SystemConnection["environment"];
  base_url: string; auth_type: SystemConnection["authType"]; secret_ref: string | null;
  headers_json: string; timeout_ms: number; max_concurrency: number; enabled: number;
  created_at: string; updated_at: string;
}

export interface TestMappingProvider {
  missing(workItems: string[], cases: TestCaseDefinition[]): string[];
}

export const localSuiteMappings: TestMappingProvider = {
  missing: (workItems, cases) => workItems.filter((item) => !cases.some((testCase) => testCase.pbi === item)),
};

function inputString(value: unknown, label: string, maximum = 100): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) {
    throw new HttpError(400, "INVALID_SPRINT_EVENT", `${label} must be a non-empty string of at most ${maximum} characters.`);
  }
  return value.trim();
}

function parseInput(value: unknown): SprintCloseInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, "INVALID_SPRINT_EVENT", "Sprint event must be a JSON object.");
  }
  const body = value as Record<string, unknown>;
  const eventId = inputString(body.eventId, "eventId");
  if (!/^[A-Za-z0-9_-]+$/.test(eventId)) throw new HttpError(400, "INVALID_SPRINT_EVENT", "eventId may contain only letters, numbers, underscores, and hyphens.");
  if (!Array.isArray(body.workItems) || body.workItems.length === 0 || body.workItems.length > 100) {
    throw new HttpError(400, "INVALID_SPRINT_EVENT", "Provide between 1 and 100 work item IDs.");
  }
  const workItems = [...new Set(body.workItems.map((item) => inputString(item, "work item", 200)))].sort();
  return {
    eventId, sprintId: inputString(body.sprintId, "sprintId"), workItems,
    profileId: inputString(body.profileId, "profileId"), suiteId: inputString(body.suiteId, "suiteId"),
    connectionId: inputString(body.connectionId, "connectionId"), policyId: inputString(body.policyId, "policyId"),
  };
}

export function getSprintEvent(database: Database.Database, id: string): SprintCloseEvent {
  let row = database.prepare("SELECT * FROM sprint_events WHERE id = ?").get(id) as SprintRow | undefined;
  if (!row) throw new HttpError(404, "SPRINT_EVENT_NOT_FOUND", `Sprint event ${id} was not found.`);
  let gate;
  if (row.run_id) {
    gate = gateForRun(database, row.run_id);
    if (gate.decision !== "PENDING" && row.status === "RUNNING") {
      database.prepare("UPDATE sprint_events SET status = 'COMPLETED', decision = ?, completed_at = ? WHERE id = ? AND status = 'RUNNING'")
        .run(gate.decision, gate.evaluatedAt ?? new Date().toISOString(), id);
      row = database.prepare("SELECT * FROM sprint_events WHERE id = ?").get(id) as SprintRow;
    }
  }
  return {
    input: JSON.parse(row.input_json) as SprintCloseInput,
    status: row.status, gaps: JSON.parse(row.gaps_json) as string[],
    ...(row.dataset_id ? { datasetId: row.dataset_id } : {}),
    ...(row.run_id ? { runId: row.run_id } : {}),
    ...(row.decision ? { decision: row.decision } : {}),
    ...(gate ? { gate } : {}),
    ...(row.error ? { error: row.error } : {}),
    createdAt: row.created_at, ...(row.completed_at ? { completedAt: row.completed_at } : {}),
  };
}

export function recoverSprintEvents(database: Database.Database): void {
  database.prepare(`UPDATE sprint_events SET status = 'ERROR', error = ?, completed_at = ?
    WHERE status = 'CREATING'`).run("API restarted while the event was being created. Use a new event ID to retry.", new Date().toISOString());
  const rows = database.prepare("SELECT id FROM sprint_events WHERE status = 'RUNNING'").all() as Array<{ id: string }>;
  for (const row of rows) getSprintEvent(database, row.id);
}

export function createSprintRouter(database: Database.Database, datasetService: DatasetService, runService: TestRunService): Router {
  const router = Router();
  router.get("/sprint-events/:id", (request, response) => response.json({ event: getSprintEvent(database, request.params.id) }));
  router.post("/sprint-events", (request, response) => {
    const input = parseInput(request.body);
    const previous = database.prepare("SELECT input_json FROM sprint_events WHERE id = ?").get(input.eventId) as { input_json: string } | undefined;
    if (previous) {
      if (previous.input_json !== JSON.stringify(input)) throw new HttpError(409, "SPRINT_EVENT_CONFLICT", "This event ID was already used with different input.");
      response.json({ event: getSprintEvent(database, input.eventId) });
      return;
    }
    const port = request.socket.localPort;
    if (!port) throw new HttpError(400, "LOCAL_PORT_UNAVAILABLE", "Cannot determine the local API port.");
    const suite = getSuite(database, input.suiteId);
    const profile = getProfile(database, input.profileId);
    const connectionRow = database.prepare("SELECT * FROM connections WHERE id = ?").get(input.connectionId) as ConnectionRow | undefined;
    if (!connectionRow) throw new HttpError(404, "CONNECTION_NOT_FOUND", `Connection ${input.connectionId} was not found.`);
    const connection = connectionFromRow(connectionRow);
    if (!connection.enabled) throw new HttpError(409, "CONNECTION_DISABLED", "Enable the connection before starting an event.");
    validateMockBaseUrl(connection.baseUrl, port);
    getPolicy(database, input.policyId, connection.environment);
    const gaps = localSuiteMappings.missing(input.workItems, suite.cases);
    const now = new Date().toISOString();
    database.prepare(`INSERT INTO sprint_events (id, input_json, status, gaps_json, decision, created_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(input.eventId, JSON.stringify(input), gaps.length ? "MAPPING_GAPS" : "CREATING",
      JSON.stringify(gaps), gaps.length ? "NO-GO" : null, now, gaps.length ? now : null);
    if (gaps.length) {
      response.status(201).json({ event: getSprintEvent(database, input.eventId) });
      return;
    }
    try {
      const dataset = datasetService.create(profile, `Sprint ${input.sprintId}`.slice(0, 100));
      database.prepare("UPDATE sprint_events SET dataset_id = ? WHERE id = ?").run(dataset.id, input.eventId);
      database.transaction(() => {
        const run = runService.create({ suiteId: input.suiteId, connectionId: input.connectionId, datasetId: dataset.id, policyId: input.policyId }, port);
        database.prepare("UPDATE sprint_events SET run_id = ?, status = 'RUNNING' WHERE id = ? AND status = 'CREATING'").run(run.id, input.eventId);
      })();
      response.status(202).json({ event: getSprintEvent(database, input.eventId) });
    } catch (error) {
      database.prepare("UPDATE sprint_events SET status = 'ERROR', error = ?, completed_at = ? WHERE id = ? AND status = 'CREATING'")
        .run(error instanceof Error ? error.message.slice(0, 500) : "Sprint event failed.", new Date().toISOString(), input.eventId);
      throw error;
    }
  });
  const errorHandler: ErrorRequestHandler = (error: unknown, _request, response, next) => {
    if (error instanceof HttpError && !response.headersSent) {
      response.status(error.status).json({ error: { code: error.code, message: error.message } });
      return;
    }
    next(error);
  };
  router.use(errorHandler);
  return router;
}
