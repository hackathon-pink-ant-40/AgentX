import { openDatabase } from "./database.js";
import { loadLocalEnvironment } from "./env.js";

loadLocalEnvironment();
const database = openDatabase();
const reset = database.transaction(() => {
  database.prepare("DELETE FROM addresses").run();
  database.prepare("DELETE FROM customers").run();
});

try {
  reset();
  console.log("Demo Customer MDM records were cleared.");
} finally {
  database.close();
}
