# TestAgent AI

TestAgent AI is a local-first workbench for synthetic data and REST API quality. It contains a React/TypeScript UI, an Express API, shared TypeScript contracts, a migrated SQLite database, a stateful Customer MDM sandbox API, and a versioned API test execution workflow. It runs locally and does not require external services.

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

`demo:reset` removes mock customers and addresses while retaining the database schema. The SQLite database is created under `storage/agentx.sqlite`; generated dataset exports are stored under `storage/datasets`; per-run JSONL evidence is stored under `storage/logs`. These are local runtime data and ignored by Git. Set `AGENTX_STORAGE_DIR` or `AGENTX_LOG_DIR` to choose other local directories.

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

The **Data models** screen imports canonical JSON, the supported JSON Schema subset (including local `$ref`), or Mermaid `erDiagram` input. The **Synthetic data** screen configures per-entity counts, locale, seed, reference date, attribute rules, and deliberate negative scenarios; it previews and persists records, then offers paginated search and JSON/CSV downloads. Example Customer/Address inputs are available under [samples/](samples/).

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
| POST | `/api/demo/load` | Idempotently load the local demo connection and acceptance suite |
| GET, POST | `/api/test-suites` | List suites or create a suite version |
| GET, PATCH | `/api/test-suites/:id` | Read a suite or save a new immutable version |
| GET | `/api/test-suites/:id/versions/:version` | Read a historical version |
| POST, PATCH | `/api/test-cases`, `/api/test-cases/:id` | Add or update a case by creating a new suite version |
| GET, POST | `/api/test-runs` | List runs or queue a run with a suite, connection, and READY dataset |
| GET, POST | `/api/test-runs/:id`, `/api/test-runs/:id/cancel` | Read progress or request cancellation |
| GET | `/api/test-runs/:id/results` | Read persisted case and step evidence |
| GET | `/api/test-runs/:id/log` | Download the run's JSONL event log |

## Scope and next phases

The UI provides a live service overview, a working Mock MDM API console, the complete model/synthetic-data workflow, and sandbox-scoped test configuration and execution. Audit analytics, release gates, regression controls, and defect workflows remain tracked in [docs/implementation-plan.md](docs/implementation-plan.md).

See [.github/copilot-instructions.md](.github/copilot-instructions.md) for repository conventions and [MASTER_PROMPT.md](MASTER_PROMPT.md) for the full build specification.
