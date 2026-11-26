import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrateResultStatus } from "./result-status-migration.js";

describe("result status migration", () => {
  it("preserves historical results, dependent evidence, indexes, and foreign keys", () => {
    const database = new Database(":memory:");
    try {
      database.pragma("foreign_keys = ON");
      database.exec(`
        CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
        CREATE TABLE test_results (id TEXT PRIMARY KEY, status TEXT NOT NULL
          CHECK (status IN ('PASS', 'FAIL', 'ERROR', 'BLOCKED', 'CANCELLED')));
        CREATE INDEX result_status_idx ON test_results(status);
        CREATE TABLE evidence (id TEXT PRIMARY KEY, result_id TEXT REFERENCES test_results(id) ON DELETE CASCADE);
        INSERT INTO test_results VALUES ('historic', 'PASS');
        INSERT INTO evidence VALUES ('evidence', 'historic');
      `);
      migrateResultStatus(database);
      expect(database.prepare("SELECT * FROM test_results").all()).toEqual([{ id: "historic", status: "PASS" }]);
      expect(database.prepare("SELECT * FROM evidence").all()).toEqual([{ id: "evidence", result_id: "historic" }]);
      expect(database.prepare("SELECT name FROM sqlite_master WHERE name = 'result_status_idx'").get()).toBeDefined();
      expect(database.pragma("foreign_key_check")).toEqual([]);
      expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
      database.prepare("INSERT INTO test_results VALUES (?, ?)").run("active", "RUNNING");
      expect(database.prepare("SELECT version FROM schema_migrations").get()).toEqual({ version: 7 });
    } finally {
      database.close();
    }
  });

  it("leaves an unrecognized schema untouched", () => {
    const database = new Database(":memory:");
    try {
      database.pragma("foreign_keys = ON");
      database.exec(`
        CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
        CREATE TABLE test_results (id TEXT PRIMARY KEY, status TEXT);
        INSERT INTO test_results VALUES ('historic', 'PASS');
      `);
      expect(() => migrateResultStatus(database)).toThrow("unrecognized test_results status constraint");
      expect(database.prepare("SELECT * FROM test_results").all()).toEqual([{ id: "historic", status: "PASS" }]);
      expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
    } finally {
      database.close();
    }
  });
});
