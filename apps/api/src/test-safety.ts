import { Ajv, type AnySchema } from "ajv";
import type {
  AssertionOperator,
  ConnectionAuthType,
  ConnectionInput,
  JsonPathAssertion,
  SystemConnection,
  TestCaseDefinition,
  TestEnvironment,
  TestHttpMethod,
  TestOperation,
  TestPriority,
  TestStep,
  TestSuiteInput,
} from "@agentx/shared";
import { HttpError } from "./http-error.js";

const authTypes = new Set<ConnectionAuthType>(["none", "apiKey", "bearer", "basic"]);
const environments = new Set<TestEnvironment>(["DEMO", "DEV", "QA", "UAT"]);
const methods = new Set<TestHttpMethod>(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const operations = new Set<TestOperation>(["INSERT", "UPDATE", "MERGE", "DELETE", "READ", "VALIDATE", "CUSTOM"]);
const priorities = new Set<TestPriority>(["P0", "P1", "P2", "P3"]);
const assertionOperators = new Set<AssertionOperator>([
  "equals", "exists", "notExists", "contains", "type", "count", "compareToInput",
]);
const protectedHeaders = new Set([
  "authorization", "proxy-authorization", "cookie", "set-cookie", "host", "content-length",
  "connection", "transfer-encoding", "x-api-key", "api-key",
]);
const dangerousPathSegments = new Set(["__proto__", "prototype", "constructor"]);
const maxJsonBytes = 64 * 1024;
const maxCases = 100;
const maxStepsPerCase = 20;

export function parseConnectionInput(input: unknown, localPort: number): ConnectionInput {
  const body = requireObject(input, "Connection");
  assertKeys(body, [
    "name", "systemType", "environment", "baseUrl", "authType", "secretRef",
    "headers", "timeoutMs", "maxConcurrency", "enabled",
  ], "Connection");
  const name = requiredString(body.name, "name", 100);
  const systemType = requiredString(body.systemType, "systemType", 80);
  if (typeof body.environment !== "string" || !environments.has(body.environment as TestEnvironment)) {
    throw new HttpError(400, "INVALID_CONNECTION_ENVIRONMENT", "Environment must be DEMO, DEV, QA, or UAT.");
  }
  if (typeof body.authType !== "string" || !authTypes.has(body.authType as ConnectionAuthType)) {
    throw new HttpError(400, "INVALID_CONNECTION_AUTH", "Auth type must be none, apiKey, bearer, or basic.");
  }
  const authType = body.authType as ConnectionAuthType;
  const secretRef = body.secretRef === undefined || body.secretRef === ""
    ? undefined
    : requiredString(body.secretRef, "secretRef", 128);
  if (authType === "none" && secretRef) {
    throw new HttpError(400, "UNEXPECTED_SECRET_REFERENCE", "A secret reference is not used when auth type is none.");
  }
  if (authType !== "none" && (!secretRef || !/^[A-Z_][A-Z0-9_]{0,127}$/.test(secretRef))) {
    throw new HttpError(400, "SECRET_REFERENCE_REQUIRED", "Authenticated connections require an environment-variable name such as DEMO_API_TOKEN.");
  }
  const baseUrl = validateMockBaseUrl(body.baseUrl, localPort);
  const headers = parseHeaders(body.headers);
  const timeoutMs = positiveInteger(body.timeoutMs, "timeoutMs", 30_000, 5_000);
  if (timeoutMs < 100) {
    throw new HttpError(400, "INVALID_CONNECTION_TIMEOUT", "Connection timeout must be at least 100 ms.");
  }
  const maxConcurrency = positiveInteger(body.maxConcurrency, "maxConcurrency", 5, 1);
  if (typeof body.enabled !== "boolean") {
    throw new HttpError(400, "INVALID_CONNECTION_ENABLED", "enabled must be a boolean.");
  }
  return {
    name,
    systemType,
    environment: body.environment as TestEnvironment,
    baseUrl,
    authType,
    ...(secretRef ? { secretRef } : {}),
    headers,
    timeoutMs,
    maxConcurrency,
    enabled: body.enabled,
  };
}

export function validateMockBaseUrl(value: unknown, localPort: number): string {
  if (typeof value !== "string" || value.length > 255) {
    throw new HttpError(400, "UNSAFE_CONNECTION_URL", "Connection URL must target the local mock MDM service.");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(400, "UNSAFE_CONNECTION_URL", "Connection URL must be a valid absolute URL.");
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    Number(url.port || 80) !== localPort ||
    url.pathname !== "/api/mock-api" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new HttpError(
      400,
      "UNSAFE_CONNECTION_URL",
      `Only http://127.0.0.1:${localPort}/api/mock-api is permitted for this local sandbox.`,
    );
  }
  return url.origin + url.pathname;
}

export function normalizeSuite(input: unknown): TestSuiteInput {
  const body = requireObject(input, "Test suite");
  assertKeys(body, ["name", "cases"], "Test suite");
  const name = requiredString(body.name, "Suite name", 100);
  if (!Array.isArray(body.cases) || body.cases.length === 0 || body.cases.length > maxCases) {
    throw new HttpError(400, "INVALID_TEST_CASES", `A suite must contain between 1 and ${maxCases} cases.`);
  }
  const cases = body.cases.map((testCase, index) => normalizeCase(testCase, index));
  const ids = new Set(cases.map((testCase) => testCase.id));
  if (ids.size !== cases.length) {
    throw new HttpError(400, "DUPLICATE_TEST_CASE_ID", "Test case IDs must be unique within a suite version.");
  }
  for (const testCase of cases) {
    const invalidDependency = testCase.dependsOn.find((id) => !ids.has(id) || id === testCase.id);
    if (invalidDependency) {
      throw new HttpError(400, "INVALID_TEST_DEPENDENCY", `${testCase.id} depends on unknown or itself: ${invalidDependency}.`);
    }
  }
  topologicalCases(cases);
  return { name, cases };
}

function normalizeCase(value: unknown, index: number): TestCaseDefinition {
  const testCase = requireObject(value, `Case ${index + 1}`);
  assertKeys(testCase, [
    "id", "name", "operation", "entity", "recordSelector", "priority", "critical",
    "expectedOutcome", "dependsOn", "steps", "pbi",
  ], `Case ${index + 1}`);
  const id = requiredString(testCase.id, `Case ${index + 1} ID`, 60);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new HttpError(400, "INVALID_TEST_CASE_ID", `${id} must use only letters, numbers, underscores, and hyphens.`);
  }
  const name = requiredString(testCase.name, `Case ${id} name`, 120);
  if (typeof testCase.operation !== "string" || !operations.has(testCase.operation as TestOperation)) {
    throw new HttpError(400, "INVALID_TEST_OPERATION", `${id} has an unsupported operation.`);
  }
  const entity = requiredString(testCase.entity, `${id} entity`, 80);
  const selector = requireObject(testCase.recordSelector, `${id} record selector`);
  assertKeys(selector, ["entity", "expectedValid", "scenarioId"], `${id} record selector`);
  const selectorEntity = requiredString(selector.entity, `${id} selector entity`, 80);
  if (selectorEntity !== entity) {
    throw new HttpError(400, "INVALID_RECORD_SELECTOR", `${id} selector entity must match the test case entity.`);
  }
  if (selector.expectedValid !== undefined && typeof selector.expectedValid !== "boolean") {
    throw new HttpError(400, "INVALID_RECORD_SELECTOR", `${id} expectedValid must be a boolean when supplied.`);
  }
  const scenarioId = selector.scenarioId === undefined
    ? undefined
    : requiredString(selector.scenarioId, `${id} scenario ID`, 80);
  if (scenarioId && selector.expectedValid !== undefined) {
    throw new HttpError(400, "INVALID_RECORD_SELECTOR", `${id} must select by scenarioId or expectedValid, not both.`);
  }
  const priority = testCase.priority ?? "P2";
  if (typeof priority !== "string" || !priorities.has(priority as TestPriority)) {
    throw new HttpError(400, "INVALID_TEST_PRIORITY", `${id} priority must be P0, P1, P2, or P3.`);
  }
  if (typeof testCase.critical !== "boolean") {
    throw new HttpError(400, "INVALID_TEST_CRITICAL", `${id} critical must be a boolean.`);
  }
  if (testCase.expectedOutcome !== "positive" && testCase.expectedOutcome !== "negative") {
    throw new HttpError(400, "INVALID_EXPECTED_OUTCOME", `${id} expectedOutcome must be positive or negative.`);
  }
  if (!Array.isArray(testCase.dependsOn) || testCase.dependsOn.some((dependency) => typeof dependency !== "string")) {
    throw new HttpError(400, "INVALID_TEST_DEPENDENCY", `${id} dependsOn must be an array of case IDs.`);
  }
  const dependsOn = Array.from(new Set(testCase.dependsOn as string[]));
  if (!Array.isArray(testCase.steps) || testCase.steps.length === 0 || testCase.steps.length > maxStepsPerCase) {
    throw new HttpError(400, "INVALID_TEST_STEPS", `${id} must contain between 1 and ${maxStepsPerCase} steps.`);
  }
  const steps = testCase.steps.map((step, stepIndex) => normalizeStep(step, id, stepIndex, testCase.expectedOutcome === "negative"));
  const stepIds = new Set(steps.map((step) => step.id));
  if (stepIds.size !== steps.length) throw new HttpError(400, "DUPLICATE_TEST_STEP_ID", `${id} step IDs must be unique.`);
  const pbi = testCase.pbi === undefined || testCase.pbi === "" ? undefined : requiredString(testCase.pbi, `${id} PBI`, 100);
  return {
    id,
    name,
    operation: testCase.operation as TestOperation,
    entity,
    recordSelector: {
      entity: selectorEntity,
      ...(selector.expectedValid === undefined ? {} : { expectedValid: selector.expectedValid as boolean }),
      ...(scenarioId ? { scenarioId } : {}),
    },
    priority: priority as TestPriority,
    critical: testCase.critical,
    expectedOutcome: testCase.expectedOutcome,
    dependsOn,
    steps,
    ...(pbi ? { pbi } : {}),
  };
}

