# Architecture

AgentX is a local, single-user sandbox. The React/Vite frontend uses the Vite `/api` proxy to reach an Express API; shared TypeScript contracts define the exchanged data. SQLite stores versioned models, profiles, suites and policies alongside generated records, runs, step evidence, gate decisions, defects, and sprint events. Dataset exports and per-run JSONL logs live in app-controlled local directories.

## Data and execution flow

1. Import supported canonical JSON, JSON Schema, or Mermaid ER text into a normalized, versioned model. Resolve ambiguous relationship mappings before generating.
2. Save a profile with entity counts, rules, scenarios, seed, locale, and reference date. Generate validated records and staged exports; only a published READY dataset can be executed.
3. Snapshot the selected suite, connection, dataset, and release policy for an asynchronous run. The server executes bounded real HTTP requests against its own loopback mock MDM API, persists logical results and step evidence, and writes one redacted JSONL log.
4. Dashboard and audit views query persisted records and results. A final run is evaluated against its saved policy; a NO-GO creates deduplicated local defect candidates for failures and errors.
5. A local sprint-close event checks exact work-item-to-suite-case mappings before generating a dataset and launching the same run and gate flow. Event IDs provide idempotency; mapping gaps are persisted without execution. Interrupted creation is marked ERROR on restart instead of being replayed.

Generation and run recovery mark interrupted work as failed or errored rather than reporting success. Mock reset is guarded while runs are active and does not erase historical evidence.

## Safety and scope

Execution is restricted to the same API process's `127.0.0.1` mock route. The browser never receives environment-variable credentials; request evidence is redacted. Model import rejects remote references and unsafe Mermaid content. This sandbox does not implement authentication, RBAC, external test targets, corporate work-item systems, ticket creation, deployment, or automatic promotion. Local decisions are advisory.

See the [README](../README.md) for startup, supported model subsets, endpoint summaries, demo instructions, verified results, and remaining limitations.
