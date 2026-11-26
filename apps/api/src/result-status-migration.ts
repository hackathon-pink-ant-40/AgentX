import type Database from "better-sqlite3";

export function migrateResultStatus(database: Database.Database): void {
  const table = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'test_results'")
    .get() as { sql: string } | undefined;
  if (!table) throw new Error("Cannot migrate result status: test_results table is missing.");

  const legacyCheck = /CHECK\s*\(\s*status\s+IN\s*\(\s*'PASS'\s*,\s*'FAIL'\s*,\s*'ERROR'\s*,\s*'BLOCKED'\s*,\s*'CANCELLED'\s*\)\s*\)/i;
  const currentCheck = /CHECK\s*\(\s*status\s+IN\s*\(\s*'RUNNING'\s*,\s*'PASS'\s*,\s*'FAIL'\s*,\s*'ERROR'\s*,\s*'BLOCKED'\s*,\s*'CANCELLED'\s*\)\s*\)/i;
  const legacy = legacyCheck.test(table.sql);
  if (!legacy && !currentCheck.test(table.sql)) {
    throw new Error("Cannot migrate result status: unrecognized test_results status constraint.");
  }

  const objects = database.prepare(`
    SELECT sql FROM sqlite_master
    WHERE tbl_name = 'test_results' AND type IN ('index', 'trigger') AND sql IS NOT NULL
    ORDER BY type, name
  `).all() as Array<{ sql: string }>;

  database.pragma("foreign_keys = OFF");
  try {
    database.transaction(() => {
      if (legacy) {
        const createSql = table.sql
          .replace(/^CREATE\s+TABLE\s+test_results\b/i, "CREATE TABLE test_results_migration_v7")
          .replace(legacyCheck, "CHECK (status IN ('RUNNING', 'PASS', 'FAIL', 'ERROR', 'BLOCKED', 'CANCELLED'))");
        if (createSql === table.sql || !createSql.startsWith("CREATE TABLE test_results_migration_v7")) {
          throw new Error("Cannot migrate result status: unrecognized test_results table definition.");
        }
        database.exec(createSql);
        database.exec(`
          INSERT INTO test_results_migration_v7 SELECT * FROM test_results;
          DROP TABLE test_results;
          ALTER TABLE test_results_migration_v7 RENAME TO test_results;
        `);
        for (const object of objects) database.exec(object.sql);
        if (database.prepare("PRAGMA foreign_key_check").get()) {
          throw new Error("Cannot migrate result status: foreign key integrity check failed.");
        }
      }
      database.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
        .run(7, new Date().toISOString());
    })();
  } finally {
    database.pragma("foreign_keys = ON");
  }
}