function normalizeStep(value: unknown, caseId: string, index: number, negativeCase: boolean): TestStep {
  const step = requireObject(value, `${caseId} step ${index + 1}`);
  assertKeys(step, [
    "id", "name", "method", "path", "query", "body", "expectedStatuses",
    "responseSchema", "assertions", "extract", "timeoutMs",
  ], `${caseId} step ${index + 1}`);
  const id = requiredString(step.id, `${caseId} step ID`, 60);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new HttpError(400, "INVALID_TEST_STEP_ID", `${caseId}.${id} is not a valid step ID.`);
  const name = requiredString(step.name, `${caseId} step name`, 120);
  if (typeof step.method !== "string" || !methods.has(step.method as TestHttpMethod)) {
    throw new HttpError(400, "INVALID_HTTP_METHOD", `${caseId}.${id} has an unsupported HTTP method.`);
  }
  const path = requiredString(step.path, `${caseId}.${id} path`, 1024);
  if (path.startsWith("/") || path.includes("\\") || path.includes("?") || path.includes("#") || /^[a-z][a-z0-9+.-]*:/i.test(path)) {
    throw new HttpError(400, "UNSAFE_TEST_PATH", `${caseId}.${id} path must be relative to the configured mock API base URL.`);
  }
  validateTemplateSyntax(path, `${caseId}.${id} path`);
  for (const segment of path.split("/")) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new HttpError(400, "UNSAFE_TEST_PATH", `${caseId}.${id} path has invalid percent encoding.`);
    }
    if (decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\")) {
      throw new HttpError(400, "UNSAFE_TEST_PATH", `${caseId}.${id} path contains an unsafe path segment.`);
    }
  }
  const queryValue = step.query === undefined ? undefined : validateJsonTemplate(step.query, `${caseId}.${id} query`);
  if (queryValue !== undefined && !isObject(queryValue)) {
    throw new HttpError(400, "INVALID_QUERY_PARAMETERS", `${caseId}.${id} query must be an object.`);
  }
  const query = queryValue as Record<string, unknown> | undefined;
  const body = step.body === undefined ? undefined : validateJsonTemplate(step.body, `${caseId}.${id} request body`);
  if (body !== undefined && jsonSize(body) > maxJsonBytes) {
    throw new HttpError(413, "TEST_REQUEST_TOO_LARGE", `${caseId}.${id} request body exceeds 64 KB.`);
  }
  if (!Array.isArray(step.expectedStatuses) || step.expectedStatuses.length === 0 ||
      step.expectedStatuses.some((status) => !Number.isInteger(status) || status < 100 || status > 599)) {
    throw new HttpError(400, "EXPECTED_STATUS_REQUIRED", `${caseId}.${id} must specify one or more HTTP status codes.`);
  }
  const expectedStatuses = Array.from(new Set(step.expectedStatuses as number[]));
  if (negativeCase && expectedStatuses.some((status) => status < 400 || status > 499)) {
    throw new HttpError(400, "NEGATIVE_STATUS_MUST_REJECT", `${caseId}.${id} negative cases must expect a 4xx rejection status; 2xx acceptance cannot pass.`);
  }
  const responseSchema = step.responseSchema === undefined
    ? undefined
    : validateResponseSchema(step.responseSchema, `${caseId}.${id} response schema`);
  if (!Array.isArray(step.assertions)) throw new HttpError(400, "INVALID_ASSERTIONS", `${caseId}.${id} assertions must be an array.`);
  const assertions = step.assertions.map((assertion, assertionIndex) => normalizeAssertion(assertion, `${caseId}.${id} assertion ${assertionIndex + 1}`));
  const extract = step.extract === undefined ? undefined : parseExtract(step.extract, `${caseId}.${id}`);
  const timeoutMs = step.timeoutMs === undefined
    ? undefined
    : positiveInteger(step.timeoutMs, `${caseId}.${id} timeout`, 30_000, 5_000);
  return {
    id,
    name,
    method: step.method as TestHttpMethod,
    path,
    ...(query === undefined ? {} : { query }),
    ...(body === undefined ? {} : { body }),
    expectedStatuses,
    ...(responseSchema === undefined ? {} : { responseSchema }),
    assertions,
    ...(extract ? { extract } : {}),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}

