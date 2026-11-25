# Repository instructions for Copilot

## Project shape
- This is TestAgent AI, a local-first, single-user synthetic-data and REST API quality workbench.
- Use the npm workspaces in `apps/web`, `apps/api`, and `packages/shared`; keep cross-workspace API payloads in `@agentx/shared`.
- Follow the phases in `docs/implementation-plan.md` and `MASTER_PROMPT.md`. Complete and validate a vertical slice before starting later-phase features.
- Do not add non-functional screens or fabricated data/results. UI metrics must come from persisted backend data.

## Runtime and persistence
- The web client is React + TypeScript + Vite. The API is TypeScript + Express. SQLite is the local persistence layer.
- Keep the API bound to loopback by default and use the Vite `/api` proxy for browser requests.
- Put migrations in `apps/api/src/database.ts` using numbered, idempotent schema versions; turn on SQLite foreign keys and use parameterized SQL.
- Keep database and generated artifacts under the app-controlled `storage/` directory. Never accept a browser-provided filesystem path.
- Share typed request/response contracts in `packages/shared`; keep API errors structured and surface them to the UI.

## Safety and data integrity
- Treat the bundled mock MDM as a sandbox only. Never target production or connect to external systems by default.
- Keep test execution restricted to `http://127.0.0.1:<current API port>/api/mock-api`; do not follow redirects or broaden the target allowlist.
- Do not add real credentials, real customer data, external AI runtime dependencies, automatic deployment, or external ticket creation.
- Store authentication as environment-variable references only; never persist or log credential values, and keep run evidence redacted.
- Require explicit sandbox confirmation for destructive mock operations.
- Preserve merge/address relationships, validate inputs before writes, use transactions for multi-row changes, and ensure the UI reports request failures rather than success-shaped fallbacks.

## Verification
- From the repository root, use `npm run dev`, `npm run build`, `npm test`, and `npm run demo:reset`.
- Add focused integration or unit tests for new behavior using the existing Vitest/Supertest setup.
- Run the smallest relevant test/build command after a change, and report only commands that actually completed successfully.
- Keep generated SQLite databases, logs, datasets, build output, and credentials out of source control.
