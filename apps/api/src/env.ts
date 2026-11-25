import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const environmentFile = resolve(projectRoot, ".env");

export function loadLocalEnvironment(): void {
  if (existsSync(environmentFile)) {
    process.loadEnvFile(environmentFile);
  }
}
