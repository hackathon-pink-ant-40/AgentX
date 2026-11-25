# AgentX

AgentX is a local-first workbench for synthetic data and REST API quality. It contains a React/TypeScript UI, an Express API, shared TypeScript contracts, a migrated SQLite database, a stateful Customer MDM sandbox API, and a versioned API test execution workflow. It runs locally and does not require external services.

## Requirements

- Node.js 22.18 or newer
- npm 10 or newer

## Start on Windows

From the repository root in PowerShell:

```powershell
npm.cmd install
npm.cmd run dev
```

Open the UI at [http://127.0.0.1:5173](http://127.0.0.1:5173). The API listens at [http://127.0.0.1:3001](http://127.0.0.1:3001). The browser calls the API through Vite's `/api` proxy. Stop both development processes with Ctrl+C.

Optional: copy `.env.example` to `.env` in the repository root to configure the API port, local SQLite path, dataset export directory, JSONL run-log directory, or Vite proxy target. The API loads the root `.env` file when present.

## Verify and reset

```powershell
npm.cmd run build
npm.cmd test
npm.cmd run demo:reset
```

`demo:reset` removes mock customers and addresses. It does not erase runs, datasets, configuration, or the regression setting and refuses to reset while a run is active. The SQLite database is created under `storage/agentx.sqlite`; generated dataset exports are stored under `storage/datasets`; per-run JSONL evidence is stored under `storage/logs`. These are local runtime data and ignored by Git. Relative `AGENTX_DB_PATH`, `AGENTX_STORAGE_DIR`, and `AGENTX_LOG_DIR` paths are resolved from the repository root.

## Demo walkthrough

1. On **Test configuration**, select **Load demo configuration**. This creates a Customer/Address model, generation profile, connection, acceptance suite, and release policy without creating results. Repeated loading reuses these demo-owned resources and does not overwrite unrelated configurations. It preserves edits to the demo profile and policy; it restores the demo connection and suite to their template.
2. On **Synthetic data**, select the demo profile, preview it, and generate a READY dataset. The default profile generates 20 Customers and 30 Addresses and includes the `orphan_fk` negative scenario. Save profile edits before previewing or generating.
3. On **Test execution**, select the demo connection, suite, policy, and dataset. Run with **simulate merge regression** off; follow live progress, then inspect the Dashboard and Audit explorer, request/response evidence, and downloads.
4. Turn the regression on and run again. Inspect the failed merge assertions, blocked dependent cases, NO-GO gate, and local defect candidates. Turn the toggle off afterward. **Reset demo** clears mock target records, not historical evidence.

For a local automated sequence, use **Simulate sprint close** on Test configuration: enter a new event ID and sprint ID, the suite's PBI IDs, and select the profile, suite, connection, and policy. The bundled demo suite maps to `PBI-DEMO-MDM-LIFECYCLE` and `PBI-DEMO-MDM-NEGATIVE`. The event generates a fresh dataset and run only when all work items have exact local suite mappings; otherwise it reports `MAPPING_GAPS` and NO-GO. It does not contact a work-item system.

## Customer MDM sandbox API

All endpoints are served by the local Express API under `/api/mock-api`:

| Method | Path | Behavior |
| --- | --- | --- |
| GET | `/customers` | List up to 100 customers |
| POST | `/customers` | Create a customer; duplicate IDs return 409 |
| GET | `/customers/:id` | Read a customer |
| PATCH | `/customers/:id` | Update customer fields |
| POST | `/customers/merge` | Retain a survivor, mark the other record merged, and reparent addresses |
| POST | `/addresses` | Create an address linked to an existing active customer |
| GET | `/customers/:id/addresses` | List addresses for a customer |
| DELETE | `/customers/:id` | Delete a sandbox record and its addresses; requires `x-demo-sandbox: true` |

Example:

```powershell
Invoke-RestMethod -Method Post `
  -Uri http://127.0.0.1:3001/api/mock-api/customers `
  -ContentType 'application/json' `
  -Body '{"customerId":"cust-1001","firstName":"Ada","lastName":"Lovelace","email":"ada@example.test"}'
```

`GET /api/health` reports live API and SQLite status with persisted customer/address counts. All mock API validation failures use a structured JSON `error` response.

## Model and synthetic-data workflow

The **Data models** screen imports canonical JSON, the supported JSON Schema subset (including local `$ref`), Mermaid `erDiagram` input, or version 1 `smart-mdm/schema` exports. Smart MDM exports are detected when pasted or uploaded. The **Synthetic data** screen configures per-entity counts, locale, seed, reference date, attribute rules, and deliberate negative scenarios; it previews and persists records, then offers paginated search and JSON/CSV downloads. Example Customer/Address inputs are available under [samples/](samples/).

Smart MDM import maps the domain and each child to separate entities, retaining field keys, text/dropdown/boolean/date types, required flags, dropdown options, and `qualityRules.unique`. It does **not** create primary keys or parent/child links, or enforce match keys, collection limits, roles, privacy labels, or quality weights. Dropdowns without options become unrestricted strings. Review the model before use; privacy labels do not establish access control. Unknown constructs and unsupported versions or field types are rejected.

JSON Schema import requires an object root with entity object schemas in root properties or `$defs`/`definitions`; supported keywords are `$schema`, `$id`, `$defs`, `definitions`, `$ref`, `title`, `description`, `type`, `properties`, `required`, `items`, `additionalProperties`, `format`, `enum`, `minimum`, `maximum`, `minLength`, `maxLength`, `pattern`, `nullable`, `default`, and the `x-primaryKey`, `x-unique`, `x-foreignKey`, and `x-cardinality` extensions. Only nonrecursive local references are supported; unsupported keywords and remote references are rejected.

Mermaid import supports `erDiagram`, entity blocks with typed attributes and PK/FK/UK/NN flags, and `--` relationships using common `|`, `o`, and `{` cardinality markers. Many-to-many relationships need an explicit join entity; ambiguous foreign keys require mapping. HTML, links, and styling directives are rejected. The UI presents the normalized model for JSON editing; it does not render a graphical ER diagram.

Model versions, profiles, datasets, and records are persisted in SQLite. Exports are staged locally and only published as `READY` datasets after successful generation; interrupted generations are marked failed and cleaned up on API startup.

| Method | Path | Behavior |
| --- | --- | --- |
| GET | `/api/models/samples` | Retrieve the bundled canonical, JSON Schema, and Mermaid samples |
| POST | `/api/models/import` | Validate and import a model document |
| GET | `/api/models` | List models and latest versions |
| GET | `/api/models/:id` | Read the latest version and version history |
| POST | `/api/models/:id/versions` | Validate and save an immutable canonical model version |
| GET, POST | `/api/generation-profiles` | List profiles or create one with suggested defaults |
| PATCH | `/api/generation-profiles/:id` | Update a profile after validation |
| POST | `/api/datasets/preview` | Preview a deterministic profile without persistence |
| POST | `/api/datasets` | Generate, persist, and publish a ready dataset |
| GET | `/api/datasets` | List ready datasets |
| GET | `/api/datasets/:id/records` | Search and paginate stored synthetic records |
| GET | `/api/datasets/:id/export` | Read the dataset export manifest |
| GET | `/api/datasets/:id/export/:kind` | Download combined, manifest, or entity JSON/CSV |

## Test configuration and execution

The **Test configuration** screen manages local system connections and JSON-defined suites. Suite and case edits create immutable versions. Templates map selected synthetic records and prior step results into HTTP paths and JSON payloads; suites can define expected statuses, JSON Schema response checks, JSON-path assertions, extracted values, and case dependencies. **Load demo configuration** installs an idempotent Customer MDM acceptance suite covering insert, update, read-back, merge, address reparenting, duplicate-ID rejection, missing-required-field rejection, and orphan-address rejection.

Execution is deliberately restricted to `http://127.0.0.1:<API-port>/api/mock-api` on the same API process. Redirects are not followed, request and response sizes and execution time are bounded, and authentication credentials must be referenced by environment-variable name. The browser does not send credentials or call external targets. Generate a `READY` Customer/Address dataset with the `orphan_fk` negative scenario enabled to exercise the orphan-address rejection case; cases without matching inputs are reported as `BLOCKED`, not silently skipped.

Expected HTTP responses, response schemas, and assertions are all required for `PASS`; an unexpected response (including unexpected acceptance in a negative test) is `FAIL`. Transport or timeout problems are `ERROR`, and cases whose prerequisites did not pass are `BLOCKED`. Run snapshots, results, step evidence, and counters persist in SQLite. One redacted JSONL file is written per run.

| Method | Path | Behavior |
| --- | --- | --- |
| GET, POST | `/api/connections` | List or create sandbox-scoped connections |
| GET, PATCH, DELETE | `/api/connections/:id` | Read, update, or delete an unused connection |
| POST | `/api/connections/:id/check` | Make a bounded health request to the configured local mock |
| POST | `/api/demo/load` | Idempotently load the demo model, profile, connection, suite, and policy |
| POST | `/api/demo/reset` | Clear mock target records when no run is active |
| POST, GET | `/api/sprint-events`, `/api/sprint-events/:id` | Create or inspect a local simulated sprint-close event |
| GET, POST | `/api/test-suites` | List suites or create a suite version |
| GET, PATCH | `/api/test-suites/:id` | Read a suite or save a new immutable version |
| GET | `/api/test-suites/:id/versions/:version` | Read a historical version |
| POST, PATCH | `/api/test-cases`, `/api/test-cases/:id` | Add or update a case by creating a new suite version |
| GET, POST | `/api/test-runs` | List runs or queue a run with a suite, connection, and READY dataset |
| GET, POST | `/api/test-runs/:id`, `/api/test-runs/:id/cancel` | Read progress or request cancellation |
| GET | `/api/test-runs/:id/results` | Read persisted case and step evidence |
| GET | `/api/test-runs/:id/log` | Download the run's JSONL event log |

## Dashboard, audit, and release decisions

The **Dashboard** shows persisted logical test outcomes, a historical run selector, filters, status and entity/operation charts, and a pass-rate trend. **Audit explorer** searches stored synthetic records and test results, including per-step request/response evidence, assertions, source data, and links to dataset exports and the run log. Result filters apply to the selected run; synthetic-record searches use the dataset, entity, and search filters. Filtered metrics count matching persisted results; the release decision always evaluates the complete run.

**Release policies** are versioned and scoped to an environment. A run captures the selected policy version, or the default for its connection environment. The default requires at least 80% pass rate and 100% coverage, with no errors, blocked tests, or critical non-passes. Pass rate is PASS/planned, and coverage is (PASS+FAIL+ERROR)/planned; comparisons use unrounded values. Empty, incomplete, cancelled, or critical non-passing runs cannot receive GO. The critical-failure maximum is configurable, but any critical non-PASS still blocks GO. Runs created before policy snapshots were introduced are conservatively evaluated NO-GO with a missing-policy reason.

The local **simulate merge regression** toggle makes the mock merge stop reparenting addresses. It is off by default, persists across restart, affects the whole local mock service, and cannot be changed while any run is queued or running. Create a dataset with `orphan_fk`, load the demo configuration, and run it once with regression off and once with it on to see a real GO versus NO-GO. The setting is captured in each new run snapshot. Restore the toggle afterward.

NO-GO runs create local defect candidates for FAIL and ERROR results, grouped by stable signature with individual redacted occurrences. BLOCKED results remain visible in metrics and audit rather than being treated as defects. Candidates currently remain unresolved; there is no external ticket creation or deployment. Recommendations are advisory only, and the app is a local single-user sandbox rather than an authenticated or RBAC-enabled service.

| Method | Path | Behavior |
| --- | --- | --- |
| GET, POST | `/api/release-policies` | List latest policies or create a policy |
| PUT | `/api/release-policies/:id` | Save a new immutable policy version |
| GET | `/api/analytics/runs` | Paginate run history and filtered metrics |
| GET | `/api/analytics/runs/:id` | Read metrics, chart groups, and the persisted gate decision |
| GET | `/api/analytics/runs/:id/results` | Filter and paginate run results |
| GET | `/api/analytics/results/:id` | Inspect source record, input, and step evidence |
| GET | `/api/analytics/records` | Search and paginate synthetic records |
| GET | `/api/defects`, `/api/defects/export` | List or export local defect candidates |
| GET, POST | `/api/demo/regression` | Read or change the global local regression toggle |

## Sprint events and limitations

Sprint events are idempotent by event ID: equivalent inputs return the existing event; different inputs return HTTP 409. Work-item IDs are deduplicated and sorted before comparison. Missing mappings produce a persisted NO-GO without a dataset or run. On restart, interrupted runs are recovered as errors; an interrupted event creation is marked ERROR and must be retried with a new event ID. Decisions and local defects come from persisted execution results.

This is a local single-user demo without authentication or RBAC; only the same-process loopback mock is an execution target. There is no corporate board or CI integration, ticket creation, deployment, promotion, OpenAPI import, or runtime LLM adapter. Defect candidates do not have a resolution workflow. Model/rule and suite editing use JSON rather than a graphical wizard, and Mermaid diagrams are not rendered. The optional integrations and full enterprise controls in the specification remain future work.

## Verified QA results

The latest isolated end-to-end QA used an uploaded Customer/Address model and a fixed-seed profile: 20 Customers, 30 Addresses, and one deliberate orphan; FK/cardinality checks and deterministic regeneration passed. The baseline execution produced **61 PASS, GO**; the actual merge regression produced **21 PASS, 20 FAIL, 20 BLOCKED, NO-GO**. Sprint-close runs produced the same decisions, a missing work-item mapping produced NO-GO without a run, and both decisions survived API restart. Browser checks covered charts, audit request/response evidence, and downloads; run JSONL step-event counts matched persisted steps (201 baseline, 141 regression). These outcomes describe that isolated test configuration, not a guarantee for edited profiles or policies.

The final `npm.cmd run build` succeeded and `npm.cmd test` passed 17 tests across 3 files.

See [.github/copilot-instructions.md](.github/copilot-instructions.md) for repository conventions and [MASTER_PROMPT.md](MASTER_PROMPT.md) for the full build specification.
