import { Ajv, type AnySchema } from "ajv";
import type {
  CanonicalModel,
  FieldCardinality,
  ForeignKeyReference,
  GenerationRule,
  ModelEntity,
  ModelField,
  ModelFieldType,
  ModelSourceFormat,
  PrimitiveValue,
  RuleSuggestion,
} from "@agentx/shared";
import { HttpError } from "./http-error.js";

export interface RuleSuggestionProvider {
  suggest(entity: ModelEntity, field: Omit<ModelField, "suggestion">): RuleSuggestion;
}

export class DeterministicRuleSuggestionProvider implements RuleSuggestionProvider {
  suggest(entity: ModelEntity, field: Omit<ModelField, "suggestion">): RuleSuggestion {
    const name = normalizedName(field.name);
    const localFields = new Set(entity.fields.map((candidate) => candidate.name));
    if (field.foreignKey || field.mappingRequired) {
      return suggestion({ kind: "foreignKey", unique: false }, 0.99, "Foreign-key metadata requires a value from the mapped parent entity.");
    }
    if (field.primaryKey) {
      return suggestion(
        field.type === "string"
          ? { kind: "sequence", prefix: `${entity.name.toUpperCase()}-`, unique: true }
          : { kind: "sequence", min: 1, unique: true },
        0.99,
        "Primary keys need a deterministic unique sequence.",
      );
    }
    if (field.enum?.length) {
      return suggestion({ kind: "enum", values: field.enum }, 0.98, "The field has an explicit list of allowed values.");
    }
    if (name === "firstname" || name === "givenname") {
      return suggestion({ kind: "firstName" }, 0.96, "The field name indicates a localized given name.");
    }
    if (name === "lastname" || name === "surname" || name === "familyname") {
      return suggestion({ kind: "lastName" }, 0.96, "The field name indicates a localized family name.");
    }
    if (name === "displayname" && localFields.has("firstName") && localFields.has("lastName")) {
      return suggestion(
        { kind: "derived", fields: ["firstName", "lastName"], separator: " " },
        0.94,
        "Display name can be derived from the first and last name fields.",
      );
    }
    if (name === "email" || name === "emailaddress") {
      return suggestion({ kind: "email", unique: field.unique }, 0.97, "Use a synthetic address on the reserved example.test domain.");
    }
    if (name.includes("company") || name.includes("organization")) {
      return suggestion({ kind: "companyName" }, 0.9, "The field name indicates a localized company name.");
    }
    if (name.includes("street") || name === "addressline" || name === "addressline1") {
      return suggestion({ kind: "streetAddress" }, 0.91, "The field name indicates a localized synthetic street address.");
    }
    if (name.includes("postalcode") || name.includes("zipcode")) {
      const country = entity.fields.find((candidate) => normalizedName(candidate.name) === "countrycode")
        ?? entity.fields.find((candidate) => normalizedName(candidate.name) === "country");
      return suggestion(
        { kind: "postalCode", ...(country ? { countryField: country.name } : {}) },
        0.94,
        "Postal codes use the selected country rule and Faker locale.",
      );
    }
    if (name === "country" || name === "countrycode") {
      return suggestion(
        field.enum?.length ? { kind: "enum", values: field.enum } : { kind: "countryCode" },
        0.88,
        "Country code and Faker language are separate settings.",
      );
    }
    if (name.includes("dateofbirth") || name === "dob" || name === "birthdate") {
      return suggestion({ kind: "date", ageMin: 18, ageMax: 90 }, 0.94, "A fixed reference date and age range make birth dates reproducible.");
    }
    if (name === "status" && field.enum?.length) {
      return suggestion({ kind: "enum", values: field.enum }, 0.99, "Status values are selected from the model's list of values.");
    }
    if (field.type === "integer") {
      return suggestion(
        { kind: "integer", min: field.minimum ?? 0, max: field.maximum ?? 1000, unique: field.unique },
        0.8,
        "Generate an integer inside the declared bounds.",
      );
    }
    if (field.type === "number") {
      return suggestion(
        { kind: "decimal", min: field.minimum ?? 0, max: field.maximum ?? 1000, unique: field.unique },
        0.8,
        "Generate a decimal inside the declared bounds.",
      );
    }
    if (field.type === "date" || field.type === "datetime") {
      return suggestion({ kind: field.type }, 0.8, "Use the profile's fixed reference date for reproducible values.");
    }
    if (field.type === "boolean") {
      return suggestion({ kind: "boolean" }, 0.75, "Generate a boolean value.");
    }
    return suggestion(
      { kind: "string", minLength: field.length?.min ?? 6, maxLength: field.length?.max ?? 16 },
      0.55,
      "No specific semantic pattern was found; use a bounded synthetic string.",
    );
  }
}

export const defaultRuleSuggestionProvider = new DeterministicRuleSuggestionProvider();

