import { createHash } from "node:crypto";
import { faker as fakerEn, type Faker } from "@faker-js/faker";
import { faker as fakerDe } from "@faker-js/faker/locale/de";
import { faker as fakerNl } from "@faker-js/faker/locale/nl";
import type {
  CanonicalModel,
  DatasetCounts,
  GenerationProfile,
  GenerationRule,
  LocaleCode,
  ModelEntity,
  ModelField,
  NegativeScenarioKind,
  PrimitiveValue,
  SyntheticRecord,
} from "@agentx/shared";
import { HttpError } from "./http-error.js";
import { topologicalEntities } from "./model-import.js";

export interface GeneratedDataset {
  counts: DatasetCounts;
  records: SyntheticRecord[];
  entityOrder: string[];
}

interface ParentAssignment {
  record: SyntheticRecord;
  payload: Record<string, PrimitiveValue>;
}

const fakerByLocale: Record<LocaleCode, Faker> = {
  en: fakerEn,
  nl: fakerNl,
  de: fakerDe,
};
const datasetLimit = 10_000;

export function defaultRecordCounts(model: CanonicalModel): Record<string, number> {
  const counts: Record<string, number> = {};
  const sortedEntities = topologicalEntities(model);
  for (const entity of sortedEntities) {
    const parents = entity.fields
      .filter((field) => field.foreignKey)
      .map((field) => {
        const parentCount = counts[field.foreignKey!.entity] ?? 10;
        const cardinality = field.cardinality ?? { min: 1, max: 2 };
        const average = cardinality.max === undefined ? cardinality.min + 1 : (cardinality.min + cardinality.max) / 2;
        return Math.max(0, Math.round(parentCount * average));
      });
    counts[entity.name] = parents.length > 0
      ? Math.max(...parents)
      : 20;
  }
  return counts;
}

export function defaultProfileRules(model: CanonicalModel): Record<string, GenerationRule> {
  const rules: Record<string, GenerationRule> = {};
  const entityByName = new Map(model.entities.map((entity) => [entity.name, entity]));
  for (const entity of model.entities) {
    for (const field of entity.fields) {
      let rule = structuredClone(field.suggestion.rule);
      if (field.foreignKey) {
        rule = { kind: "foreignKey" };
      } else if (normalizedFieldName(field.name) === "countrycode") {
        const fk = entity.fields.find((candidate) => candidate.foreignKey);
        const parent = fk ? entityByName.get(fk.foreignKey!.entity) : undefined;
        if (fk && parent?.fields.some((candidate) => normalizedFieldName(candidate.name) === "countrycode")) {
          rule = { kind: "parentLookup", foreignKeyField: fk.name, targetField: parent.fields.find((candidate) => normalizedFieldName(candidate.name) === "countrycode")!.name };
        } else if (field.enum?.length) {
          rule = { kind: "enum", values: field.enum };
        } else {
          rule = { kind: "countryCode", values: ["NL", "GB", "DE"] };
        }
      } else if (field.enum?.length) {
        rule = {
          kind: "enum",
          values: field.enum,
          ...(field.unique ? { unique: true } : {}),
        };
      }
      if (field.nullable) rule.nullProbability = 0;
      rules[`${entity.name}.${field.name}`] = rule;
    }
  }
  return rules;
}

