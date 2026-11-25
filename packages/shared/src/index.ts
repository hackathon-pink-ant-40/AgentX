export type CustomerStatus = "ACTIVE" | "INACTIVE" | "PROSPECT";

export interface Customer {
  customerId: string;
  firstName: string;
  lastName: string;
  email?: string;
  status: CustomerStatus;
  mergedInto?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Address {
  addressId: string;
  customerId: string;
  street: string;
  postalCode: string;
  country: string;
  createdAt: string;
}

export interface CreateCustomerRequest {
  customerId: string;
  firstName: string;
  lastName: string;
  email?: string;
  status?: CustomerStatus;
}

export interface PatchCustomerRequest {
  firstName?: string;
  lastName?: string;
  email?: string | null;
  status?: CustomerStatus;
}

export interface CreateAddressRequest {
  addressId?: string;
  customerId: string;
  street: string;
  postalCode: string;
  country: string;
}

export interface MergeCustomersRequest {
  survivorId: string;
  mergedId: string;
}

export interface CustomerResponse {
  customer: Customer;
}

export interface AddressResponse {
  address: Address;
}

export interface MergeCustomersResponse {
  survivor: Customer;
  merged: Customer;
  reparentedAddressCount: number;
}

export interface ApiError {
  error: {
    code: string;
    message: string;
    details?: Record<string, string>;
  };
}

export interface HealthResponse {
  status: "ok";
  service: "testagent-api";
  database: "connected";
  counts: {
    customers: number;
    addresses: number;
  };
}

export interface CustomerListResponse {
  customers: Customer[];
}

export interface AddressListResponse {
  addresses: Address[];
}

export type ModelFieldType = "string" | "integer" | "number" | "boolean" | "date" | "datetime";
export type ModelSourceFormat = "canonical" | "json-schema" | "mermaid";
export type LocaleCode = "en" | "nl" | "de";
export type PrimitiveValue = string | number | boolean | null;
export type GenerationRuleKind =
  | "fixed"
  | "sequence"
  | "uuid"
  | "firstName"
  | "lastName"
  | "fullName"
  | "companyName"
  | "email"
  | "streetAddress"
  | "postalCode"
  | "countryCode"
  | "enum"
  | "string"
  | "integer"
  | "decimal"
  | "date"
  | "datetime"
  | "boolean"
  | "foreignKey"
  | "parentLookup"
  | "derived";

export interface FieldCardinality {
  min: number;
  max?: number;
}

export interface ForeignKeyReference {
  entity: string;
  field: string;
}

export interface GenerationRule {
  kind: GenerationRuleKind;
  fixedValue?: PrimitiveValue;
  prefix?: string;
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  values?: PrimitiveValue[];
  weights?: number[];
  unique?: boolean;
  nullProbability?: number;
  ageMin?: number;
  ageMax?: number;
  fields?: string[];
  separator?: string;
  foreignKeyField?: string;
  targetField?: string;
  countryField?: string;
}

export interface RuleSuggestion {
  rule: GenerationRule;
  confidence: number;
  rationale: string;
}

export interface ModelField {
  name: string;
  type: ModelFieldType;
  format?: string;
  required: boolean;
  nullable: boolean;
  length?: { min?: number; max?: number };
  pattern?: string;
  minimum?: number;
  maximum?: number;
  enum?: PrimitiveValue[];
  primaryKey: boolean;
  unique: boolean;
  foreignKey?: ForeignKeyReference;
  foreignKeyCandidates?: ForeignKeyReference[];
  mappingRequired?: boolean;
  cardinality?: FieldCardinality;
  suggestion: RuleSuggestion;
}

export interface ModelEntity {
  name: string;
  fields: ModelField[];
}

export interface CanonicalModel {
  modelId?: string;
  version?: number;
  name: string;
  entities: ModelEntity[];
}

export interface ModelVersion {
  id: string;
  modelId: string;
  version: number;
  sourceFormat: ModelSourceFormat;
  model: CanonicalModel;
  createdAt: string;
}

export interface ModelListItem {
  id: string;
  name: string;
  latestVersion: number;
  latestVersionId: string;
  createdAt: string;
  updatedAt: string;
}

export interface ModelListResponse {
  models: ModelListItem[];
}

export interface ModelResponse {
  model: ModelVersion;
  versions: Array<Pick<ModelVersion, "id" | "version" | "sourceFormat" | "createdAt">>;
}

export type NegativeScenarioKind =
  | "missing_required"
  | "null_required"
  | "invalid_enum"
  | "invalid_length"
  | "invalid_format"
  | "orphan_fk"
  | "duplicate_match"
  | "boundary"
  | "unicode";

export interface GenerationProfileInput {
  modelVersionId: string;
  name: string;
  locale: LocaleCode;
  seed: string;
  referenceDate: string;
  recordCounts: Record<string, number>;
  rules: Record<string, GenerationRule>;
  negativeScenarios: NegativeScenarioKind[];
}

export interface GenerationProfile extends GenerationProfileInput {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export interface GenerationProfilesResponse {
  profiles: GenerationProfile[];
}

export interface GenerationProfileResponse {
  profile: GenerationProfile;
}

export interface DatasetCounts {
  entities: Record<string, number>;
  scenarios: Record<string, number>;
  total: number;
}

export interface DatasetFileManifest {
  combined: string;
  manifest: string;
  entities: Array<{ name: string; json: string; csv: string }>;
}

export interface DatasetManifest {
  id: string;
  name: string;
  status: "READY" | "FAILED" | "GENERATING";
  modelName: string;
  modelVersionId: string;
  seed: string;
  locale: LocaleCode;
  referenceDate: string;
  counts: DatasetCounts;
  files: DatasetFileManifest;
  createdAt: string;
  completedAt?: string;
}

export interface DatasetListResponse {
  datasets: DatasetManifest[];
}

export interface DatasetResponse {
  dataset: DatasetManifest;
}

export interface SyntheticRecordMetadata {
  scenarioId: string;
  expectedValid: boolean;
  reason?: string;
  sourceRecordId?: string;
  parentRecordId?: string;
}

export interface SyntheticRecord {
  recordId: string;
  entity: string;
  businessId?: PrimitiveValue;
  payload: Record<string, PrimitiveValue>;
  metadata: SyntheticRecordMetadata;
}

export interface DatasetRecordsResponse {
  datasetId: string;
  entity: string;
  page: number;
  pageSize: number;
  total: number;
  records: SyntheticRecord[];
}

export interface DatasetPreviewResponse {
  modelVersionId: string;
  profileId: string;
  counts: DatasetCounts;
  records: SyntheticRecord[];
}

export type TestEnvironment = "DEMO" | "DEV" | "QA" | "UAT";
export type ConnectionAuthType = "none" | "apiKey" | "bearer" | "basic";
export type TestHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type TestOperation = "INSERT" | "UPDATE" | "MERGE" | "DELETE" | "READ" | "VALIDATE" | "CUSTOM";
export type TestPriority = "P0" | "P1" | "P2" | "P3";
export type TestOutcomeExpectation = "positive" | "negative";
export type RunStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "CANCELLED" | "ERROR";
export type TestVerdict = "PASS" | "FAIL" | "ERROR" | "BLOCKED" | "CANCELLED";
export type AssertionOperator =
  | "equals"
  | "exists"
  | "notExists"
  | "contains"
  | "type"
  | "count"
  | "compareToInput";

export interface ConnectionInput {
  name: string;
  systemType: string;
  environment: TestEnvironment;
  baseUrl: string;
  authType: ConnectionAuthType;
  secretRef?: string;
  headers: Record<string, string>;
  timeoutMs: number;
  maxConcurrency: number;
  enabled: boolean;
}

export interface SystemConnection extends ConnectionInput {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export interface JsonPathAssertion {
  path: string;
  operator: AssertionOperator;
  expected?: unknown;
}

export interface TestStep {
  id: string;
  name: string;
  method: TestHttpMethod;
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
  expectedStatuses: number[];
  responseSchema?: unknown;
  assertions: JsonPathAssertion[];
  extract?: Record<string, string>;
  timeoutMs?: number;
}

export interface TestCaseRecordSelector {
  entity: string;
  expectedValid?: boolean;
  scenarioId?: string;
}

export interface TestCaseDefinition {
  id: string;
  name: string;
  operation: TestOperation;
  entity: string;
  recordSelector: TestCaseRecordSelector;
  priority: TestPriority;
  critical: boolean;
  expectedOutcome: TestOutcomeExpectation;
  dependsOn: string[];
  steps: TestStep[];
  pbi?: string;
}

export interface TestSuiteInput {
  name: string;
  cases: TestCaseDefinition[];
}

export interface TestSuite extends TestSuiteInput {
  id: string;
  version: number;
  versionId: string;
  createdAt: string;
  updatedAt: string;
}

export interface TestSuiteListItem {
  id: string;
  name: string;
  latestVersion: number;
  latestVersionId: string;
  caseCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface TestSuiteListResponse {
  suites: TestSuiteListItem[];
}

export interface TestSuitesResponse {
  suites: TestSuite[];
}

export interface TestSuiteResponse {
  suite: TestSuite;
}

export interface TestRunCounters {
  planned: number;
  executed: number;
  passed: number;
  failed: number;
  errors: number;
  blocked: number;
  cancelled: number;
}

export interface TestRun {
  id: string;
  status: RunStatus;
  suiteId: string;
  suiteVersion: number;
  suiteName: string;
  connectionId: string;
  connectionName: string;
  datasetId: string;
  datasetName: string;
  namespace: string;
  counters: TestRunCounters;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  logError?: string;
}

export interface TestRunInput {
  suiteId: string;
  connectionId: string;
  datasetId: string;
}

export interface TestRunsResponse {
  runs: TestRun[];
}

export interface TestRunResponse {
  run: TestRun;
}

export interface AssertionResult {
  path: string;
  operator: AssertionOperator;
  passed: boolean;
  expected?: unknown;
  actual?: unknown;
  message: string;
}

export interface TestStepResult {
  id: string;
  stepId: string;
  name: string;
  method: TestHttpMethod;
  url: string;
  requestBody?: unknown;
  responseStatus?: number;
  responseBody?: unknown;
  responseTruncated: boolean;
  latencyMs?: number;
  assertions: AssertionResult[];
  error?: string;
  correlationId: string;
  createdAt: string;
}

export interface TestResult {
  id: string;
  runId: string;
  caseId: string;
  caseName: string;
  operation: TestOperation;
  entity: string;
  priority: TestPriority;
  critical: boolean;
  expectedOutcome: TestOutcomeExpectation;
  inputRecordId: string;
  scenarioId: string;
  status: TestVerdict | "RUNNING";
  summary: string;
  error?: string;
  pbi?: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  steps: TestStepResult[];
}

export interface TestResultsResponse {
  runId: string;
  results: TestResult[];
}