export function importModel(
  sourceFormat: ModelSourceFormat,
  sourceText: string,
  provider: RuleSuggestionProvider = defaultRuleSuggestionProvider,
): CanonicalModel {
  let parsed: unknown;
  if (sourceFormat === "mermaid") {
    return normalizeCanonicalModel(parseMermaid(sourceText), provider);
  }
  try {
    parsed = JSON.parse(sourceText) as unknown;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "invalid JSON";
    throw new HttpError(400, "INVALID_MODEL_JSON", `Model document is not valid JSON: ${reason}`);
  }

  if (sourceFormat === "smart-mdm") {
    return normalizeCanonicalModel(smartMdmToCanonical(parsed), provider);
  }
  if (isObject(parsed) && parsed.format === "smart-mdm/schema") {
    throw new HttpError(400, "WRONG_MODEL_FORMAT", "This is a Smart MDM export. Select the smart-mdm import format.");
  }
  if (sourceFormat === "json-schema") {
    return normalizeCanonicalModel(jsonSchemaToCanonical(parsed), provider);
  }
  if (sourceFormat === "canonical") {
    return normalizeCanonicalModel(parsed, provider);
  }
  throw new HttpError(400, "UNSUPPORTED_MODEL_FORMAT", `Unsupported model format: ${String(sourceFormat)}`);
}

export function normalizeCanonicalModel(
  input: unknown,
  provider: RuleSuggestionProvider = defaultRuleSuggestionProvider,
): CanonicalModel {
  if (!isObject(input) || !Array.isArray(input.entities) || input.entities.length === 0) {
    throw new HttpError(400, "INVALID_CANONICAL_MODEL", "A canonical model must contain a name and at least one entity.");
  }
  const name = stringValue(input.name, "Model name", 120);
  assertKnownKeys(input, new Set(["name", "entities", "modelId", "version"]), "canonical model");
  const entities: ModelEntity[] = input.entities.map((entityValue, entityIndex) => {
    if (!isObject(entityValue) || !Array.isArray(entityValue.fields) || entityValue.fields.length === 0) {
      throw new HttpError(400, "INVALID_CANONICAL_MODEL", `Entity ${entityIndex + 1} must contain at least one field.`);
    }
    assertKnownKeys(entityValue, new Set(["name", "fields"]), `entity ${entityIndex + 1}`);
    const entityName = stringValue(entityValue.name, `Entity ${entityIndex + 1} name`, 80);
    const fields: ModelField[] = entityValue.fields.map((fieldValue, fieldIndex) => {
      if (!isObject(fieldValue)) {
        throw new HttpError(400, "INVALID_CANONICAL_MODEL", `${entityName} field ${fieldIndex + 1} must be an object.`);
      }
      assertKnownKeys(fieldValue, new Set([
        "name", "type", "format", "required", "nullable", "length", "minLength", "maxLength",
        "minimum", "maximum", "min", "max", "pattern", "enum", "primaryKey", "unique",
        "foreignKey", "foreignKeyCandidates", "mappingRequired", "cardinality", "suggestion",
      ]), `${entityName} field ${fieldIndex + 1}`);
      const fieldName = stringValue(fieldValue.name, `${entityName} field name`, 80);
      const type = parseFieldType(fieldValue.type, `${entityName}.${fieldName}`);
      const required = booleanValue(fieldValue.required, false);
      const primaryKey = booleanValue(fieldValue.primaryKey, false);
      const unique = primaryKey || booleanValue(fieldValue.unique, false);
      const foreignKey = parseForeignKey(fieldValue.foreignKey, `${entityName}.${fieldName}`);
      const foreignKeyCandidates = Array.isArray(fieldValue.foreignKeyCandidates)
        ? fieldValue.foreignKeyCandidates.filter(isObject).map((candidate) => ({
          entity: stringValue(candidate.entity, `${entityName}.${fieldName} FK candidate entity`),
          field: stringValue(candidate.field, `${entityName}.${fieldName} FK candidate field`),
        }))
        : foreignKey.candidates;
      const cardinality = parseCardinality(fieldValue.cardinality, `${entityName}.${fieldName}`);
      const length = parseLength(fieldValue.length, fieldValue.minLength, fieldValue.maxLength, `${entityName}.${fieldName}`);
      const enumValues = parseEnum(fieldValue.enum, `${entityName}.${fieldName}`);
      const nullable = fieldValue.nullable === undefined ? !required : booleanValue(fieldValue.nullable, !required);
      const minimum = optionalNumber(fieldValue.minimum ?? fieldValue.min, `${entityName}.${fieldName} minimum`);
      const maximum = optionalNumber(fieldValue.maximum ?? fieldValue.max, `${entityName}.${fieldName} maximum`);
      if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
        throw new HttpError(400, "INVALID_FIELD_CONSTRAINT", `${entityName}.${fieldName} minimum exceeds its maximum.`);
      }

      const partial = {
        name: fieldName,
        type,
        ...(typeof fieldValue.format === "string" ? { format: fieldValue.format } : {}),
        required,
        nullable,
        ...(length ? { length } : {}),
        ...(typeof fieldValue.pattern === "string" ? { pattern: fieldValue.pattern } : {}),
        ...(minimum !== undefined ? { minimum } : {}),
        ...(maximum !== undefined ? { maximum } : {}),
        ...(enumValues ? { enum: enumValues } : {}),
        primaryKey,
        unique,
        ...(foreignKey.reference ? { foreignKey: foreignKey.reference } : {}),
        ...(foreignKeyCandidates.length > 0 ? { foreignKeyCandidates } : {}),
        ...(foreignKey.mappingRequired || fieldValue.mappingRequired === true ? { mappingRequired: true } : {}),
        ...(cardinality ? { cardinality } : {}),
      } satisfies Omit<ModelField, "suggestion">;
      return { ...partial, suggestion: provider.suggest({ name: entityName, fields: [] }, partial) };
    });
    assertNoDuplicates(fields.map((field) => field.name), `field in entity ${entityName}`);
    return { name: entityName, fields };
  });

  assertNoDuplicates(entities.map((entity) => entity.name), "entity");
  const model: CanonicalModel = { name, entities };
  resolveForeignKeyCandidates(model);
  validateModelRelationships(model);
  for (const entity of model.entities) {
    for (const field of entity.fields) {
      field.suggestion = provider.suggest(entity, field);
    }
  }
  return model;
}