function normalizeAssertion(value: unknown, label: string): JsonPathAssertion {
  const assertion = requireObject(value, label);
  assertKeys(assertion, ["path", "operator", "expected"], label);
  const path = requiredString(assertion.path, `${label} path`, 256);
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*(?:(?:\.[A-Za-z_$][A-Za-z0-9_$]*)|(?:\[\d+\]))*$/.test(path) ||
      path.split(/[.[\]]+/).some((part) => dangerousPathSegments.has(part))) {
    throw new HttpError(400, "INVALID_ASSERTION_PATH", `${label} path must be a safe dotted JSON path with optional numeric array indexes.`);
  }
  if (typeof assertion.operator !== "string" || !assertionOperators.has(assertion.operator as AssertionOperator)) {
    throw new HttpError(400, "INVALID_ASSERTION_OPERATOR", `${label} uses an unsupported assertion operator.`);
  }
  const operator = assertion.operator as AssertionOperator;
  if (!["exists", "notExists"].includes(operator) && assertion.expected === undefined) {
    throw new HttpError(400, "ASSERTION_VALUE_REQUIRED", `${label} requires an expected value.`);
  }
  const expected = assertion.expected === undefined
    ? undefined
    : validateJsonTemplate(assertion.expected, `${label} expected value`);
  return { path, operator, ...(expected === undefined ? {} : { expected }) };
}

