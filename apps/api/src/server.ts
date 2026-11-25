import { createApp } from "./app.js";
import { openDatabase } from "./database.js";
import { DatasetService } from "./dataset-service.js";
import { loadLocalEnvironment } from "./env.js";
import { TestRunService } from "./test-runner.js";

loadLocalEnvironment();
const port = Number(process.env.PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be a valid TCP port between 1 and 65535");
}

const database = openDatabase();
const datasetService = new DatasetService(database);
datasetService.recoverIncompleteExports();
const testRunService = new TestRunService(database, datasetService);
testRunService.recoverInterruptedRuns();
const server = createApp(database, datasetService, testRunService).listen(port, "127.0.0.1", () => {
  console.log(`TestAgent AI API listening at http://127.0.0.1:${port}`);
});

function shutdown(): void {
  server.close(() => {
    database.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