export function topologicalEntities(model: CanonicalModel): ModelEntity[] {
  const byName = new Map(model.entities.map((entity) => [entity.name, entity]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const sorted: ModelEntity[] = [];

  function visit(entity: ModelEntity): void {
    if (visited.has(entity.name)) return;
    if (visiting.has(entity.name)) {
      throw new HttpError(400, "CYCLIC_MODEL_RELATIONSHIP", `Cyclic foreign-key relationship detected at entity ${entity.name}.`);
    }
    visiting.add(entity.name);
    for (const field of entity.fields) {
      if (field.foreignKey) {
        const parent = byName.get(field.foreignKey.entity);
        if (parent) visit(parent);
      }
    }
    visiting.delete(entity.name);
    visited.add(entity.name);
    sorted.push(entity);
  }

  for (const entity of model.entities) visit(entity);
  return sorted;
}

function smartMdmToCanonical(input: unknown): unknown {
  if (!isObject(input) || input.format !== "smart-mdm/schema" || input.formatVersion !== 1 || !isObject(input.schema)) {
    throw new HttpError(400, "INVALID_SMART_MDM_SCHEMA", "Expected a smart-mdm/schema export with formatVersion 1 and a schema object.");
  }
  assertKnownKeys(input, new Set(["format", "formatVersion", "domain", "domainLabel", "exportedAt", "schema"]), "Smart MDM export");
  assertKnownKeys(input.schema, new Set(["fields", "children", "roles"]), "Smart MDM schema");
  const domain = stringValue(input.domain, "Smart MDM domain", 80);
  const name = stringValue(input.domainLabel, "Smart MDM domain label", 120);
  if (!Array.isArray(input.schema.fields) || !Array.isArray(input.schema.children)) {
    throw new HttpError(400, "INVALID_SMART_MDM_SCHEMA", "Smart MDM schema must contain fields and children arrays.");
  }
  const fields = (values: unknown[], entity: string): Array<Record<string, unknown>> => values.map((value) => {
    if (!isObject(value)) throw new HttpError(400, "INVALID_SMART_MDM_SCHEMA", `${entity} fields must be objects.`);
    assertKnownKeys(value, new Set(["key", "label", "type", "required", "options", "core", "pii", "description", "qualityRules"]), `${entity} field`);
    const field = stringValue(value.key, `${entity} field key`, 80);
    if (typeof value.required !== "boolean") {
      throw new HttpError(400, "INVALID_SMART_MDM_SCHEMA", `${entity}.${field} must declare whether it is required.`);
    }
    const type: ModelFieldType | undefined = value.type === "text" || value.type === "dropdown" ? "string"
      : value.type === "boolean" ? "boolean" : value.type === "date" ? "date" : undefined;
    if (!type) throw new HttpError(400, "UNSUPPORTED_FIELD_TYPE", `${entity}.${field} uses unsupported Smart MDM type ${String(value.type)}.`);
    if (value.options !== undefined && (!Array.isArray(value.options) || value.options.some((option) => typeof option !== "string" || !option))) {
      throw new HttpError(400, "INVALID_SMART_MDM_SCHEMA", `${entity}.${field} options must be an array of non-empty strings.`);
    }
    if (Array.isArray(value.options) && value.options.length > 0 && value.type !== "dropdown") {
      throw new HttpError(400, "INVALID_SMART_MDM_SCHEMA", `${entity}.${field} options are supported only for dropdown fields.`);
    }
    if (value.qualityRules !== undefined && !isObject(value.qualityRules)) {
      throw new HttpError(400, "INVALID_SMART_MDM_SCHEMA", `${entity}.${field} qualityRules must be an object.`);
    }
    const quality = isObject(value.qualityRules) ? value.qualityRules : {};
    assertKnownKeys(quality, new Set(["unique", "weight"]), `${entity}.${field} qualityRules`);
    if (quality.unique !== undefined && typeof quality.unique !== "boolean") {
      throw new HttpError(400, "INVALID_SMART_MDM_SCHEMA", `${entity}.${field} qualityRules.unique must be boolean.`);
    }
    return {
      name: field, type, required: value.required, nullable: !value.required,
      ...(Array.isArray(value.options) && value.options.length > 0 ? { enum: value.options } : {}),
      ...(quality.unique === true ? { unique: true } : {}),
    };
  });
  const entities = [{ name: domain, fields: fields(input.schema.fields, domain) }];
  for (const child of input.schema.children) {
    if (!isObject(child) || !Array.isArray(child.fields)) {
      throw new HttpError(400, "INVALID_SMART_MDM_SCHEMA", "Each Smart MDM child must contain a fields array.");
    }
    assertKnownKeys(child, new Set(["key", "label", "fields", "absence", "matchKey", "maxOccurrences"]), "Smart MDM child");
    const childName = stringValue(child.key, "Smart MDM child key", 80);
    entities.push({ name: childName, fields: fields(child.fields, childName) });
  }
  return { name, entities };
}

function jsonSchemaToCanonical(input: unknown): unknown {
  if (!isObject(input) || input.type !== "object") {
    throw new HttpError(400, "UNSUPPORTED_JSON_SCHEMA", "The supported JSON Schema subset requires an object root.");
  }
  assertSchemaKeywordSubset(input);
  assertLocalReferencesOnly(input);
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    formats: { email: true, date: true, "date-time": true, uuid: true },
  });
  try {
    if (!ajv.validateSchema(input)) {
      throw new HttpError(400, "INVALID_JSON_SCHEMA", `JSON Schema is invalid: ${ajv.errorsText(ajv.errors)}`);
    }
    ajv.compile(input as AnySchema);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "INVALID_JSON_SCHEMA", `JSON Schema could not be compiled: ${errorMessage(error)}`);
  }

  const root = input;
  const properties = isObject(root.properties) ? root.properties : undefined;
  const entities: Array<Record<string, unknown>> = [];
  if (properties) {
    for (const [entityName, rawEntitySchema] of Object.entries(properties)) {
      let entitySchema = resolveLocalSchema(rawEntitySchema, root);
      if (isObject(entitySchema) && entitySchema.type === "array") {
        entitySchema = resolveLocalSchema(entitySchema.items, root);
      }
      if (!isObject(entitySchema) || entitySchema.type !== "object" || !isObject(entitySchema.properties)) {
        continue;
      }
      entities.push(schemaEntityToCanonical(entityName, entitySchema, root));
    }
  }
  if (entities.length === 0) {
    const definitions = isObject(root.$defs) ? root.$defs : isObject(root.definitions) ? root.definitions : undefined;
    if (definitions) {
      for (const [entityName, rawEntitySchema] of Object.entries(definitions)) {
        const entitySchema = resolveLocalSchema(rawEntitySchema, root);
        if (isObject(entitySchema) && entitySchema.type === "object" && isObject(entitySchema.properties)) {
          entities.push(schemaEntityToCanonical(entityName, entitySchema, root));
        }
      }
    }
  }
  if (entities.length === 0) {
    throw new HttpError(400, "UNSUPPORTED_JSON_SCHEMA", "No entity object schemas were found in root properties or $defs.");
  }
  return {
    name: typeof root.title === "string" ? root.title : "Imported JSON Schema",
    entities,
  };
}

