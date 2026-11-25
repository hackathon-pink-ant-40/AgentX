import { openDatabase } from "./database.js";
import { loadLocalEnvironment } from "./env.js";
import { resetMockData } from "./demo-reset.js";

loadLocalEnvironment();
const database = openDatabase();
try {
  resetMockData(database);
  console.log("Demo Customer MDM records were cleared.");
} finally {
  database.close();
}
