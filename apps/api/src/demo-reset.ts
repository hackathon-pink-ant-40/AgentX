import type Database from "better-sqlite3";
import { HttpError } from "./http-error.js";

export function resetMockData(database: Database.Database): void {
  database.transaction(() => {
    if (database.prepare("SELECT 1 FROM test_runs WHERE status IN ('QUEUED', 'RUNNING') LIMIT 1").get()) {
      throw new HttpError(409, "RUN_IN_PROGRESS", "Wait for all runs to finish before resetting the mock data.");
    }
    database.prepare("DELETE FROM addresses").run();
    database.prepare("DELETE FROM customers").run();
  }).immediate();
}