function schemaEntityToCanonical(
  name: string,
  schema: Record<string, unknown>,
  root: Record<string, unknown>,
): Record<string, unknown> {
  const requiredNames = new Set(Array.isArray(schema.required) ? schema.required.filter(isString) : []);
  const properties = schema.properties as Record<string, unknown>;
  const fields = Object.entries(properties).map(([fieldName, rawField]) => {
    const field = resolveLocalSchema(rawField, root);
    if (!isObject(field)) {
      throw new HttpError(400, "UNSUPPORTED_JSON_SCHEMA", `Field ${name}.${fieldName} must use a supported object schema.`);
    }
    const declaredType = field.type;
    const typeList = Array.isArray(declaredType) ? declaredType.filter(isString) : [declaredType];
    const nullable = typeList.includes("null") || field.nullable === true;
    const typeName = typeList.find((value) => value !== "null") ?? inferEnumType(field.enum);
    const type = parseFieldType(typeName, `${name}.${fieldName}`);
    return {
      name: fieldName,
      type,
      ...(typeof field.format === "string" ? { format: field.format } : {}),
      required: requiredNames.has(fieldName),
      nullable,
      ...(field.minLength !== undefined || field.maxLength !== undefined
        ? { length: { ...(field.minLength !== undefined ? { min: field.minLength } : {}), ...(field.maxLength !== undefined ? { max: field.maxLength } : {}) } }
        : {}),
      ...(typeof field.pattern === "string" ? { pattern: field.pattern } : {}),
      ...(field.minimum !== undefined ? { minimum: field.minimum } : {}),
      ...(field.maximum !== undefined ? { maximum: field.maximum } : {}),
      ...(Array.isArray(field.enum) ? { enum: field.enum } : {}),
      ...(field["x-primaryKey"] === true ? { primaryKey: true } : {}),
      ...(field["x-unique"] === true ? { unique: true } : {}),
      ...(field["x-foreignKey"] !== undefined ? { foreignKey: field["x-foreignKey"] } : {}),
      ...(field["x-cardinality"] !== undefined ? { cardinality: field["x-cardinality"] } : {}),
    };
  });
  return { name, fields };
}