function parseExtract(value: unknown, label: string): Record<string, string> {
  const extract = requireObject(value, `${label} extraction`);
  const entries = Object.entries(extract);
  if (entries.length > 20) throw new HttpError(400, "TOO_MANY_EXTRACTIONS", `${label} can extract at most 20 values.`);
  const result: Record<string, string> = {};
  for (const [name, path] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,59}$/.test(name) || typeof path !== "string") {
      throw new HttpError(400, "INVALID_EXTRACTION", `${label} extraction names and paths must be strings with safe names.`);
    }
    const assertion = normalizeAssertion({ path, operator: "exists" }, `${label} extraction ${name}`);
    result[name] = assertion.path;
  }
  return result;
}

function validateResponseSchema(value: unknown, label: string): AnySchema {
  if (jsonSize(value) > maxJsonBytes) throw new HttpError(413, "RESPONSE_SCHEMA_TOO_LARGE", `${label} exceeds 64 KB.`);
  if (!isObject(value)) throw new HttpError(400, "INVALID_RESPONSE_SCHEMA", `${label} must be a JSON Schema object.`);
  const schema = value as AnySchema;
  const ajv = new Ajv({ allErrors: true, strict: false });
  if (!ajv.validateSchema(schema)) {
    throw new HttpError(400, "INVALID_RESPONSE_SCHEMA", `${label} is not valid JSON Schema: ${ajv.errorsText(ajv.errors)}.`);
  }
  try {
    ajv.compile(schema);
  } catch (error) {
    throw new HttpError(400, "INVALID_RESPONSE_SCHEMA", `${label} cannot be compiled: ${errorMessage(error)}.`);
  }
  return schema;
}

