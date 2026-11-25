import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const defaultDatabasePath = resolve(projectRoot, "storage/agentx.sqlite");

export function openDatabase(
  databasePath = process.env.AGENTX_DB_PATH
    ? isAbsolute(process.env.AGENTX_DB_PATH)
      ? process.env.AGENTX_DB_PATH
      : resolve(projectRoot, process.env.AGENTX_DB_PATH)
    : defaultDatabasePath,
): Database.Database {
  mkdirSync(dirname(databasePath), { recursive: true });

  const database = new Database(databasePath);
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  migrate(database);
  return database;
}

function migrate(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);

  let currentVersion = database
    .prepare("SELECT MAX(version) AS version FROM schema_migrations")
    .get() as { version: number | null };

  if ((currentVersion.version ?? 0) < 1) {
    const applyInitialMigration = database.transaction(() => {
      database.exec(`
        CREATE TABLE customers (
          customer_id TEXT PRIMARY KEY,
          first_name TEXT NOT NULL,
          last_name TEXT NOT NULL,
          email TEXT,
          status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'INACTIVE', 'PROSPECT')),
          merged_into TEXT REFERENCES customers(customer_id),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX customers_name_idx ON customers(last_name, first_name);

        CREATE TABLE addresses (
          address_id TEXT PRIMARY KEY,
          customer_id TEXT NOT NULL REFERENCES customers(customer_id) ON DELETE CASCADE,
          street TEXT NOT NULL,
          postal_code TEXT NOT NULL,
          country TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE INDEX addresses_customer_idx ON addresses(customer_id);
      `);
      database
        .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
        .run(1, new Date().toISOString());
    });

    applyInitialMigration();
    currentVersion = { version: 1 };
  }

  if ((currentVersion.version ?? 0) < 2) {
    const applyModelAndDataMigration = database.transaction(() => {
      database.exec(`
        CREATE TABLE data_models (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          latest_version INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE model_versions (
          id TEXT PRIMARY KEY,
          model_id TEXT NOT NULL REFERENCES data_models(id) ON DELETE CASCADE,
          version INTEGER NOT NULL,
          source_format TEXT NOT NULL,
          source_text TEXT NOT NULL,
          model_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE (model_id, version)
        );

        CREATE TABLE generation_profiles (
          id TEXT PRIMARY KEY,
          model_version_id TEXT NOT NULL REFERENCES model_versions(id),
          name TEXT NOT NULL,
          settings_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE datasets (
          id TEXT PRIMARY KEY,
          profile_id TEXT NOT NULL REFERENCES generation_profiles(id),
          model_version_id TEXT NOT NULL REFERENCES model_versions(id),
          name TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('GENERATING', 'READY', 'FAILED')),
          seed TEXT NOT NULL,
          locale TEXT NOT NULL,
          reference_date TEXT NOT NULL,
          settings_json TEXT NOT NULL,
          counts_json TEXT NOT NULL,
          manifest_json TEXT,
          error TEXT,
          created_at TEXT NOT NULL,
          completed_at TEXT
        );

        CREATE TABLE synthetic_records (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
          record_id TEXT NOT NULL,
          entity_name TEXT NOT NULL,
          business_id TEXT,
          payload_json TEXT NOT NULL,
          scenario_id TEXT NOT NULL,
          expected_valid INTEGER NOT NULL CHECK (expected_valid IN (0, 1)),
          reason TEXT,
          source_record_id TEXT,
          parent_record_id TEXT,
          created_at TEXT NOT NULL,
          UNIQUE (dataset_id, record_id)
        );

        CREATE INDEX model_versions_model_idx ON model_versions(model_id, version);
        CREATE INDEX generation_profiles_model_idx ON generation_profiles(model_version_id, updated_at);
        CREATE INDEX datasets_status_idx ON datasets(status, created_at);
        CREATE INDEX synthetic_records_dataset_entity_idx ON synthetic_records(dataset_id, entity_name, id);
        CREATE INDEX synthetic_records_dataset_scenario_idx ON synthetic_records(dataset_id, scenario_id, id);
      `);
      database
        .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
        .run(2, new Date().toISOString());
    });

    applyModelAndDataMigration();
    currentVersion = { version: 2 };
  }

  if ((currentVersion.version ?? 0) < 3) {
    const applyExecutionMigration = database.transaction(() => {
      database.exec(`
        CREATE TABLE connections (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          system_type TEXT NOT NULL,
          environment TEXT NOT NULL CHECK (environment IN ('DEMO', 'DEV', 'QA', 'UAT')),
          base_url TEXT NOT NULL,
          auth_type TEXT NOT NULL CHECK (auth_type IN ('none', 'apiKey', 'bearer', 'basic')),
          secret_ref TEXT,
          headers_json TEXT NOT NULL,
          timeout_ms INTEGER NOT NULL,
          max_concurrency INTEGER NOT NULL,
          enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE test_suites (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          current_version INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE test_suite_versions (
          id TEXT PRIMARY KEY,
          suite_id TEXT NOT NULL REFERENCES test_suites(id) ON DELETE CASCADE,
          version INTEGER NOT NULL,
          cases_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE (suite_id, version)
        );

        CREATE TABLE test_cases (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          suite_version_id TEXT NOT NULL REFERENCES test_suite_versions(id) ON DELETE CASCADE,
          case_key TEXT NOT NULL,
          case_json TEXT NOT NULL,
          position INTEGER NOT NULL,
          UNIQUE (suite_version_id, case_key),
          UNIQUE (suite_version_id, position)
        );

        CREATE TABLE test_runs (
          id TEXT PRIMARY KEY,
          suite_id TEXT NOT NULL REFERENCES test_suites(id),
          suite_version_id TEXT NOT NULL REFERENCES test_suite_versions(id),
          connection_id TEXT NOT NULL REFERENCES connections(id),
          dataset_id TEXT NOT NULL REFERENCES datasets(id),
          status TEXT NOT NULL CHECK (status IN ('QUEUED', 'RUNNING', 'COMPLETED', 'CANCELLED', 'ERROR')),
          snapshot_json TEXT NOT NULL,
          counters_json TEXT NOT NULL,
          namespace TEXT NOT NULL,
          cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
          error TEXT,
          log_error TEXT,
          created_at TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT
        );

        CREATE TABLE test_results (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
          case_key TEXT NOT NULL,
          case_name TEXT NOT NULL,
          operation TEXT NOT NULL,
          entity TEXT NOT NULL,
          priority TEXT NOT NULL,
          critical INTEGER NOT NULL CHECK (critical IN (0, 1)),
          expected_outcome TEXT NOT NULL CHECK (expected_outcome IN ('positive', 'negative')),
          input_record_id TEXT NOT NULL,
          scenario_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('RUNNING', 'PASS', 'FAIL', 'ERROR', 'BLOCKED', 'CANCELLED')),
          summary TEXT NOT NULL,
          error TEXT,
          pbi TEXT,
          input_json TEXT NOT NULL,
          correlation_id TEXT NOT NULL,
          started_at TEXT NOT NULL,
          completed_at TEXT NOT NULL,
          duration_ms INTEGER NOT NULL,
          UNIQUE (run_id, case_key, input_record_id)
        );

        CREATE TABLE test_step_results (
          id TEXT PRIMARY KEY,
          result_id TEXT NOT NULL REFERENCES test_results(id) ON DELETE CASCADE,
          run_id TEXT NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
          step_key TEXT NOT NULL,
          step_name TEXT NOT NULL,
          method TEXT NOT NULL,
          url TEXT NOT NULL,
          request_json TEXT,
          response_status INTEGER,
          response_json TEXT,
          response_truncated INTEGER NOT NULL CHECK (response_truncated IN (0, 1)),
          latency_ms INTEGER,
          assertions_json TEXT NOT NULL,
          error TEXT,
          correlation_id TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE INDEX connections_enabled_idx ON connections(enabled, name);
        CREATE INDEX test_suites_updated_idx ON test_suites(updated_at);
        CREATE INDEX test_cases_suite_idx ON test_cases(suite_version_id, position);
        CREATE INDEX test_runs_status_idx ON test_runs(status, created_at);
        CREATE INDEX test_runs_dataset_idx ON test_runs(dataset_id, created_at);
        CREATE INDEX test_results_run_verdict_idx ON test_results(run_id, status, id);
        CREATE INDEX test_results_entity_operation_idx ON test_results(run_id, entity, operation, status);
        CREATE INDEX test_results_case_pbi_idx ON test_results(case_key, pbi);
        CREATE INDEX test_step_results_run_idx ON test_step_results(run_id, created_at);
      `);
      database.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
        .run(3, new Date().toISOString());
    });
    applyExecutionMigration();
    currentVersion = { version: 3 };
  }

  if ((currentVersion.version ?? 0) < 4) {
    const applySuiteNameMigration = database.transaction(() => {
      database.exec(`
        ALTER TABLE test_suite_versions
          ADD COLUMN suite_name TEXT NOT NULL DEFAULT '';
        UPDATE test_suite_versions
          SET suite_name = (
            SELECT name FROM test_suites WHERE test_suites.id = test_suite_versions.suite_id
          )
          WHERE suite_name = '';
      `);
      database.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
        .run(4, new Date().toISOString());
    });
    applySuiteNameMigration();
    currentVersion = { version: 4 };
  }

  if ((currentVersion.version ?? 0) < 5) {
    const applyAnalyticsMigration = database.transaction(() => {
      database.exec(`
        CREATE TABLE release_policies (
          id TEXT NOT NULL, version INTEGER NOT NULL, name TEXT NOT NULL,
          environment TEXT NOT NULL, settings_json TEXT NOT NULL, created_at TEXT NOT NULL,
          PRIMARY KEY (id, version)
        );
        CREATE TABLE gate_decisions (
          run_id TEXT PRIMARY KEY REFERENCES test_runs(id),
          policy_json TEXT, decision TEXT NOT NULL, reasons_json TEXT NOT NULL,
          metrics_json TEXT NOT NULL, evaluated_at TEXT NOT NULL
        );
        CREATE TABLE defect_candidates (
          id TEXT PRIMARY KEY, signature TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
          severity TEXT NOT NULL, environment TEXT NOT NULL, case_key TEXT NOT NULL,
          pbi TEXT, category TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE defect_occurrences (
          id TEXT PRIMARY KEY, defect_id TEXT NOT NULL REFERENCES defect_candidates(id),
          result_id TEXT NOT NULL UNIQUE REFERENCES test_results(id),
          run_id TEXT NOT NULL REFERENCES test_runs(id), record_id TEXT NOT NULL,
          evidence_json TEXT NOT NULL, observed_at TEXT NOT NULL
        );
        CREATE INDEX defect_occurrences_defect_idx ON defect_occurrences(defect_id, observed_at);
        CREATE TABLE demo_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO demo_settings (key, value) VALUES ('regression', 'false');
        ALTER TABLE test_runs ADD COLUMN policy_json TEXT;
      `);
      const insert = database.prepare(`
        INSERT INTO release_policies (id, version, name, environment, settings_json, created_at)
        VALUES (?, 1, ?, ?, ?, ?)
      `);
      const now = new Date().toISOString();
      for (const environment of ["DEMO", "DEV", "QA", "UAT"]) {
        insert.run(`default-${environment.toLowerCase()}`, `Default ${environment} policy`, environment,
          JSON.stringify({ passThreshold: 80, minimumCoverage: 100, maxCriticalFailures: 0, allowErrors: false, allowBlocked: false }), now);
      }
      database.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(5, now);
    });
    applyAnalyticsMigration();
  }
}