function assertLocalReferencesOnly(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertLocalReferencesOnly(item);
    return;
  }
  if (!isObject(value)) return;
  if (typeof value.$ref === "string" && !value.$ref.startsWith("#/")) {
    throw new HttpError(400, "REMOTE_REF_BLOCKED", "Only local JSON Schema $ref values are supported; remote references are disabled.");
  }
  for (const child of Object.values(value)) assertLocalReferencesOnly(child);
}

function assertSchemaKeywordSubset(value: unknown): void {
  const supported = new Set([
    "$schema", "$id", "$defs", "definitions", "$ref", "title", "description", "type",
    "properties", "required", "items", "additionalProperties", "format", "enum", "minimum",
    "maximum", "minLength", "maxLength", "pattern", "nullable", "default",
    "x-primaryKey", "x-unique", "x-foreignKey", "x-cardinality",
  ]);
  if (Array.isArray(value)) {
    for (const item of value) assertSchemaKeywordSubset(item);
    return;
  }
  if (!isObject(value)) return;
  const unsupported = Object.keys(value).filter((key) => !supported.has(key));
  if (unsupported.length > 0) {
    throw new HttpError(400, "UNSUPPORTED_JSON_SCHEMA", `Unsupported JSON Schema keyword(s): ${unsupported.join(", ")}.`);
  }
  for (const key of ["properties", "$defs", "definitions"]) {
    const schemas = value[key];
    if (isObject(schemas)) {
      for (const schema of Object.values(schemas)) assertSchemaKeywordSubset(schema);
    }
  }
  const items = value.items;
  if (Array.isArray(items)) {
    for (const schema of items) assertSchemaKeywordSubset(schema);
  } else if (items !== undefined) {
    assertSchemaKeywordSubset(items);
  }
  if (isObject(value.additionalProperties)) {
    assertSchemaKeywordSubset(value.additionalProperties);
  }
}

function resolveLocalSchema(value: unknown, root: Record<string, unknown>, seen = new Set<string>()): unknown {
  if (!isObject(value) || typeof value.$ref !== "string") return value;
  const reference = value.$ref;
  if (!reference.startsWith("#/")) {
    throw new HttpError(400, "REMOTE_REF_BLOCKED", "Only local JSON Schema $ref values are supported.");
  }
  if (seen.has(reference)) {
    throw new HttpError(400, "RECURSIVE_JSON_SCHEMA_REF", `Recursive JSON Schema reference ${reference} is not supported.`);
  }
  if (Object.keys(value).some((key) => key !== "$ref")) {
    throw new HttpError(400, "UNSUPPORTED_JSON_SCHEMA", "Keywords alongside $ref are outside the supported JSON Schema subset.");
  }
  seen.add(reference);
  const segments = reference.slice(2).split("/").map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
  let resolved: unknown = root;
  for (const segment of segments) {
    if (!isObject(resolved) || !(segment in resolved)) {
      throw new HttpError(400, "UNRESOLVED_LOCAL_REF", `JSON Schema reference ${reference} does not resolve.`);
    }
    resolved = resolved[segment];
  }
  if (resolved === value) {
    throw new HttpError(400, "RECURSIVE_JSON_SCHEMA_REF", `Recursive JSON Schema reference ${reference} is not supported.`);
  }
  return resolveLocalSchema(resolved, root, seen);
}