function validateJsonTemplate(value: unknown, label: string): unknown {
  if (jsonSize(value) > maxJsonBytes) throw new HttpError(413, "TEST_TEMPLATE_TOO_LARGE", `${label} exceeds 64 KB.`);
  const visit = (item: unknown): void => {
    if (typeof item === "string") validateTemplateSyntax(item, label);
    else if (Array.isArray(item)) item.forEach(visit);
    else if (isObject(item)) {
      for (const [key, nested] of Object.entries(item)) {
        if (dangerousPathSegments.has(key)) throw new HttpError(400, "UNSAFE_TEMPLATE_KEY", `${label} contains an unsafe JSON property.`);
        if (/authorization|cookie|secret(?!ref)|password|token|credential|api.?key/i.test(key)) {
          throw new HttpError(400, "SENSITIVE_TEST_FIELD_BLOCKED", `${label} cannot contain credential-like fields; use an environment secret reference for authentication.`);
        }
        visit(nested);
      }
    }
  };
  visit(value);
  return value;
}

function validateTemplateSyntax(value: string, label: string): void {
  const placeholders = value.match(/\{\{[^{}]*\}\}/g) ?? [];
  const withoutPlaceholders = value.replace(/\{\{[^{}]*\}\}/g, "");
  if (withoutPlaceholders.includes("{{") || withoutPlaceholders.includes("}}")) {
    throw new HttpError(400, "INVALID_TEMPLATE", `${label} contains an invalid template token.`);
  }
  for (const placeholder of placeholders) {
    const token = placeholder.slice(2, -2);
    if (!/^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*|\.\d+)*(?:\[\d+\])*$/.test(token) ||
        token.split(/[.[\]]+/).some((part) => dangerousPathSegments.has(part))) {
      throw new HttpError(400, "INVALID_TEMPLATE", `${label} contains an invalid or unsafe template token ${placeholder}.`);
    }
  }
}

