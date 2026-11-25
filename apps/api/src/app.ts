import type Database from "better-sqlite3";
import type { HealthResponse } from "@agentx/shared";
import express, { type ErrorRequestHandler } from "express";
import { DatasetService } from "./dataset-service.js";
import { createExecutionApiRouter } from "./execution-api.js";
import { createMockMdmRouter } from "./mock-mdm.js";
import { createModelsApiRouter } from "./models-api.js";
import { TestRunService } from "./test-runner.js";

export function createApp(
  database: Database.Database,
  datasetService = new DatasetService(database),
  testRunService = new TestRunService(database, datasetService),
) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  app.get("/api/health", (_request, response) => {
    const counts = database
      .prepare(`
        SELECT
          (SELECT COUNT(*) FROM customers) AS customers,
          (SELECT COUNT(*) FROM addresses) AS addresses
      `)
      .get() as { customers: number; addresses: number };
    const health: HealthResponse = {
      status: "ok",
      service: "testagent-api",
      database: "connected",
      counts,
    };
    response.json(health);
  });

  app.use("/api/mock-api", createMockMdmRouter(database));
  app.use("/api", createModelsApiRouter(database, datasetService));
  app.use("/api", createExecutionApiRouter(database, datasetService, testRunService));
  app.use("/api", (_request, response) => {
    response.status(404).json({
      error: { code: "NOT_FOUND", message: "API endpoint was not found" },
    });
  });

  const errorHandler: ErrorRequestHandler = (error: unknown, _request, response, next) => {
    if (response.headersSent) {
      next(error);
      return;
    }
    if (error instanceof SyntaxError && "body" in error) {
      response.status(400).json({
        error: { code: "INVALID_JSON", message: "Request body must contain valid JSON" },
      });
      return;
    }
    console.error("Unhandled API error", error);
    response.status(500).json({
      error: { code: "INTERNAL_ERROR", message: "An unexpected server error occurred" },
    });
  };
  app.use(errorHandler);

  return app;
}