function parseMermaid(sourceText: string): unknown {
  if (sourceText.length > 100_000) {
    throw new HttpError(413, "MODEL_TOO_LARGE", "Mermaid model text must be 100 KB or smaller.");
  }
  if (/[<>]/.test(sourceText) || /^\s*(?:click|linkStyle|classDef)\b/im.test(sourceText)) {
    throw new HttpError(400, "UNSAFE_MERMAID_CONTENT", "Mermaid HTML, links, and styling directives are not accepted.");
  }
  const lines = sourceText.split(/\r?\n/).map((line) => line.trim());
  if (lines[0] !== "erDiagram") {
    throw new HttpError(400, "INVALID_MERMAID", "Mermaid input must start with erDiagram.");
  }
  const entityFields = new Map<string, Array<Record<string, unknown>>>();
  const relationships: Array<{ left: string; leftCardinality: string; rightCardinality: string; right: string }> = [];
  let currentEntity: string | null = null;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line || line.startsWith("%%")) continue;
    if (currentEntity) {
      if (line === "}") {
        currentEntity = null;
        continue;
      }
      const field = parseMermaidAttribute(line, currentEntity);
      entityFields.get(currentEntity)?.push(field);
      continue;
    }
    if (line === "}") {
      throw new HttpError(400, "INVALID_MERMAID", `Unexpected closing brace on line ${index + 1}.`);
    }
    const entityMatch = /^([A-Za-z_][A-Za-z0-9_]*)\s*\{$/.exec(line);
    if (entityMatch) {
      const entityName = entityMatch[1];
      if (entityFields.has(entityName)) {
        throw new HttpError(400, "DUPLICATE_ENTITY", `Entity ${entityName} is declared more than once.`);
      }
      entityFields.set(entityName, []);
      currentEntity = entityName;
      continue;
    }
    const relationshipMatch = /^([A-Za-z_][A-Za-z0-9_]*)\s+([|o{}]+)--([|o{}]+)\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s*:\s*.+)?$/.exec(line);
    if (relationshipMatch) {
      relationships.push({
        left: relationshipMatch[1],
        leftCardinality: relationshipMatch[2],
        rightCardinality: relationshipMatch[3],
        right: relationshipMatch[4],
      });
      continue;
    }
    throw new HttpError(400, "UNSUPPORTED_MERMAID_SYNTAX", `Unsupported Mermaid ER syntax on line ${index + 1}: ${line}`);
  }
  if (currentEntity) throw new HttpError(400, "INVALID_MERMAID", `Entity ${currentEntity} is missing its closing brace.`);
  if (entityFields.size === 0) throw new HttpError(400, "INVALID_MERMAID", "No entity blocks were found.");

  const entities = Array.from(entityFields, ([name, fields]) => ({ name, fields }));
  for (const relation of relationships) {
    if (!entityFields.has(relation.left) || !entityFields.has(relation.right)) {
      throw new HttpError(400, "UNRESOLVED_RELATIONSHIP", `Relationship references an undeclared entity: ${relation.left} or ${relation.right}.`);
    }
    const leftMany = relation.leftCardinality.includes("{");
    const rightMany = relation.rightCardinality.includes("{");
    if (leftMany && rightMany) {
      throw new HttpError(400, "UNSUPPORTED_MANY_TO_MANY", `Many-to-many relationship ${relation.left} to ${relation.right} needs an explicit join entity.`);
    }
    const childName = leftMany ? relation.left : relation.right;
    const parentName = leftMany ? relation.right : relation.left;
    const childCardinality = leftMany ? relation.leftCardinality : relation.rightCardinality;
    const child = entities.find((entity) => entity.name === childName);
    const parent = entities.find((entity) => entity.name === parentName);
    if (!child || !parent) continue;

    const parentPrimaryKeys = parent.fields.filter((field) => field.primaryKey === true);
    if (parentPrimaryKeys.length !== 1) {
      throw new HttpError(400, "RELATIONSHIP_REQUIRES_PRIMARY_KEY", `Relationship target ${parentName} must declare exactly one PK attribute.`);
    }
    const flagged = child.fields.filter((field) => field.foreignKey === true);
    const inferred = child.fields.filter((field) => {
      if (typeof field.name !== "string") return false;
      const fieldName = normalizedName(field.name);
      return fieldName === normalizedName(`${parentName}Id`) ||
        fieldName === normalizedName(stringValue(parentPrimaryKeys[0].name, `${parentName} PK field`));
    });
    const candidates = flagged.length > 0 ? flagged : inferred;
    if (candidates.length === 0) {
      throw new HttpError(
        400,
        "RELATIONSHIP_FK_FIELD_REQUIRED",
        `Relationship ${parentName} to ${childName} needs an FK attribute or a field named ${parentName}Id.`,
      );
    }
    if (candidates.length > 1) {
      for (const candidate of candidates) {
        candidate.mappingRequired = true;
        candidate.foreignKeyCandidates = [{ entity: parentName, field: parentPrimaryKeys[0].name }];
        candidate.cardinality = cardinalityFromMermaid(childCardinality);
      }
      continue;
    }
    candidates[0].foreignKey = {
      entity: parentName,
      field: stringValue(parentPrimaryKeys[0].name, `${parentName} PK field`),
    };
    candidates[0].cardinality = cardinalityFromMermaid(childCardinality);
  }
  return { name: "Imported Mermaid Model", entities };
}