export function topologicalCases(cases: TestCaseDefinition[]): TestCaseDefinition[] {
  const byId = new Map(cases.map((testCase) => [testCase.id, testCase]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: TestCaseDefinition[] = [];
  const visit = (testCase: TestCaseDefinition): void => {
    if (visited.has(testCase.id)) return;
    if (visiting.has(testCase.id)) throw new HttpError(400, "CYCLIC_TEST_DEPENDENCY", `Cyclic test dependency detected at ${testCase.id}.`);
    visiting.add(testCase.id);
    for (const dependencyId of testCase.dependsOn) {
      const dependency = byId.get(dependencyId);
      if (!dependency) throw new HttpError(400, "INVALID_TEST_DEPENDENCY", `${testCase.id} depends on unknown test case ${dependencyId}.`);
      visit(dependency);
    }
    visiting.delete(testCase.id);
    visited.add(testCase.id);
    ordered.push(testCase);
  };
  for (const testCase of cases) visit(testCase);
  return ordered;
}

export function resolveTemplate(value: unknown, context: Record<string, unknown>, encodePathTokens = false): unknown {
  if (typeof value === "string") {
    const exact = /^\{\{([^{}]+)\}\}$/.exec(value);
    if (exact) return cloneJson(resolveToken(exact[1], context));
    const result = value.replace(/\{\{([^{}]+)\}\}/g, (_match, token: string) => {
      const resolved = resolveToken(token, context);
      if (resolved !== null && typeof resolved === "object") {
        throw new HttpError(422, "INVALID_TEMPLATE_VALUE", `Template token {{${token}}} cannot embed an object into a string.`);
      }
      const text = resolved === null ? "null" : String(resolved);
      return encodePathTokens ? encodeURIComponent(text) : text;
    });
    if (result.includes("{{") || result.includes("}}")) throw new HttpError(422, "UNRESOLVED_TEMPLATE", "A request template contains an unresolved token.");
    return result;
  }
  if (Array.isArray(value)) return value.map((item) => resolveTemplate(item, context));
  if (isObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) result[key] = resolveTemplate(item, context);
    return result;
  }
  return value;
}

function resolveToken(token: string, context: Record<string, unknown>): unknown {
  const parts = token.split(/[.[\]]+/).filter(Boolean);
  let current: unknown = context;
  for (const part of parts) {
    if (dangerousPathSegments.has(part) || !isObjectOrArray(current) || !Object.prototype.hasOwnProperty.call(current, part)) {
      throw new HttpError(422, "UNRESOLVED_TEMPLATE", `Template token {{${token}}} could not be resolved.`);
    }
    current = (current as Record<string, unknown>)[part];
  }
  if (current === undefined) throw new HttpError(422, "UNRESOLVED_TEMPLATE", `Template token {{${token}}} could not be resolved.`);
  return current;
}

export function buildRequestUrl(
  connection: SystemConnection,
  path: string,
  query: unknown,
  context: Record<string, unknown>,
): URL {
  const resolvedPath = resolveTemplate(path, context, true);
  if (typeof resolvedPath !== "string" || !resolvedPath || resolvedPath.startsWith("/") || resolvedPath.includes("\\") ||
      resolvedPath.includes("?") || resolvedPath.includes("#")) {
    throw new HttpError(400, "UNSAFE_TEST_PATH", "Resolved request path must remain relative to the mock API base URL.");
  }
  for (const segment of resolvedPath.split("/")) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new HttpError(400, "UNSAFE_TEST_PATH", "Resolved request path has invalid encoding.");
    }
    if (decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\")) {
      throw new HttpError(400, "UNSAFE_TEST_PATH", "Resolved request path contains an unsafe segment.");
    }
  }
  const baseUrl = new URL(`${connection.baseUrl}/`);
  const url = new URL(resolvedPath, baseUrl);
  if (url.origin !== baseUrl.origin || !url.pathname.startsWith(baseUrl.pathname)) {
    throw new HttpError(400, "UNSAFE_TEST_PATH", "Resolved request path escaped the configured mock API base URL.");
  }
  if (query !== undefined) {
    const resolvedQuery = resolveTemplate(query, context);
    if (!isObject(resolvedQuery)) throw new HttpError(400, "INVALID_QUERY_PARAMETERS", "Query parameters must resolve to an object.");
    for (const [key, value] of Object.entries(resolvedQuery)) {
      if (!/^[A-Za-z0-9_.-]{1,80}$/.test(key) || dangerousPathSegments.has(key)) {
        throw new HttpError(400, "INVALID_QUERY_PARAMETERS", `Query key ${key} is not allowed.`);
      }
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(key, queryValue(item, key));
      } else {
        url.searchParams.set(key, queryValue(value, key));
      }
    }
  }
  return url;
}

function queryValue(value: unknown, key: string): string {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  throw new HttpError(400, "INVALID_QUERY_PARAMETERS", `Query parameter ${key} must resolve to a primitive value.`);
}

