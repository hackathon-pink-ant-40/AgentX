import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import type {
  CanonicalModel,
  GenerationProfile,
  GenerationProfileInput,
  GenerationRule,
  ModelListItem,
  ModelResponse,
  ModelSourceFormat,
  ModelVersion,
  NegativeScenarioKind,
} from "@agentx/shared";
import type { NextFunction, Request, Response } from "express";
import { Router } from "express";
import { createDefaultProfile, formattedDateRule, validateProfile } from "./generator.js";
import { HttpError } from "./http-error.js";
import { importModel, normalizeCanonicalModel } from "./model-import.js";
import { DatasetService } from "./dataset-service.js";

interface ModelVersionRow {
  id: string;
  model_id: string;
  version: number;
  source_format: ModelSourceFormat;
  model_json: string;
  created_at: string;
}

interface ProfileRow {
  id: string;
  model_version_id: string;
  name: string;
  settings_json: string;
  created_at: string;
  updated_at: string;
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const sampleFiles: Array<{ name: string; format: ModelSourceFormat; file: string }> = [
  { name: "Customer & Address — canonical JSON", format: "canonical", file: "customer-address.canonical.json" },
  { name: "Customer & Address — JSON Schema", format: "json-schema", file: "customer-address.schema.json" },
  { name: "Customer & Address — Mermaid ER", format: "mermaid", file: "customer-address.mmd" },
];
const negativeScenarios = new Set<NegativeScenarioKind>([
  "missing_required", "null_required", "invalid_enum", "invalid_length", "invalid_format",
  "orphan_fk", "duplicate_match", "boundary", "unicode",
]);
const generationRuleKinds: readonly GenerationRule["kind"][] = [
  "fixed", "sequence", "uuid", "firstName", "lastName", "fullName", "companyName", "email",
  "streetAddress", "postalCode", "countryCode", "enum", "string", "integer", "decimal", "date",
  "datetime", "boolean", "foreignKey", "parentLookup", "derived",
];

export function createModelsApiRouter(
  database: Database.Database,
  datasetService: DatasetService,
): Router {
  const router = Router();

  router.get("/models/samples", (_request, response) => {
    response.json({
      samples: sampleFiles.map((sample) => ({
        name: sample.name,
        format: sample.format,
        content: readFileSync(resolve(projectRoot, "samples", sample.file), "utf8"),
      })),
    });
  });

  router.post("/models/import", route(async (request, response) => {
    const body = requireObject(request.body, "Import request");
    const sourceFormat = parseSourceFormat(body.sourceFormat);
    if (typeof body.content !== "string" || body.content.trim().length === 0) {
      throw new HttpError(400, "MODEL_CONTENT_REQUIRED", "Provide a non-empty JSON or Mermaid model document.");
    }
    if (body.content.length > 100_000) {
      throw new HttpError(413, "MODEL_TOO_LARGE", "Model documents must be 100 KB or smaller.");
    }
    const name = body.name === undefined ? undefined : stringValue(body.name, "Model name", 120);
    const model = importModel(sourceFormat, body.content);
    if (name !== undefined) model.name = name;
    const modelId = randomUUID();
    const versionId = randomUUID();
    const now = new Date().toISOString();
    model.modelId = modelId;
    model.version = 1;
    const transaction = database.transaction(() => {
      database.prepare(`
        INSERT INTO data_models (id, name, latest_version, created_at, updated_at)
        VALUES (?, ?, 1, ?, ?)
      `).run(modelId, model.name, now, now);
      database.prepare(`
        INSERT INTO model_versions (id, model_id, version, source_format, source_text, model_json, created_at)
        VALUES (?, ?, 1, ?, ?, ?, ?)
      `).run(versionId, modelId, sourceFormat, body.content, JSON.stringify(model), now);
    });
    transaction();
    response.status(201).json({
      model: {
        id: versionId,
        modelId,
        version: 1,
        sourceFormat,
        model,
        createdAt: now,
      } satisfies ModelVersion,
    });
  }));

  router.get("/models", (_request, response) => {
    const rows = database.prepare(`
      SELECT m.id, m.name, m.latest_version, m.created_at, m.updated_at, v.id AS latest_version_id
      FROM data_models m
      JOIN model_versions v ON v.model_id = m.id AND v.version = m.latest_version
      ORDER BY m.updated_at DESC, m.name COLLATE NOCASE
    `).all() as Array<{
      id: string;
      name: string;
      latest_version: number;
      created_at: string;
      updated_at: string;
      latest_version_id: string;
    }>;
    const models: ModelListItem[] = rows.map((row) => ({
      id: row.id,
      name: row.name,
      latestVersion: row.latest_version,
      latestVersionId: row.latest_version_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
    response.json({ models });
  });

  router.get("/models/:id/versions/:version", route((request, response) => {
    const modelId = routeParameter(request, "id");
    const version = positiveInteger(routeParameter(request, "version"), "version", 10_000);
    const row = database.prepare(`
      SELECT id, model_id, version, source_format, model_json, created_at
      FROM model_versions WHERE model_id = ? AND version = ?
    `).get(modelId, version) as ModelVersionRow | undefined;
    if (!row) throw new HttpError(404, "MODEL_VERSION_NOT_FOUND", `Model version ${version} was not found.`);
    const versions = database.prepare(`
      SELECT id, version, source_format, created_at
      FROM model_versions WHERE model_id = ? ORDER BY version DESC
    `).all(modelId) as Array<{ id: string; version: number; source_format: ModelSourceFormat; created_at: string }>;
    response.json(modelResponse(row, versions));
  }));

  router.post("/models/:id/versions", route((request, response) => {
    const modelId = routeParameter(request, "id");
    const body = requireObject(request.body, "Version request");
    const existing = database.prepare("SELECT id FROM data_models WHERE id = ?").get(modelId) as { id: string } | undefined;
    if (!existing) throw new HttpError(404, "MODEL_NOT_FOUND", `Model ${modelId} was not found.`);
    const submitted = body.model;
    const model = normalizeCanonicalModel(submitted);
    const current = database.prepare(`SELECT m.latest_version, v.source_format FROM data_models m
      JOIN model_versions v ON v.model_id = m.id AND v.version = m.latest_version WHERE m.id = ?`)
      .get(modelId) as { latest_version: number; source_format: ModelSourceFormat };
    if (current.source_format === "extended-canonical" && body.acknowledgePartialModel !== true) {
      throw new HttpError(409, "PARTIAL_MODEL_REVIEW_REQUIRED", "Review the omitted rules and explicitly acknowledge them before saving a canonical version.");
    }
    const version = current.latest_version + 1;
    const versionId = randomUUID();
    const now = new Date().toISOString();
    model.modelId = modelId;
    model.version = version;
    const sourceText = JSON.stringify(submitted);
    const transaction = database.transaction(() => {
      database.prepare(`
        INSERT INTO model_versions (id, model_id, version, source_format, source_text, model_json, created_at)
        VALUES (?, ?, ?, 'canonical', ?, ?, ?)
      `).run(versionId, modelId, version, sourceText, JSON.stringify(model), now);
      database.prepare("UPDATE data_models SET name = ?, latest_version = ?, updated_at = ? WHERE id = ?")
        .run(model.name, version, now, modelId);
    });
    transaction();
    response.status(201).json({
      model: {
        id: versionId,
        modelId,
        version,
        sourceFormat: "canonical",
        model,
        createdAt: now,
      } satisfies ModelVersion,
    });
  }));

  router.get("/models/:id", route((request, response) => {
    const modelId = routeParameter(request, "id");
    const latest = database.prepare(`
      SELECT v.id, v.model_id, v.version, v.source_format, v.model_json, v.created_at
      FROM data_models m
      JOIN model_versions v ON v.model_id = m.id AND v.version = m.latest_version
      WHERE m.id = ?
    `).get(modelId) as ModelVersionRow | undefined;
    if (!latest) throw new HttpError(404, "MODEL_NOT_FOUND", `Model ${modelId} was not found.`);
    const versions = database.prepare(`
      SELECT id, version, source_format, created_at
      FROM model_versions WHERE model_id = ? ORDER BY version DESC
    `).all(modelId) as Array<{ id: string; version: number; source_format: ModelSourceFormat; created_at: string }>;
    response.json(modelResponse(latest, versions));
  }));

  router.get("/generation-profiles", (_request, response) => {
    const rows = database.prepare(`
      SELECT id, model_version_id, name, settings_json, created_at, updated_at
      FROM generation_profiles ORDER BY updated_at DESC
    `).all() as ProfileRow[];
    response.json({ profiles: rows.map(profileFromRow) });
  });

  router.post("/generation-profiles", route((request, response) => {
    const body = requireObject(request.body, "Generation profile");
    const profileInput = normalizeProfileInput(body, database);
    const model = modelForVersion(database, profileInput.modelVersionId);
    validateProfile(profileInput, model);
    const id = randomUUID();
    const now = new Date().toISOString();
    database.prepare(`
      INSERT INTO generation_profiles (id, model_version_id, name, settings_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, profileInput.modelVersionId, profileInput.name, JSON.stringify(profileInput), now, now);
    response.status(201).json({ profile: { ...profileInput, id, createdAt: now, updatedAt: now } satisfies GenerationProfile });
  }));

  router.patch("/generation-profiles/:id", route((request, response) => {
    const profileId = routeParameter(request, "id");
    const existing = database.prepare(`
      SELECT id, model_version_id, name, settings_json, created_at, updated_at
      FROM generation_profiles WHERE id = ?
    `).get(profileId) as ProfileRow | undefined;
    if (!existing) throw new HttpError(404, "GENERATION_PROFILE_NOT_FOUND", `Generation profile ${profileId} was not found.`);
    const body = requireObject(request.body, "Generation profile");
    const previous = profileFromRow(existing);
    const profileInput = normalizeProfileInput(body, database, previous);
    const model = modelForVersion(database, profileInput.modelVersionId);
    validateProfile(profileInput, model);
    const now = new Date().toISOString();
    database.prepare(`
      UPDATE generation_profiles
      SET model_version_id = ?, name = ?, settings_json = ?, updated_at = ?
      WHERE id = ?
    `).run(profileInput.modelVersionId, profileInput.name, JSON.stringify(profileInput), now, profileId);
    response.json({ profile: { ...profileInput, id: profileId, createdAt: previous.createdAt, updatedAt: now } satisfies GenerationProfile });
  }));

  router.post("/generation-profiles/:id/repair-date-rules", route((request, response) => {
    const profile = getProfile(database, routeParameter(request, "id"));
    const model = modelForVersion(database, profile.modelVersionId);
    const rules = { ...profile.rules };
    const updatedFields: string[] = [];
    for (const entity of model.entities) {
      for (const field of entity.fields) {
        const path = `${entity.name}.${field.name}`;
        const current = rules[path];
        const kind = formattedDateRule(field);
        if (!kind || current?.kind !== "string") continue;
        rules[path] = {
          kind,
          ...(current.nullProbability !== undefined ? { nullProbability: current.nullProbability } : {}),
          ...(current.unique !== undefined ? { unique: current.unique } : {}),
        };
        updatedFields.push(path);
      }
    }
    const { id, createdAt, updatedAt: _updatedAt, ...settings } = profile;
    const updated = { ...settings, rules };
    validateProfile(updated, model);
    const now = new Date().toISOString();
    database.prepare("UPDATE generation_profiles SET settings_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(updated), now, id);
    response.json({ profile: { ...updated, id, createdAt, updatedAt: now } satisfies GenerationProfile, updatedFields });
  }));

  router.post("/datasets/preview", route((request, response) => {
    const body = requireObject(request.body, "Dataset preview request");
    const profile = getProfile(database, body.profileId);
    response.json(datasetService.preview(profile));
  }));

  router.post("/datasets", route((request, response) => {
    const body = requireObject(request.body, "Dataset request");
    const profile = getProfile(database, body.profileId);
    const name = stringValue(body.name, "Dataset name", 100);
    const dataset = datasetService.create(profile, name);
    response.status(201).json({ dataset });
  }));

  router.get("/datasets", (_request, response) => {
    response.json({ datasets: datasetService.list() });
  });

  router.get("/datasets/:id/records", route((request, response) => {
    const datasetId = routeParameter(request, "id");
    const page = positiveInteger(request.query.page, "page", 1_000_000, 1);
    const pageSize = positiveInteger(request.query.pageSize, "pageSize", 100, 20);
    const entity = optionalQuery(request.query.entity, "entity", 80);
    const scenario = optionalQuery(request.query.scenario, "scenario", 80);
    const search = optionalQuery(request.query.search, "search", 100);
    const result = datasetService.getRecords(datasetId, { page, pageSize, entity, scenario, search });
    response.json({
      datasetId,
      entity: entity ?? "",
      page,
      pageSize,
      total: result.total,
      records: result.records,
    });
  }));

  router.get("/datasets/:id/export", route((request, response) => {
    response.json({ manifest: datasetService.getManifest(routeParameter(request, "id")) });
  }));

  router.get("/datasets/:id/export/:kind", (request, response, next) => {
    try {
      const file = datasetService.exportFile(
        routeParameter(request, "id"),
        routeParameter(request, "kind"),
        optionalQuery(request.query.entity, "entity", 80),
      );
      response.type(file.contentType).download(file.path, file.downloadName, { dotfiles: "allow" }, (error) => {
        if (error) next(error);
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/datasets/:id", route((request, response) => {
    response.json({ dataset: datasetService.getManifest(routeParameter(request, "id")) });
  }));

  router.use((error: unknown, _request: Request, response: Response, next: NextFunction) => {
    if (response.headersSent) {
      next(error);
      return;
    }
    if (error instanceof HttpError) {
      response.status(error.status).json({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
      });
      return;
    }
    next(error);
  });

  return router;
}

function route(
  handler: (request: Request, response: Response) => void | Promise<void>,
): (request: Request, response: Response, next: NextFunction) => void {
  return (request, response, next) => {
    Promise.resolve(handler(request, response)).catch(next);
  };
}

function modelResponse(
  row: ModelVersionRow,
  versions: Array<{ id: string; version: number; source_format: ModelSourceFormat; created_at: string }>,
): ModelResponse {
  return {
    model: {
      id: row.id,
      modelId: row.model_id,
      version: row.version,
      sourceFormat: row.source_format,
      model: JSON.parse(row.model_json) as CanonicalModel,
      createdAt: row.created_at,
    },
    versions: versions.map((version) => ({
      id: version.id,
      version: version.version,
      sourceFormat: version.source_format,
      createdAt: version.created_at,
    })),
  };
}

function normalizeProfileInput(
  body: Record<string, unknown>,
  database: Database.Database,
  previous?: GenerationProfile,
): GenerationProfileInput {
  const modelVersionId = stringValue(
    body.modelVersionId ?? previous?.modelVersionId,
    "Model version ID",
    80,
  );
  const model = modelForVersion(database, modelVersionId);
  const defaults = createDefaultProfile(model, modelVersionId);
  const previousSettings = previous;
  const localeValue = body.locale ?? previousSettings?.locale ?? defaults.locale;
  if (localeValue !== "en" && localeValue !== "nl" && localeValue !== "de") {
    throw new HttpError(400, "INVALID_LOCALE", "Locale must be en, nl, or de.");
  }
  const recordCounts = mergeStringNumberRecords(
    defaults.recordCounts,
    previousSettings?.recordCounts,
    body.recordCounts,
    "recordCounts",
  );
  const rules = mergeRules(
    defaults.rules,
    previousSettings?.rules,
    body.rules,
  );
  const scenariosValue = body.negativeScenarios ?? previousSettings?.negativeScenarios ?? [];
  if (!Array.isArray(scenariosValue) || scenariosValue.some((value) => typeof value !== "string" || !negativeScenarios.has(value as NegativeScenarioKind))) {
    throw new HttpError(400, "INVALID_NEGATIVE_SCENARIO", "negativeScenarios must contain supported scenario IDs.");
  }
  const uniqueScenarios = [...new Set(scenariosValue as NegativeScenarioKind[])];
  return {
    modelVersionId,
    name: stringValue(body.name ?? previousSettings?.name ?? defaults.name, "Profile name", 80),
    locale: localeValue,
    seed: stringValue(body.seed ?? previousSettings?.seed ?? defaults.seed, "Seed", 100),
    referenceDate: stringValue(body.referenceDate ?? previousSettings?.referenceDate ?? defaults.referenceDate, "Reference date", 10),
    recordCounts,
    rules,
    negativeScenarios: uniqueScenarios,
  };
}

function mergeStringNumberRecords(
  defaults: Record<string, number>,
  previous: Record<string, number> | undefined,
  input: unknown,
  label: string,
): Record<string, number> {
  const source = input === undefined ? previous : input;
  if (source !== undefined && !isObject(source)) {
    throw new HttpError(400, "INVALID_PROFILE_SETTING", `${label} must be an object.`);
  }
  const result = { ...defaults, ...(previous ?? {}) };
  if (isObject(source)) {
    for (const [key, value] of Object.entries(source)) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new HttpError(400, "INVALID_PROFILE_SETTING", `${label}.${key} must be a finite number.`);
      }
      result[key] = value;
    }
  }
  return result;
}

function mergeRules(
  defaults: GenerationProfile["rules"],
  previous: GenerationProfile["rules"] | undefined,
  input: unknown,
): GenerationProfile["rules"] {
  const source = input === undefined ? previous : input;
  if (source !== undefined && !isObject(source)) {
    throw new HttpError(400, "INVALID_PROFILE_SETTING", "rules must be an object keyed by Entity.field.");
  }
  const result: GenerationProfile["rules"] = { ...defaults, ...(previous ?? {}) };
  if (isObject(source)) {
    for (const [key, value] of Object.entries(source)) {
      if (!isObject(value) || !isGenerationRule(value)) {
        throw new HttpError(400, "INVALID_PROFILE_SETTING", `rules.${key} must contain a supported, well-formed generation rule.`);
      }
      result[key] = value;
    }
  }
  return result;
}

export function getProfile(database: Database.Database, profileId: unknown): GenerationProfile {
  const id = stringValue(profileId, "Profile ID", 80);
  const row = database.prepare(`
    SELECT id, model_version_id, name, settings_json, created_at, updated_at
    FROM generation_profiles WHERE id = ?
  `).get(id) as ProfileRow | undefined;
  if (!row) throw new HttpError(404, "GENERATION_PROFILE_NOT_FOUND", `Generation profile ${id} was not found.`);
  return profileFromRow(row);
}

export function loadDemoModelAndProfile(database: Database.Database): { model: ModelVersion; profile: GenerationProfile } {
  const saved = database.prepare("SELECT value FROM demo_settings WHERE key = 'demo_model_version_id'").get() as { value: string } | undefined;
  let row = saved ? database.prepare(`
    SELECT id, model_id, version, source_format, model_json, created_at FROM model_versions WHERE id = ?
  `).get(saved.value) as ModelVersionRow | undefined : undefined;
  if (!row) {
    const source = readFileSync(resolve(projectRoot, "samples", "customer-address.canonical.json"), "utf8");
    const model = importModel("canonical", source);
    const modelId = randomUUID();
    const versionId = randomUUID();
    const now = new Date().toISOString();
    model.modelId = modelId;
    model.version = 1;
    database.prepare("INSERT INTO data_models (id, name, latest_version, created_at, updated_at) VALUES (?, ?, 1, ?, ?)")
      .run(modelId, model.name, now, now);
    database.prepare(`INSERT INTO model_versions (id, model_id, version, source_format, source_text, model_json, created_at)
      VALUES (?, ?, 1, 'canonical', ?, ?, ?)`).run(versionId, modelId, source, JSON.stringify(model), now);
    database.prepare("INSERT OR REPLACE INTO demo_settings (key, value) VALUES ('demo_model_version_id', ?)").run(versionId);
    row = { id: versionId, model_id: modelId, version: 1, source_format: "canonical", model_json: JSON.stringify(model), created_at: now };
  }
  const model: ModelVersion = {
    id: row.id, modelId: row.model_id, version: row.version, sourceFormat: row.source_format,
    model: JSON.parse(row.model_json) as CanonicalModel, createdAt: row.created_at,
  };
  const profileSetting = database.prepare("SELECT value FROM demo_settings WHERE key = 'demo_profile_id'").get() as { value: string } | undefined;
  const existing = profileSetting
    ? database.prepare("SELECT id FROM generation_profiles WHERE id = ?").get(profileSetting.value) as { id: string } | undefined
    : undefined;
  if (existing) return { model, profile: getProfile(database, existing.id) };
  const id = randomUUID();
  const draft = createDefaultProfile(model.model, model.id, id);
  draft.negativeScenarios = ["orphan_fk"];
  validateProfile(draft, model.model);
  const { id: _profileId, createdAt, updatedAt, ...settings } = draft;
  database.prepare(`INSERT INTO generation_profiles (id, model_version_id, name, settings_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(id, model.id, draft.name, JSON.stringify(settings), createdAt, updatedAt);
  database.prepare("INSERT OR REPLACE INTO demo_settings (key, value) VALUES ('demo_profile_id', ?)").run(id);
  return { model, profile: draft };
}

function profileFromRow(row: ProfileRow): GenerationProfile {
  const settings = JSON.parse(row.settings_json) as GenerationProfileInput;
  return { ...settings, id: row.id, createdAt: row.created_at, updatedAt: row.updated_at };
}

function modelForVersion(database: Database.Database, modelVersionId: string): CanonicalModel {
  const row = database.prepare("SELECT model_json, source_format FROM model_versions WHERE id = ?").get(modelVersionId) as { model_json: string; source_format: ModelSourceFormat } | undefined;
  if (!row) throw new HttpError(404, "MODEL_VERSION_NOT_FOUND", `Model version ${modelVersionId} was not found.`);
  if (row.source_format === "extended-canonical") {
    throw new HttpError(409, "PARTIAL_MODEL_REVIEW_REQUIRED", "Review the omitted rules and save an acknowledged canonical version before creating a generation profile.");
  }
  return JSON.parse(row.model_json) as CanonicalModel;
}

function parseSourceFormat(value: unknown): ModelSourceFormat {
  if (value !== "canonical" && value !== "json-schema" && value !== "mermaid" && value !== "smart-mdm" && value !== "extended-canonical") {
    throw new HttpError(400, "INVALID_MODEL_FORMAT", "sourceFormat must be canonical, json-schema, mermaid, smart-mdm, or extended-canonical.");
  }
  return value;
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!isObject(value)) throw new HttpError(400, "INVALID_REQUEST_BODY", `${label} must be a JSON object.`);
  return value;
}

function routeParameter(request: Request, name: string): string {
  const value = request.params[name];
  if (typeof value !== "string") throw new HttpError(400, "INVALID_PATH_PARAMETER", `Invalid ${name} path parameter.`);
  return value;
}

function positiveInteger(value: unknown, label: string, maximum: number, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new HttpError(400, "INVALID_PAGINATION", `${label} must be an integer between 1 and ${maximum}.`);
  }
  return parsed;
}

function optionalQuery(value: unknown, label: string, maximumLength: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > maximumLength) {
    throw new HttpError(400, "INVALID_QUERY", `${label} must be a string of at most ${maximumLength} characters.`);
  }
  return value;
}

function stringValue(value: unknown, label: string, maximumLength: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > maximumLength) {
    throw new HttpError(400, "INVALID_VALUE", `${label} must be a non-empty string of at most ${maximumLength} characters.`);
  }
  return value.trim();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isGenerationRule(value: Record<string, unknown>): value is Record<string, unknown> & GenerationRule {
  const stringProperties = ["prefix", "pattern", "separator", "foreignKeyField", "targetField", "countryField"];
  const numberProperties = ["min", "max", "minLength", "maxLength", "nullProbability", "ageMin", "ageMax"];
  const allowedProperties = new Set([
    "kind", "fixedValue", "prefix", "min", "max", "minLength", "maxLength", "pattern", "values", "weights",
    "unique", "nullProbability", "ageMin", "ageMax", "fields", "separator", "foreignKeyField", "targetField", "countryField",
  ]);
  if (typeof value.kind !== "string" || !generationRuleKinds.some((kind) => kind === value.kind)) return false;
  if (Object.keys(value).some((property) => !allowedProperties.has(property))) return false;
  if (value.fixedValue !== undefined && value.fixedValue !== null &&
      typeof value.fixedValue !== "string" && typeof value.fixedValue !== "number" && typeof value.fixedValue !== "boolean") return false;
  if (stringProperties.some((property) => value[property] !== undefined && typeof value[property] !== "string")) return false;
  if (numberProperties.some((property) => value[property] !== undefined &&
      (typeof value[property] !== "number" || !Number.isFinite(value[property])))) return false;
  if (value.unique !== undefined && typeof value.unique !== "boolean") return false;
  if (value.values !== undefined && (!Array.isArray(value.values) || value.values.some((item) =>
    item !== null && typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean"))) return false;
  if (value.weights !== undefined && (!Array.isArray(value.weights) || value.weights.some((weight) =>
    typeof weight !== "number" || !Number.isFinite(weight)))) return false;
  if (value.fields !== undefined && (!Array.isArray(value.fields) || value.fields.some((field) => typeof field !== "string"))) return false;
  return true;
}