function parseMermaidAttribute(line: string, entityName: string): Record<string, unknown> {
  const match = /^([A-Za-z][A-Za-z0-9_]*(?:\([^)]*\))?)\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+(.+))?$/.exec(line);
  if (!match) {
    throw new HttpError(400, "UNSUPPORTED_MERMAID_ATTRIBUTE", `Unsupported attribute syntax in ${entityName}: ${line}`);
  }
  const declaredType = match[1];
  const typeMatch = /^([A-Za-z][A-Za-z0-9_]*)(?:\((\d+)\))?$/.exec(declaredType);
  if (!typeMatch) throw new HttpError(400, "UNSUPPORTED_MERMAID_TYPE", `Unsupported attribute type ${declaredType}.`);
  const type = parseFieldType(typeMatch[1], `${entityName}.${match[2]}`);
  const flags = new Set((match[3] ?? "").split(/[\s,]+/).map((flag) => flag.toUpperCase()).filter(Boolean));
  const primaryKey = flags.has("PK");
  const foreignKey = flags.has("FK");
  const unique = flags.has("UK") || primaryKey;
  const required = primaryKey || flags.has("NN") || flags.has("NOTNULL");
  const maxLength = typeMatch[2] ? Number(typeMatch[2]) : undefined;
  return {
    name: match[2],
    type,
    required,
    nullable: !required,
    ...(maxLength ? { length: { max: maxLength } } : {}),
    primaryKey,
    unique,
    ...(foreignKey ? { foreignKey: true } : {}),
  };
}

function cardinalityFromMermaid(marker: string): FieldCardinality {
  return { min: marker.includes("|") ? 1 : 0 };
}

function resolveForeignKeyCandidates(model: CanonicalModel): void {
  const primaryKeys = model.entities.flatMap((entity) =>
    entity.fields.filter((field) => field.primaryKey).map((field) => ({ entity: entity.name, field: field.name })),
  );
  for (const entity of model.entities) {
    for (const field of entity.fields) {
      if (field.foreignKey) continue;
      if (!field.mappingRequired && !field.foreignKeyCandidates?.length) continue;
      let candidates = field.foreignKeyCandidates ?? [];
      if (candidates.length === 0) {
        const fieldName = normalizedName(field.name);
        candidates = primaryKeys.filter((reference) =>
          reference.entity !== entity.name &&
          (fieldName === normalizedName(`${reference.entity}Id`) || fieldName === normalizedName(reference.field)),
        );
        if (candidates.length === 0) candidates = primaryKeys.filter((reference) => reference.entity !== entity.name);
      }
      if (candidates.length === 1) {
        field.foreignKey = candidates[0];
        field.mappingRequired = false;
        field.foreignKeyCandidates = candidates;
      } else {
        field.mappingRequired = true;
        field.foreignKeyCandidates = candidates;
      }
    }
  }
}

function validateModelRelationships(model: CanonicalModel): void {
  const entities = new Map(model.entities.map((entity) => [entity.name, entity]));
  for (const entity of model.entities) {
    const primaryKeys = entity.fields.filter((field) => field.primaryKey);
    if (primaryKeys.length > 1) {
      throw new HttpError(400, "COMPOSITE_PRIMARY_KEY_UNSUPPORTED", `Entity ${entity.name} has multiple primary keys; composite keys are not supported.`);
    }
    for (const field of entity.fields) {
      if (field.primaryKey && (field.nullable || !field.required)) {
        field.required = true;
        field.nullable = false;
      }
      if (field.mappingRequired) continue;
      if (!field.foreignKey) continue;
      const targetEntity = entities.get(field.foreignKey.entity);
      const targetField = targetEntity?.fields.find((candidate) => candidate.name === field.foreignKey?.field);
      if (!targetEntity || !targetField) {
        throw new HttpError(400, "UNRESOLVED_FOREIGN_KEY", `${entity.name}.${field.name} references an unknown field ${field.foreignKey.entity}.${field.foreignKey.field}.`);
      }
      if (!targetField.primaryKey && !targetField.unique) {
        throw new HttpError(400, "FOREIGN_KEY_TARGET_NOT_UNIQUE", `${field.foreignKey.entity}.${field.foreignKey.field} must be a primary or unique key.`);
      }
      if (targetField.type !== field.type) {
        throw new HttpError(400, "FOREIGN_KEY_TYPE_MISMATCH", `${entity.name}.${field.name} and ${field.foreignKey.entity}.${field.foreignKey.field} must use the same type.`);
      }
      if (field.cardinality && field.cardinality.max !== undefined && field.cardinality.min > field.cardinality.max) {
        throw new HttpError(400, "INVALID_CARDINALITY", `${entity.name}.${field.name} cardinality minimum exceeds its maximum.`);
      }
    }
  }
  topologicalEntities(model);
}

function parseForeignKey(
  value: unknown,
  label: string,
): { reference?: ForeignKeyReference; candidates: ForeignKeyReference[]; mappingRequired: boolean } {
  if (value === undefined || value === null || value === false) {
    return { candidates: [], mappingRequired: false };
  }
  if (value === true) return { candidates: [], mappingRequired: true };
  if (!isObject(value)) throw new HttpError(400, "INVALID_FOREIGN_KEY", `${label} foreignKey must identify an entity and field.`);
  const candidates = Array.isArray(value.candidates)
    ? value.candidates.filter(isObject).map((candidate) => ({
      entity: stringValue(candidate.entity, `${label} FK candidate entity`),
      field: stringValue(candidate.field, `${label} FK candidate field`),
    }))
    : [];
  if (typeof value.entity === "string" && typeof value.field === "string") {
    return {
      reference: { entity: value.entity, field: value.field },
      candidates,
      mappingRequired: false,
    };
  }
  return { candidates, mappingRequired: true };
}