export function getJsonPath(value: unknown, path: string): { exists: boolean; value?: unknown } {
  const parts = path.split(/[.[\]]+/).filter(Boolean);
  let current = value;
  for (const part of parts) {
    if (!isObjectOrArray(current) || dangerousPathSegments.has(part) || !Object.prototype.hasOwnProperty.call(current, part)) {
      return { exists: false };
    }
    current = (current as Record<string, unknown>)[part];
  }
  return { exists: current !== undefined, value: current };
}

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!isObject(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = /authorization|cookie|secret(?!ref)|password|token|credential|api.?key/i.test(key)
      ? "[REDACTED]"
      : redact(item);
  }
  return result;
}

export function redactUrl(value: URL): string {
  const url = new URL(value);
  for (const key of Array.from(url.searchParams.keys())) {
    if (/authorization|cookie|secret|password|token|credential|api.?key/i.test(key)) url.searchParams.set(key, "[REDACTED]");
  }
  return url.toString();
}

export function resolveAuthHeaders(connection: SystemConnection): Record<string, string> {
  const headers = { ...connection.headers };
  if (connection.authType === "none") return headers;
  const secretRef = connection.secretRef;
  const secret = secretRef ? process.env[secretRef] : undefined;
  if (!secret) {
    throw new HttpError(422, "CONNECTION_SECRET_UNAVAILABLE", `The server environment variable ${secretRef ?? "(missing)"} is not set.`);
  }
  if (connection.authType === "apiKey") headers["x-api-key"] = secret;
  if (connection.authType === "bearer") headers.authorization = `Bearer ${secret}`;
  if (connection.authType === "basic") headers.authorization = `Basic ${Buffer.from(secret, "utf8").toString("base64")}`;
  return headers;
}

export function connectionFromRow(row: {
  id: string;
  name: string;
  system_type: string;
  environment: TestEnvironment;
  base_url: string;
  auth_type: ConnectionAuthType;
  secret_ref: string | null;
  headers_json: string;
  timeout_ms: number;
  max_concurrency: number;
  enabled: number;
  created_at: string;
  updated_at: string;
}): SystemConnection {
  return {
    id: row.id,
    name: row.name,
    systemType: row.system_type,
    environment: row.environment,
    baseUrl: row.base_url,
    authType: row.auth_type,
    ...(row.secret_ref ? { secretRef: row.secret_ref } : {}),
    headers: JSON.parse(row.headers_json) as Record<string, string>,
    timeoutMs: row.timeout_ms,
    maxConcurrency: row.max_concurrency,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseHeaders(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  const headers = requireObject(value, "Connection headers");
  if (Object.keys(headers).length > 30) throw new HttpError(400, "TOO_MANY_CONNECTION_HEADERS", "At most 30 custom headers are allowed.");
  const result: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(headers)) {
    const normalizedName = name.toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(normalizedName) || protectedHeaders.has(normalizedName)) {
      throw new HttpError(400, "UNSAFE_CONNECTION_HEADER", `Connection header ${name} is reserved or unsafe.`);
    }
    if (typeof headerValue !== "string" || headerValue.length > 1000 || /[\r\n]/.test(headerValue)) {
      throw new HttpError(400, "INVALID_CONNECTION_HEADER", `Connection header ${name} must be a short single-line string.`);
    }
    result[normalizedName] = headerValue;
  }
  return result;
}

function positiveInteger(value: unknown, label: string, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) {
    throw new HttpError(400, "INVALID_CONNECTION_SETTING", `${label} must be an integer between 1 and ${max}.`);
  }
  return value;
}

function requiredString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > maxLength) {
    throw new HttpError(400, "INVALID_TEST_CONFIGURATION", `${label} must be a non-empty string of at most ${maxLength} characters.`);
  }
  return value.trim();
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!isObject(value)) throw new HttpError(400, "INVALID_TEST_CONFIGURATION", `${label} must be a JSON object.`);
  return value;
}

function assertKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new HttpError(400, "UNKNOWN_TEST_CONFIGURATION_FIELDS", `${label} contains unsupported fields: ${unknown.join(", ")}.`);
}

function jsonSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function cloneJson(value: unknown): unknown {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value)) as unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isObjectOrArray(value: unknown): value is Record<string, unknown> | unknown[] {
  return typeof value === "object" && value !== null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