export function createDefaultProfile(
  model: CanonicalModel,
  modelVersionId: string,
  id = "draft",
): GenerationProfile {
  const now = new Date().toISOString();
  return {
    id,
    modelVersionId,
    name: `${model.name} demo profile`,
    locale: "nl",
    seed: "testagent-demo-2026",
    referenceDate: "2026-01-01",
    recordCounts: defaultRecordCounts(model),
    rules: defaultProfileRules(model),
    negativeScenarios: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function validateProfile(
  profile: Omit<GenerationProfile, "id" | "createdAt" | "updatedAt">,
  model: CanonicalModel,
): void {
  if (!profile.name.trim() || profile.name.length > 80) {
    throw new HttpError(400, "INVALID_PROFILE_NAME", "Generation profile name must be 1–80 characters.");
  }
  if (!["en", "nl", "de"].includes(profile.locale)) {
    throw new HttpError(400, "INVALID_LOCALE", "Locale must be en, nl, or de.");
  }
  if (!profile.seed.trim() || profile.seed.length > 100) {
    throw new HttpError(400, "INVALID_SEED", "Seed must be 1–100 characters.");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(profile.referenceDate) || !Number.isFinite(Date.parse(`${profile.referenceDate}T00:00:00.000Z`))) {
    throw new HttpError(400, "INVALID_REFERENCE_DATE", "Reference date must be a valid YYYY-MM-DD date.");
  }
  if (model.entities.some((entity) => entity.fields.some((field) => field.mappingRequired))) {
    throw new HttpError(409, "FOREIGN_KEY_MAPPING_REQUIRED", "Resolve every ambiguous foreign-key mapping before creating a generation profile.");
  }
  topologicalEntities(model);

  const entityNames = new Set(model.entities.map((entity) => entity.name));
  const unknownCounts = Object.keys(profile.recordCounts).filter((name) => !entityNames.has(name));
  if (unknownCounts.length > 0) {
    throw new HttpError(400, "UNKNOWN_ENTITY_COUNT", `Record counts reference unknown entities: ${unknownCounts.join(", ")}.`);
  }
  let total = 0;
  for (const entity of model.entities) {
    const count = profile.recordCounts[entity.name];
    if (!Number.isInteger(count) || count < 0 || count > datasetLimit) {
      throw new HttpError(400, "INVALID_RECORD_COUNT", `${entity.name} count must be an integer between 0 and ${datasetLimit}.`);
    }
    total += count;
  }
  if (total > datasetLimit) {
    throw new HttpError(400, "GENERATION_LIMIT_EXCEEDED", `A dataset may contain at most ${datasetLimit} valid records.`);
  }

  const fieldPaths = new Set(model.entities.flatMap((entity) => entity.fields.map((field) => `${entity.name}.${field.name}`)));
  const unknownRules = Object.keys(profile.rules).filter((path) => !fieldPaths.has(path));
  if (unknownRules.length > 0) {
    throw new HttpError(400, "UNKNOWN_FIELD_RULE", `Generation rules reference unknown fields: ${unknownRules.join(", ")}.`);
  }
  for (const entity of model.entities) {
    for (const field of entity.fields) {
      const rule = profile.rules[`${entity.name}.${field.name}`] ?? field.suggestion.rule;
      validateRule(rule, field, entity, model, profile.recordCounts[entity.name]);
    }
  }
  const scenarios = new Set<NegativeScenarioKind>([
    "missing_required", "null_required", "invalid_enum", "invalid_length", "invalid_format",
    "orphan_fk", "duplicate_match", "boundary", "unicode",
  ]);
  if (profile.negativeScenarios.some((scenario) => !scenarios.has(scenario))) {
    throw new HttpError(400, "UNKNOWN_NEGATIVE_SCENARIO", "A selected negative scenario is not supported.");
  }
}

export function generateDataset(
  model: CanonicalModel,
  profile: GenerationProfile,
  datasetId: string,
): GeneratedDataset {
  validateProfile(profile, model);
  const orderedEntities = topologicalEntities(model);
  const faker = fakerByLocale[profile.locale];
  const numericSeed = seedToNumber(profile.seed);
  faker.seed(numericSeed);
  const random = seededRandom(numericSeed);
  const recordsByEntity = new Map<string, ParentAssignment[]>();
  const allRecords: SyntheticRecord[] = [];
  const recordsPerEntity: Record<string, number> = {};
  const scenarioCounts: Record<string, number> = { valid: 0 };
  const uniqueValues = new Map<string, Set<string>>();

  for (const entity of orderedEntities) {
    const count = profile.recordCounts[entity.name];
    const foreignKeys = entity.fields.filter((field) => field.foreignKey);
    const assignments = new Map<string, ParentAssignment[]>();
    for (const field of foreignKeys) {
      const reference = field.foreignKey!;
      const parentRecords = recordsByEntity.get(reference.entity) ?? [];
      if (parentRecords.length === 0 && count > 0) {
        throw new HttpError(400, "EMPTY_FOREIGN_KEY_PARENT", `${entity.name}.${field.name} references ${reference.entity}, which has no generated records.`);
      }
      const allocation = allocateParentRecords(count, parentRecords, field, random);
      assignments.set(field.name, allocation);
    }

    const fieldOrder = orderedFields(entity, profile.rules);
    const records: ParentAssignment[] = [];
    for (let index = 0; index < count; index += 1) {
      const payload: Record<string, PrimitiveValue> = {};
      let parentRecordId: string | undefined;
      for (const field of fieldOrder) {
        const rule = profile.rules[`${entity.name}.${field.name}`] ?? field.suggestion.rule;
        const parentAssignment = assignments.get(field.name)?.[index];
        if (parentAssignment) parentRecordId ??= parentAssignment.record.recordId;
        const unique = field.primaryKey || field.unique || rule.unique === true;
        const uniqueKey = `${entity.name}.${field.name}`;
        const seen = uniqueValues.get(uniqueKey) ?? new Set<string>();
        uniqueValues.set(uniqueKey, seen);
        const value = generateUniqueValue({
          field,
          rule,
          entity,
          record: payload,
          parent: parentAssignment?.payload,
          index,
          profile,
          faker,
          random,
          seen,
          unique,
        });
        if (value !== undefined) payload[field.name] = value;
      }
      const businessId = primaryBusinessId(entity, payload);
      const recordId = `${safeEntityName(entity.name)}-${String(index + 1).padStart(6, "0")}`;
      const record: SyntheticRecord = {
        recordId,
        entity: entity.name,
        ...(businessId !== undefined ? { businessId } : {}),
        payload,
        metadata: {
          scenarioId: "valid",
          expectedValid: true,
          ...(parentRecordId ? { parentRecordId } : {}),
        },
      };
      const violations = validatePayload(model, entity, payload, recordsByEntity);
      if (violations.length > 0) {
        throw new HttpError(422, "GENERATED_RECORD_INVALID", `${entity.name} record ${index + 1} violates model constraints: ${violations.join("; ")}.`);
      }
      const parentPayload = foreignKeys.length > 0 ? assignments.get(foreignKeys[0].name)?.[index]?.payload : undefined;
      records.push({ record, payload });
      allRecords.push(record);
      scenarioCounts.valid += 1;
    }
    recordsByEntity.set(entity.name, records);
    recordsPerEntity[entity.name] = count;
  }

  const negatives = generateNegativeRecords(model, profile, recordsByEntity, numericSeed, scenarioCounts);
  for (const record of negatives) {
    allRecords.push(record);
    recordsPerEntity[record.entity] = (recordsPerEntity[record.entity] ?? 0) + 1;
  }
  if (allRecords.length > datasetLimit) {
    throw new HttpError(400, "GENERATION_LIMIT_EXCEEDED", `The generated dataset exceeds the ${datasetLimit}-record local cap.`);
  }

  return {
    records: allRecords,
    entityOrder: orderedEntities.map((entity) => entity.name),
    counts: {
      entities: recordsPerEntity,
      scenarios: scenarioCounts,
      total: allRecords.length,
    },
  };
}

export function validatePayload(
  model: CanonicalModel,
  entity: ModelEntity,
  payload: Record<string, PrimitiveValue>,
  recordsByEntity: Map<string, ParentAssignment[]>,
): string[] {
  const violations: string[] = [];
  for (const field of entity.fields) {
    const hasValue = Object.prototype.hasOwnProperty.call(payload, field.name);
    const value = payload[field.name];
    if (!hasValue) {
      if (field.required) violations.push(`${field.name}:required`);
      continue;
    }
    if (value === null) {
      if (!field.nullable) violations.push(`${field.name}:null_not_allowed`);
      continue;
    }
    if (!matchesFieldType(field.type, value)) {
      violations.push(`${field.name}:type`);
      continue;
    }
    if (field.length && typeof value === "string") {
      if (field.length.min !== undefined && value.length < field.length.min) violations.push(`${field.name}:min_length`);
      if (field.length.max !== undefined && value.length > field.length.max) violations.push(`${field.name}:max_length`);
    }
    if (field.pattern && typeof value === "string" && !new RegExp(field.pattern).test(value)) {
      violations.push(`${field.name}:pattern`);
    }
    if (field.enum && !field.enum.includes(value)) violations.push(`${field.name}:enum`);
    if (typeof value === "number") {
      if (field.minimum !== undefined && value < field.minimum) violations.push(`${field.name}:minimum`);
      if (field.maximum !== undefined && value > field.maximum) violations.push(`${field.name}:maximum`);
    }
    if (field.format === "email" && typeof value === "string" && !/^[^@\s]+@example\.test$/i.test(value)) {
      violations.push(`${field.name}:format`);
    }
    if (field.format === "date" && typeof value === "string" && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      violations.push(`${field.name}:format`);
    }
    if (field.foreignKey) {
      const parentRecords = recordsByEntity.get(field.foreignKey.entity) ?? [];
      if (!parentRecords.some((parent) => parent.payload[field.foreignKey!.field] === value)) {
        violations.push(`${field.name}:foreign_key`);
      }
    }
    if (field.unique || field.primaryKey) {
      const currentRecords = recordsByEntity.get(entity.name) ?? [];
      if (currentRecords.some((entry) => entry.payload[field.name] === value)) {
        violations.push(`${field.name}:unique`);
      }
    }
  }
  return violations;
}

function validateRule(
  rule: GenerationRule,
  field: ModelField,
  entity: ModelEntity,
  model: CanonicalModel,
  recordCount: number,
): void {
  const allowed: GenerationRule["kind"][] = [
    "fixed", "sequence", "uuid", "firstName", "lastName", "fullName", "companyName", "email",
    "streetAddress", "postalCode", "countryCode", "enum", "string", "integer", "decimal", "date",
    "datetime", "boolean", "foreignKey", "parentLookup", "derived",
  ];
  if (!rule || !allowed.includes(rule.kind)) {
    throw new HttpError(400, "INVALID_GENERATION_RULE", `${entity.name}.${field.name} has an unsupported rule.`);
  }
  if (rule.nullProbability !== undefined && (!Number.isFinite(rule.nullProbability) || rule.nullProbability < 0 || rule.nullProbability > 1)) {
    throw new HttpError(400, "INVALID_NULL_PROBABILITY", `${entity.name}.${field.name} null probability must be between 0 and 1.`);
  }
  if (rule.nullProbability && !field.nullable) {
    throw new HttpError(400, "NULL_ON_REQUIRED_FIELD", `${entity.name}.${field.name} is not nullable and cannot have a null probability.`);
  }
  if (rule.kind === "enum") {
    if (!rule.values?.length) throw new HttpError(400, "EMPTY_ENUM_RULE", `${entity.name}.${field.name} enum rule needs at least one value.`);
    if (field.enum && rule.values.some((value) => !field.enum?.includes(value))) {
      throw new HttpError(400, "ENUM_RULE_OUTSIDE_MODEL", `${entity.name}.${field.name} rule contains values outside the model enum.`);
    }
    if (rule.weights && (
      rule.weights.length !== rule.values.length ||
      rule.weights.some((weight) => !Number.isFinite(weight) || weight < 0) ||
      rule.weights.every((weight) => weight === 0)
    )) {
      throw new HttpError(400, "INVALID_ENUM_WEIGHTS", `${entity.name}.${field.name} weights must align with enum values and include a positive weight.`);
    }
  }
  const min = rule.min ?? field.minimum;
  const max = rule.max ?? field.maximum;
  if (min !== undefined && max !== undefined && min > max) {
    throw new HttpError(400, "INVALID_RULE_RANGE", `${entity.name}.${field.name} minimum exceeds its maximum.`);
  }
  if (rule.minLength !== undefined && (!Number.isInteger(rule.minLength) || rule.minLength < 0)) {
    throw new HttpError(400, "INVALID_RULE_LENGTH", `${entity.name}.${field.name} minimum string length is invalid.`);
  }
  if (rule.maxLength !== undefined && (!Number.isInteger(rule.maxLength) || rule.maxLength < 1)) {
    throw new HttpError(400, "INVALID_RULE_LENGTH", `${entity.name}.${field.name} maximum string length is invalid.`);
  }
  if (rule.minLength !== undefined && rule.maxLength !== undefined && rule.minLength > rule.maxLength) {
    throw new HttpError(400, "INVALID_RULE_LENGTH", `${entity.name}.${field.name} minimum string length exceeds its maximum.`);
  }
  if (rule.pattern) validatePattern(rule.pattern, `${entity.name}.${field.name}`);
  if (field.foreignKey && rule.kind !== "foreignKey") {
    throw new HttpError(400, "INVALID_FOREIGN_KEY_RULE", `${entity.name}.${field.name} must use the foreignKey rule.`);
  }
  if (rule.kind === "foreignKey" && !field.foreignKey) {
    throw new HttpError(400, "INVALID_FOREIGN_KEY_RULE", `${entity.name}.${field.name} does not have a resolved foreign-key target.`);
  }
  if (rule.kind === "parentLookup") {
    const fk = entity.fields.find((candidate) => candidate.name === rule.foreignKeyField && candidate.foreignKey);
    if (!fk || !rule.targetField) {
      throw new HttpError(400, "INVALID_PARENT_LOOKUP", `${entity.name}.${field.name} parent lookup must name a mapped FK and parent field.`);
    }
    const parentEntity = model.entities.find((candidate) => candidate.name === fk.foreignKey!.entity);
    const parentField = parentEntity?.fields.find((candidate) => candidate.name === rule.targetField);
    if (!parentField) throw new HttpError(400, "INVALID_PARENT_LOOKUP", `${entity.name}.${field.name} references an unknown parent field.`);
  }
  if (rule.kind === "derived") {
    if (!rule.fields?.length || rule.fields.includes(field.name)) {
      throw new HttpError(400, "INVALID_DERIVED_RULE", `${entity.name}.${field.name} derived rule needs other source fields.`);
    }
    const fieldNames = new Set(entity.fields.map((candidate) => candidate.name));
    const invalid = rule.fields.filter((name) => !fieldNames.has(name));
    if (invalid.length > 0) {
      throw new HttpError(400, "INVALID_DERIVED_RULE", `${entity.name}.${field.name} references unknown source field(s): ${invalid.join(", ")}.`);
    }
  }
  if ((field.unique || field.primaryKey || rule.unique) && rule.kind === "enum" && rule.values && recordCount > rule.values.length) {
    throw new HttpError(400, "UNIQUE_ENUM_NOT_FEASIBLE", `${entity.name}.${field.name} requires more unique enum values than the rule provides.`);
  }
}

function allocateParentRecords(
  childCount: number,
  parentRecords: ParentAssignment[],
  field: ModelField,
  random: () => number,
): ParentAssignment[] {
  if (childCount === 0) return [];
  if (parentRecords.length === 0) return [];
  const cardinality = field.cardinality ?? { min: 1, max: 2 };
  const minimumTotal = parentRecords.length * cardinality.min;
  const maximumTotal = cardinality.max === undefined ? Number.POSITIVE_INFINITY : parentRecords.length * cardinality.max;
  if (childCount < minimumTotal || childCount > maximumTotal) {
    throw new HttpError(
      400,
      "INVALID_RELATIONSHIP_COUNTS",
      `${field.name} count ${childCount} cannot satisfy ${cardinality.min}–${cardinality.max ?? "many"} child records per each of ${parentRecords.length} parent records.`,
    );
  }
  const perParent = parentRecords.map(() => cardinality.min);
  let remaining = childCount - minimumTotal;
  let attempts = 0;
  while (remaining > 0) {
    const eligible = perParent
      .map((count, index) => ({ count, index }))
      .filter(({ count }) => cardinality.max === undefined || count < cardinality.max);
    if (eligible.length === 0 || attempts > childCount * Math.max(1, parentRecords.length)) {
      throw new HttpError(400, "INVALID_RELATIONSHIP_COUNTS", `Cannot distribute ${childCount} records for ${field.name} within its cardinality.`);
    }
    const selected = eligible[Math.floor(random() * eligible.length)];
    perParent[selected.index] += 1;
    remaining -= 1;
    attempts += 1;
  }
  const result: ParentAssignment[] = [];
  perParent.forEach((amount, index) => {
    for (let count = 0; count < amount; count += 1) result.push(parentRecords[index]);
  });
  return shuffle(result, random);
}

function generateUniqueValue(options: {
  field: ModelField;
  rule: GenerationRule;
  entity: ModelEntity;
  record: Record<string, PrimitiveValue>;
  parent?: Record<string, PrimitiveValue>;
  index: number;
  profile: GenerationProfile;
  faker: Faker;
  random: () => number;
  seen: Set<string>;
  unique: boolean;
}): PrimitiveValue | undefined {
  const { field, rule, entity, record, parent, index, profile, faker, random, seen, unique } = options;
  if (field.nullable && (rule.nullProbability ?? 0) > random()) return null;
  const attempts = unique ? 100 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = generateValue(field, rule, entity, record, parent, index + attempt, profile, faker, random);
    if (value === undefined || value === null || !unique) return value;
    const key = canonicalValue(value);
    if (!seen.has(key)) {
      seen.add(key);
      return value;
    }
  }
  throw new HttpError(422, "UNIQUE_VALUE_EXHAUSTED", `Unable to generate a unique value for ${entity.name}.${field.name} after 100 attempts.`);
}

function generateValue(
  field: ModelField,
  rule: GenerationRule,
  entity: ModelEntity,
  record: Record<string, PrimitiveValue>,
  parent: Record<string, PrimitiveValue> | undefined,
  index: number,
  profile: GenerationProfile,
  faker: Faker,
  random: () => number,
): PrimitiveValue | undefined {
  switch (rule.kind) {
    case "fixed":
      return rule.fixedValue ?? null;
    case "sequence": {
      const sequenceValue = (rule.min ?? 1) + index;
      return field.type === "string" ? `${rule.prefix ?? ""}${String(sequenceValue).padStart(6, "0")}` : sequenceValue;
    }
    case "uuid":
      return faker.string.uuid();
    case "firstName":
      return faker.person.firstName();
    case "lastName":
      return faker.person.lastName();
    case "fullName":
      return faker.person.fullName();
    case "companyName":
      return faker.company.name();
    case "email": {
      const first = stringFromRecord(record, "firstName") || faker.person.firstName();
      const last = stringFromRecord(record, "lastName") || faker.person.lastName();
      return `${slug(`${first}.${last}`)}${rule.unique || field.unique ? `.${String(index + 1).padStart(4, "0")}` : ""}@example.test`;
    }
    case "streetAddress":
      return faker.location.streetAddress();
    case "postalCode":
      return postalCodeForCountry(faker, record[rule.countryField ?? "countryCode"]);
    case "countryCode": {
      const values = rule.values ?? ["NL", "GB", "DE"];
      return values[Math.floor(random() * values.length)];
    }
    case "enum":
      return chooseWeighted(rule.values ?? field.enum ?? [], rule.weights, random);
    case "string": {
      const minLength = rule.minLength ?? field.length?.min ?? 6;
      const maxLength = rule.maxLength ?? field.length?.max ?? 16;
      const length = randomInteger(minLength, maxLength, random);
      if (rule.pattern) return faker.helpers.fromRegExp(new RegExp(rule.pattern));
      return faker.string.alphanumeric({ length });
    }
    case "integer": {
      const min = Math.ceil(rule.min ?? field.minimum ?? 0);
      const max = Math.floor(rule.max ?? field.maximum ?? 10_000);
      return randomInteger(min, max, random);
    }
    case "decimal": {
      const min = rule.min ?? field.minimum ?? 0;
      const max = rule.max ?? field.maximum ?? 1000;
      return Number((min + random() * (max - min)).toFixed(2));
    }
    case "date":
      return dateValue(rule, profile.referenceDate, random, false);
    case "datetime":
      return dateValue(rule, profile.referenceDate, random, true);
    case "boolean":
      return random() < 0.5;
    case "foreignKey":
      return parent && field.foreignKey ? parent[field.foreignKey.field] ?? null : null;
    case "parentLookup":
      return parent ? parent[rule.targetField ?? ""] ?? null : null;
    case "derived":
      return (rule.fields ?? []).map((name) => {
        const value = record[name];
        return value === null || value === undefined ? "" : String(value);
      }).join(rule.separator ?? "");
    default:
      throw new HttpError(400, "UNSUPPORTED_GENERATION_RULE", `${entity.name}.${field.name} has an unsupported rule ${rule.kind}.`);
  }
}

function orderedFields(entity: ModelEntity, rules: Record<string, GenerationRule>): ModelField[] {
  const remaining = new Map(entity.fields.map((field) => [field.name, field]));
  const completed = new Set<string>();
  const ordered: ModelField[] = [];
  while (remaining.size > 0) {
    const ready = Array.from(remaining.values()).filter((field) => {
      const rule = rules[`${entity.name}.${field.name}`] ?? field.suggestion.rule;
      if (rule.kind === "derived") return (rule.fields ?? []).every((name) => completed.has(name));
      if (rule.kind === "postalCode" && rule.countryField) return completed.has(rule.countryField);
      return true;
    });
    if (ready.length === 0) {
      throw new HttpError(400, "CYCLIC_DERIVED_FIELDS", `Derived fields in ${entity.name} contain a dependency cycle.`);
    }
    for (const field of ready) {
      ordered.push(field);
      remaining.delete(field.name);
      completed.add(field.name);
    }
  }
  return ordered;
}

function generateNegativeRecords(
  model: CanonicalModel,
  profile: GenerationProfile,
  recordsByEntity: Map<string, ParentAssignment[]>,
  seed: number,
  scenarioCounts: Record<string, number>,
): SyntheticRecord[] {
  const result: SyntheticRecord[] = [];
  for (const scenario of profile.negativeScenarios) {
    const candidate = chooseScenarioTarget(model, recordsByEntity, scenario);
    const source = candidate.records[0]?.record;
    if (!source) {
      throw new HttpError(400, "SCENARIO_REQUIRES_RECORD", `Scenario ${scenario} needs at least one source record for ${candidate.entity.name}.`);
    }
    const payload = { ...source.payload };
    const target = candidate.field;
    let reason: string;
    let expectedValid = false;
    switch (scenario) {
      case "missing_required":
        delete payload[target.name];
        reason = `Required field ${candidate.entity.name}.${target.name} is omitted.`;
        break;
      case "null_required":
        payload[target.name] = null;
        reason = `Non-nullable required field ${candidate.entity.name}.${target.name} is null.`;
        break;
      case "invalid_enum":
        payload[target.name] = invalidPrimitive(target.enum ?? []);
        reason = `Field ${candidate.entity.name}.${target.name} uses a value outside its enumeration.`;
        break;
      case "invalid_length": {
        const maximum = target.length?.max ?? 20;
        payload[target.name] = "X".repeat(maximum + 1);
        reason = `Field ${candidate.entity.name}.${target.name} exceeds its maximum length.`;
        break;
      }
      case "invalid_format":
        payload[target.name] = "not-a-valid-email";
        reason = `Field ${candidate.entity.name}.${target.name} violates its email format.`;
        break;
      case "orphan_fk":
        payload[target.name] = target.type === "integer" || target.type === "number"
          ? -9_000_000 - seed
          : `ORPHAN-${seed}-${result.length + 1}`;
        reason = `Field ${candidate.entity.name}.${target.name} references a parent that is not in this dataset.`;
        break;
      case "duplicate_match": {
        const primaryKey = candidate.entity.fields.find((field) => field.primaryKey);
        if (primaryKey) {
          payload[primaryKey.name] = primaryKey.type === "string"
            ? `DUP-${seed}-${result.length + 1}`
            : 9_000_000 + result.length;
        }
        payload[target.name] = source.payload[target.name] ?? null;
        reason = `Business identity ${target.name} duplicates its source while retaining a distinct primary key.`;
        break;
      }
      case "boundary": {
        if (target.type === "integer" || target.type === "number") {
          payload[target.name] = target.minimum ?? 0;
        } else {
          payload[target.name] = target.length?.min ? "X".repeat(target.length.min) : "";
        }
        expectedValid = true;
        reason = `Field ${candidate.entity.name}.${target.name} is generated at its configured lower boundary.`;
        break;
      }
      case "unicode":
        payload[target.name] = "Zoë Δ";
        expectedValid = true;
        reason = `Field ${candidate.entity.name}.${target.name} contains Unicode text.`;
        break;
      default:
        throw new HttpError(400, "UNKNOWN_NEGATIVE_SCENARIO", `Scenario ${scenario} is not supported.`);
    }
    const parentRecordId = source.metadata.parentRecordId;
    const parentPayload = parentRecordId
      ? Array.from(recordsByEntity.values()).flat().find(({ record }) => record.recordId === parentRecordId)?.payload
      : undefined;
    for (const field of candidate.entity.fields.filter((item) => item.primaryKey || item.unique)) {
      if (field.name === target.name) continue;
      const key = `${candidate.entity.name}.${field.name}`;
      const seen = new Set(candidate.records
        .map(({ payload: existing }) => existing[field.name])
        .filter((value): value is string | number | boolean => value !== null && value !== undefined)
        .map(canonicalValue));
      const value = generateUniqueValue({
        field,
        rule: profile.rules[key] ?? field.suggestion.rule,
        entity: candidate.entity,
        record: payload,
        parent: parentPayload,
        index: candidate.records.length + result.length + 1,
        profile,
        faker: fakerByLocale[profile.locale],
        random: seededRandom(seed + result.length + 1),
        seen,
        unique: true,
      });
      if (value !== undefined) payload[field.name] = value;
    }
    const violations = validatePayload(model, candidate.entity, payload, recordsByEntity);
    if (expectedValid && violations.length > 0) {
      throw new HttpError(422, "INVALID_EDGE_RECORD", `Scenario ${scenario} violates additional constraints: ${violations.join("; ")}.`);
    }
    if (!expectedValid && violations.length === 0) {
      throw new HttpError(422, "SCENARIO_NOT_INVALID", `Scenario ${scenario} did not violate its intended constraint.`);
    }
    result.push({
      recordId: `${safeEntityName(candidate.entity.name)}-${scenario}-${String(result.length + 1).padStart(4, "0")}`,
      entity: candidate.entity.name,
      ...(primaryBusinessId(candidate.entity, payload) !== undefined
        ? { businessId: primaryBusinessId(candidate.entity, payload) }
        : {}),
      payload,
      metadata: {
        scenarioId: scenario,
        expectedValid,
        reason,
        sourceRecordId: source.recordId,
        ...(source.metadata.parentRecordId ? { parentRecordId: source.metadata.parentRecordId } : {}),
      },
    });
    scenarioCounts[scenario] = (scenarioCounts[scenario] ?? 0) + 1;
  }
  return result;
}

function chooseScenarioTarget(
  model: CanonicalModel,
  recordsByEntity: Map<string, ParentAssignment[]>,
  scenario: NegativeScenarioKind,
): { entity: ModelEntity; field: ModelField; records: ParentAssignment[] } {
  const entities = topologicalEntities(model);
  let candidates: Array<{ entity: ModelEntity; field: ModelField }> = [];
  switch (scenario) {
    case "missing_required":
    case "null_required":
      candidates = entities.flatMap((entity) => entity.fields
        .filter((field) => field.required && !field.primaryKey && (scenario !== "null_required" || !field.nullable))
        .map((field) => ({ entity, field })));
      break;
    case "invalid_enum":
      candidates = entities.flatMap((entity) => entity.fields.filter((field) => field.enum?.length).map((field) => ({ entity, field })));
      break;
    case "invalid_length":
      candidates = entities.flatMap((entity) => entity.fields.filter((field) => field.type === "string" && field.length?.max !== undefined).map((field) => ({ entity, field })));
      break;
    case "invalid_format":
      candidates = entities.flatMap((entity) => entity.fields.filter((field) => field.format === "email").map((field) => ({ entity, field })));
      break;
    case "orphan_fk":
      candidates = entities.flatMap((entity) => entity.fields.filter((field) => field.foreignKey).map((field) => ({ entity, field })));
      break;
    case "duplicate_match":
      candidates = entities.flatMap((entity) => entity.fields
        .filter((field) => normalizedFieldName(field.name) === "email" && !field.primaryKey)
        .map((field) => ({ entity, field })));
      break;
    case "boundary":
      candidates = entities.flatMap((entity) => entity.fields
        .filter((field) => !field.primaryKey && !field.unique &&
          (field.type === "integer" || field.type === "number" || (field.type === "string" && field.length?.min !== undefined)))
        .map((field) => ({ entity, field })));
      break;
    case "unicode":
      candidates = entities.flatMap((entity) => entity.fields
        .filter((field) => field.type === "string" && !field.primaryKey && !field.unique && (!field.length?.max || field.length.max >= 5))
        .map((field) => ({ entity, field })));
      break;
  }
  const chosen = candidates.find(({ entity }) => (recordsByEntity.get(entity.name)?.length ?? 0) > 0);
  if (!chosen) {
    throw new HttpError(400, "SCENARIO_NOT_APPLICABLE", `Scenario ${scenario} does not match any populated, compatible model field.`);
  }
  return {
    ...chosen,
    records: recordsByEntity.get(chosen.entity.name) ?? [],
  };
}

function dateValue(rule: GenerationRule, referenceDate: string, random: () => number, includeTime: boolean): string {
  const reference = new Date(`${referenceDate}T00:00:00.000Z`);
  const ageMin = rule.ageMin ?? 18;
  const ageMax = rule.ageMax ?? 90;
  if (ageMin < 0 || ageMax < ageMin || ageMax > 125) {
    throw new HttpError(400, "INVALID_AGE_RANGE", "Age ranges must satisfy 0 <= ageMin <= ageMax <= 125.");
  }
  const age = randomInteger(ageMin, ageMax, random);
  const date = new Date(reference);
  date.setUTCFullYear(date.getUTCFullYear() - age);
  date.setUTCDate(date.getUTCDate() - randomInteger(0, 364, random));
  return includeTime ? date.toISOString() : date.toISOString().slice(0, 10);
}

function validatePattern(pattern: string, label: string): void {
  if (
    pattern.length > 128 ||
    /\\[1-9]|\(\?|\(\*|\{\d{4,}|(?:\*|\+|\?|\{\d+(?:,\d*)?\})\s*(?:\*|\+|\?|\{)/.test(pattern)
  ) {
    throw new HttpError(400, "UNSAFE_REGEX", `${label} regex uses unsupported or potentially unbounded constructs.`);
  }
  try {
    new RegExp(pattern);
  } catch {
    throw new HttpError(400, "INVALID_REGEX", `${label} regex is not valid.`);
  }
}

function postalCodeForCountry(faker: Faker, countryCode: PrimitiveValue | undefined): string {
  switch (countryCode) {
    case "NL":
      return `${String(randomInteger(1000, 9999, () => faker.number.float())).padStart(4, "0")} ${faker.string.alpha({ length: 2 }).toUpperCase()}`;
    case "DE":
      return String(randomInteger(10000, 99999, () => faker.number.float()));
    case "GB":
      return `${faker.string.alpha({ length: 2 }).toUpperCase()}${randomInteger(1, 9, () => faker.number.float())} ${randomInteger(1, 9, () => faker.number.float())}${faker.string.alpha({ length: 2 }).toUpperCase()}`;
    default:
      return faker.location.zipCode();
  }
}

function chooseWeighted(values: PrimitiveValue[], weights: number[] | undefined, random: () => number): PrimitiveValue {
  if (values.length === 0) throw new HttpError(400, "EMPTY_ENUM_RULE", "Enum rule has no values.");
  if (!weights) return values[Math.floor(random() * values.length)];
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let choice = random() * total;
  for (let index = 0; index < weights.length; index += 1) {
    choice -= weights[index];
    if (choice < 0) return values[index];
  }
  return values[values.length - 1];
}

function invalidPrimitive(values: PrimitiveValue[]): PrimitiveValue {
  if (values.every((value) => typeof value === "number")) {
    let candidate = 1;
    while (values.includes(candidate)) candidate += 1;
    return candidate;
  }
  if (values.every((value) => typeof value === "boolean")) {
    if (values.includes(true) && values.includes(false)) return "__INVALID_ENUM_VALUE__";
    return !values.includes(true);
  }
  return "__INVALID_ENUM_VALUE__";
}

function matchesFieldType(type: ModelField["type"], value: PrimitiveValue): boolean {
  switch (type) {
    case "string":
    case "date":
    case "datetime":
      return typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
  }
}

function primaryBusinessId(entity: ModelEntity, payload: Record<string, PrimitiveValue>): PrimitiveValue | undefined {
  const primaryKey = entity.fields.find((field) => field.primaryKey);
  return primaryKey ? payload[primaryKey.name] : undefined;
}

function randomInteger(min: number, max: number, random: () => number): number {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) {
    throw new HttpError(400, "INVALID_RULE_RANGE", `Invalid generation range ${min}–${max}.`);
  }
  return Math.floor(random() * (max - min + 1)) + min;
}

function seedToNumber(seed: string): number {
  const hash = createHash("sha256").update(seed).digest();
  return hash.readUInt32LE(0);
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(values: T[], random: () => number): T[] {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [copy[index], copy[other]] = [copy[other], copy[index]];
  }
  return copy;
}

function canonicalValue(value: PrimitiveValue): string {
  return `${typeof value}:${String(value)}`;
}

function safeEntityName(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "entity";
}

function normalizedFieldName(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

function stringFromRecord(record: Record<string, PrimitiveValue>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function slug(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.+|\.+$/g, "") || "synthetic";
}