function parseCardinality(value: unknown, label: string): FieldCardinality | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) throw new HttpError(400, "INVALID_CARDINALITY", `${label} cardinality must contain min and optional max.`);
  const min = optionalNumber(value.min, `${label} cardinality minimum`) ?? 0;
  const max = optionalNumber(value.max, `${label} cardinality maximum`);
  if (!Number.isInteger(min) || min < 0 || (max !== undefined && (!Number.isInteger(max) || max < min))) {
    throw new HttpError(400, "INVALID_CARDINALITY", `${label} cardinality must use non-negative integer bounds with max >= min.`);
  }
  return { min, ...(max !== undefined ? { max } : {}) };
}

function parseLength(
  value: unknown,
  minLength: unknown,
  maxLength: unknown,
  label: string,
): { min?: number; max?: number } | undefined {
  if (value === undefined && minLength === undefined && maxLength === undefined) return undefined;
  const length = typeof value === "number" ? { max: value } : isObject(value) ? value : {};
  const min = optionalNumber(length.min ?? minLength, `${label} minimum length`);
  const max = optionalNumber(length.max ?? maxLength, `${label} maximum length`);
  if (
    (min !== undefined && (!Number.isInteger(min) || min < 0)) ||
    (max !== undefined && (!Number.isInteger(max) || max < 1)) ||
    (min !== undefined && max !== undefined && min > max)
  ) {
    throw new HttpError(400, "INVALID_FIELD_LENGTH", `${label} length bounds must be non-negative integers with max >= min.`);
  }
  return { ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) };
}

function parseEnum(value: unknown, label: string): PrimitiveValue[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => entry === undefined || (typeof entry === "object" && entry !== null))) {
    throw new HttpError(400, "INVALID_ENUM", `${label} enum must be a non-empty array of primitive values.`);
  }
  return value as PrimitiveValue[];
}

function parseFieldType(value: unknown, label: string): ModelFieldType {
  if (typeof value !== "string") throw new HttpError(400, "UNSUPPORTED_FIELD_TYPE", `${label} must declare a supported type.`);
  const normalized = value.toLowerCase().replace(/\(.*\)$/, "");
  const types: Record<string, ModelFieldType> = {
    string: "string", text: "string", varchar: "string", char: "string", uuid: "string",
    integer: "integer", int: "integer", bigint: "integer", smallint: "integer",
    number: "number", decimal: "number", numeric: "number", float: "number", double: "number",
    boolean: "boolean", bool: "boolean", date: "date",
    datetime: "datetime", timestamp: "datetime",
  };
  const type = types[normalized];
  if (!type) throw new HttpError(400, "UNSUPPORTED_FIELD_TYPE", `${label} uses unsupported type ${value}.`);
  return type;
}

function inferEnumType(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) {
    throw new HttpError(400, "UNSUPPORTED_JSON_SCHEMA", "Every property needs a supported type.");
  }
  const type = typeof value[0];
  if (!["string", "number", "boolean"].includes(type) || value.some((entry) => typeof entry !== type)) {
    throw new HttpError(400, "UNSUPPORTED_JSON_SCHEMA", "Mixed-type enum properties are not supported.");
  }
  return type === "number" && Number.isInteger(value[0]) ? "integer" : type;
}

function suggestion(rule: GenerationRule, confidence: number, rationale: string): RuleSuggestion {
  return { rule, confidence, rationale };
}

function normalizedName(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

function assertNoDuplicates(values: string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    const key = value.toLocaleLowerCase("en");
    if (seen.has(key)) throw new HttpError(400, "DUPLICATE_MODEL_NAME", `Duplicate ${label}: ${value}.`);
    seen.add(key);
  }
}

function stringValue(value: unknown, label: string, maxLength = 100): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > maxLength) {
    throw new HttpError(400, "INVALID_MODEL_VALUE", `${label} must be a non-empty string of at most ${maxLength} characters.`);
  }
  return value.trim();
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new HttpError(400, "INVALID_MODEL_VALUE", "Boolean model constraints must be true or false.");
  return value;
}

function optionalNumber(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new HttpError(400, "INVALID_MODEL_VALUE", `${label} must be a finite number.`);
  }
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function assertKnownKeys(value: Record<string, unknown>, supported: Set<string>, label: string): void {
  const unsupported = Object.keys(value).filter((key) => !supported.has(key));
  if (unsupported.length > 0) {
    throw new HttpError(400, "UNSUPPORTED_MODEL_CONSTRUCT", `Unsupported ${label} property: ${unsupported.join(", ")}.`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
