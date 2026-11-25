# TestAgent AI implementation checklist

This checklist tracks the phased build in `MASTER_PROMPT.md`. Mark an item complete only after its behavior is implemented and the relevant check has been run. The application is a local, single-user sandbox; no real customer data, production targets, external AI credentials, or external ticket integrations are used.

## Phase 1 — Foundation

- [x] Establish npm workspaces for the React/TypeScript web app, Express/TypeScript API, and shared contracts.
- [x] Add a versioned SQLite migration, foreign keys, indexes, and app-controlled local database storage.
- [x] Implement the stateful Customer MDM sandbox REST API: create/list/read/update customers, merge and reparent addresses, create/list addresses, and sandbox-confirmed delete.
- [x] Add real API health and record counts; ensure the UI displays data from backend endpoints.
- [x] Build working overview and Mock MDM API navigation and operations; avoid non-functional placeholder screens.
- [x] Add focused API integration tests and root install/dev/build/test/demo-reset commands.
- [x] Document local startup and durable repository conventions.
- [x] Run clean dependency installation, production build, automated tests, live API/UI smoke checks, and correct any failures.

## Phase 2 — Model and synthetic data

- [x] Import canonical JSON, supported JSON Schema, and documented Mermaid ER diagram subsets; reject ambiguity and unsupported constructs clearly.
- [x] Normalize, review, edit, and version immutable data models with explicit key and relationship mappings.
- [x] Add deterministic rule suggestions, editable generation profiles, safe value generation, and preview.
- [x] Generate reproducible customer/address datasets with scenario metadata, constraints, validation, and generation caps.
- [x] Persist dataset snapshots and records transactionally; publish JSON/CSV exports and manifest safely.
- [x] Add dataset search, pagination, sample input files, and focused parser/generator/export tests.

## Phase 3 — Test execution vertical slice

- [x] Configure sandbox connections and versioned suites/cases with explicit expected outcomes and safe templates.
- [x] Implement bounded, cancellable, server-side HTTP execution with dependency handling and deterministic verdict logic.
- [x] Exercise create/update/read-back/merge and negative cases against the bundled mock MDM service.
- [x] Persist run snapshots, step evidence, redacted request/response data, and one JSONL log per run.
- [x] Add focused mapper, executor, assertions, persistence, timeout, cancellation, and integration tests.

## Phase 4 — Analytics and release gates

- [ ] Calculate dashboard and audit metrics from persisted results; add filters and evidence drill-down.
- [ ] Implement versioned release policies and conservative GO/NO-GO decisions from actual final run outcomes.
- [ ] Add the regression toggle, demonstrate actual failed assertions and NO-GO, and persist local defect candidates.
- [ ] Add defect export and focused metrics, policy, regression, audit, and restart-persistence tests.

## Phase 5 — Stretch (only after Phase 4 is green)

- [ ] Add a provider-neutral, idempotent local sprint-close event workflow with surfaced test-mapping gaps.
- [ ] Consider OpenAPI import, optional inference adapters, and CI/work-item interfaces without enabling external actions by default.

## Phase 1 acceptance checks

- [x] `npm ci` completes with the lockfile in sync.
- [x] `npm run build` succeeds for shared contracts, API, and frontend.
- [x] `npm test` passes, including live HTTP request integration tests against an isolated SQLite database.
- [x] `npm run dev` starts the Vite UI and Express service on separate loopback ports.
- [x] The web app loads and obtains backend health and actual customer/address counts.
- [x] Create, read, update, merge/reparent, invalid-address, and sandbox-confirmed delete work over HTTP and persist in SQLite.
- [x] `npm run demo:reset` clears demo records without deleting the database or unrelated files.

## Phase 2 acceptance checks

- [x] `npm run build` succeeds for shared contracts, API, and frontend after Phase 2 integration.
- [x] `npm test` passes all 7 API integration tests (4 Phase 1 and 3 Phase 2).
- [x] Canonical JSON, JSON Schema local references, and Mermaid samples import; model versions and unresolved FK mappings are validated.
- [x] Fixed-seed datasets reproduce record payloads, and generated Address foreign keys resolve to generated Customers.
- [x] All supported negative scenarios produce their declared valid/invalid status; Dutch and English Faker profiles produce localized values.
- [x] JSON/CSV exports, manifest downloads, search, pagination, and interrupted-export recovery pass API integration checks.
- [x] Isolated live smoke test passed on temporary ports 3002/5174: health `ok`, UI HTTP 200, two model entities imported, 10 preview records, dataset `READY`, and 50 stored/exported records.

## Phase 3 acceptance checks

- [x] `npm run build` succeeds for shared contracts, API, and frontend after Phase 3 integration.
- [x] `npm test` passes all 11 API integration tests (4 Phase 1, 3 Phase 2, and 4 Phase 3).
- [x] Connection checks and test execution target only the current API process's loopback mock MDM endpoint; external URLs are rejected.
- [x] Suite/case edits create immutable versions, and the demo connection/suite loader is idempotent.
- [x] Real HTTP run passes Customer insert, update, read-back, merge, address reparenting, duplicate-ID rejection, missing-required rejection, and orphan-address rejection.
- [x] Unexpected negative acceptance and failed assertions produce `FAIL`; request timeouts produce `ERROR`; unmet dependencies produce `BLOCKED`; cancellation produces `CANCELLED`.
- [x] Run snapshots, results, step evidence, counters, and redacted JSONL logs persist across API restart.
- [x] Isolated live smoke passed on API/UI ports 3101/5174: UI HTTP 200, API health `ok`, 3 generated records, 4/4 cases `PASS`, and the run JSONL download returned HTTP 200 with 18 events.

## Deferred beyond Phase 3

Analytics, audit dashboards, release gates, regression controls, defect workflows, and sprint automation remain unimplemented and are tracked above rather than represented as functional-looking placeholder screens.
