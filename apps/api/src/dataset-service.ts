import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import type {
  CanonicalModel,
  DatasetCounts,
  DatasetFileManifest,
  DatasetManifest,
  DatasetPreviewResponse,
  GenerationProfile,
  ModelVersion,
  PrimitiveValue,
  SyntheticRecord,
} from "@agentx/shared";
import { HttpError } from "./http-error.js";
import { generateDataset, validateProfile } from "./generator.js";

interface ModelVersionRow {
  id: string;
  model_id: string;
  version: number;
  source_format: ModelVersion["sourceFormat"];
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

interface DatasetRow {
  id: string;
  profile_id: string;
  model_version_id: string;
  name: string;
  status: DatasetManifest["status"];
  seed: string;
  locale: GenerationProfile["locale"];
  reference_date: string;
  settings_json: string;
  counts_json: string;
  manifest_json: string | null;
  error: string | null;
  created_at: string;
  completed_at: string | null;
}

interface RecordRow {
  record_id: string;
  entity_name: string;
  business_id: string | null;
  payload_json: string;
  scenario_id: string;
  expected_valid: number;
  reason: string | null;
  source_record_id: string | null;
  parent_record_id: string | null;
}

interface ExportDownload {
  path: string;
  downloadName: string;
  contentType: string;
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const defaultStorageRoot = resolve(projectRoot, "storage/datasets");

function resolveStorageRoot(): string {
  const configuredStorageRoot = process.env.AGENTX_STORAGE_DIR;
  return configuredStorageRoot
    ? isAbsolute(configuredStorageRoot)
      ? configuredStorageRoot
      : resolve(projectRoot, configuredStorageRoot)
    : defaultStorageRoot;
}

export class DatasetService {
  readonly storageRoot: string;

  constructor(
    private readonly database: Database.Database,
    storageRoot = resolveStorageRoot(),
  ) {
    this.storageRoot = storageRoot;
  }

  preview(profile: GenerationProfile): DatasetPreviewResponse {
    const { model } = this.getModelVersion(profile.modelVersionId);
    validateProfile(profile, model);
    const generated = generateDataset(model, profile, "preview");
    return {
      modelVersionId: profile.modelVersionId,
      profileId: profile.id,
      counts: generated.counts,
      records: generated.records.slice(0, 10),
    };
  }

  create(profile: GenerationProfile, datasetName: string): DatasetManifest {
    const name = datasetName.trim();
    if (!name || name.length > 100) {
      throw new HttpError(400, "INVALID_DATASET_NAME", "Dataset name must be 1–100 characters.");
    }
    const { model } = this.getModelVersion(profile.modelVersionId);
    validateProfile(profile, model);
    const datasetId = randomUUID();
    const generated = generateDataset(model, profile, datasetId);
    const createdAt = new Date().toISOString();
    const completedAt = new Date().toISOString();
    const files = createFileManifest(generated.entityOrder);
    const manifest: DatasetManifest = {
      id: datasetId,
      name,
      status: "READY",
      modelName: model.name,
      modelVersionId: profile.modelVersionId,
      seed: profile.seed,
      locale: profile.locale,
      referenceDate: profile.referenceDate,
      counts: generated.counts,
      files,
      createdAt,
      completedAt,
    };
    const stage = join(this.storageRoot, `.staging-${datasetId}`);
    const finalDirectory = join(this.storageRoot, datasetId);
    let databaseRowCreated = false;
    try {
      mkdirSync(this.storageRoot, { recursive: true });
      this.database.prepare(`
        INSERT INTO datasets (
          id, profile_id, model_version_id, name, status, seed, locale, reference_date,
          settings_json, counts_json, created_at
        ) VALUES (?, ?, ?, ?, 'GENERATING', ?, ?, ?, ?, ?, ?)
      `).run(
        datasetId,
        profile.id,
        profile.modelVersionId,
        name,
        profile.seed,
        profile.locale,
        profile.referenceDate,
        JSON.stringify(profile),
        JSON.stringify(generated.counts),
        createdAt,
      );
      databaseRowCreated = true;
      mkdirSync(stage, { recursive: false });
      writeExports(stage, manifest, generated.records, generated.entityOrder);

      const insertRecords = this.database.transaction(() => {
        const insertRecord = this.database.prepare(`
          INSERT INTO synthetic_records (
            dataset_id, record_id, entity_name, business_id, payload_json, scenario_id,
            expected_valid, reason, source_record_id, parent_record_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const record of generated.records) {
          insertRecord.run(
            datasetId,
            record.recordId,
            record.entity,
            record.businessId === undefined ? null : String(record.businessId),
            JSON.stringify(record.payload),
            record.metadata.scenarioId,
            record.metadata.expectedValid ? 1 : 0,
            record.metadata.reason ?? null,
            record.metadata.sourceRecordId ?? null,
            record.metadata.parentRecordId ?? null,
            createdAt,
          );
        }
      });
      insertRecords();

      renameSync(stage, finalDirectory);
      const update = this.database
        .prepare("UPDATE datasets SET status = 'READY', manifest_json = ?, completed_at = ? WHERE id = ? AND status = 'GENERATING'")
        .run(JSON.stringify(manifest), completedAt, datasetId);
      if (update.changes !== 1) {
        throw new Error("Dataset status changed while publishing completed exports.");
      }
      return manifest;
    } catch (error) {
      removeOwnedDirectory(stage);
      removeOwnedDirectory(finalDirectory);
      if (databaseRowCreated) {
        const markFailed = this.database.transaction(() => {
          this.database.prepare("DELETE FROM synthetic_records WHERE dataset_id = ?").run(datasetId);
          this.database.prepare(`
            UPDATE datasets
            SET status = 'FAILED', error = ?, completed_at = ?, manifest_json = NULL
            WHERE id = ?
          `).run(errorMessage(error), new Date().toISOString(), datasetId);
        });
        markFailed();
      }
      if (error instanceof HttpError) throw error;
      throw new HttpError(500, "DATASET_PUBLISH_FAILED", `Dataset exports could not be published: ${errorMessage(error)}`);
    }
  }

  list(): DatasetManifest[] {
    return (this.database
      .prepare("SELECT manifest_json FROM datasets WHERE status = 'READY' ORDER BY created_at DESC")
      .all() as Array<{ manifest_json: string | null }>)
      .flatMap((row) => row.manifest_json ? [JSON.parse(row.manifest_json) as DatasetManifest] : []);
  }

  getManifest(datasetId: string): DatasetManifest {
    const row = this.getReadyDatasetRow(datasetId);
    if (!row.manifest_json) throw new HttpError(500, "DATASET_MANIFEST_MISSING", "Ready dataset manifest is missing.");
    return JSON.parse(row.manifest_json) as DatasetManifest;
  }

  getRecords(
    datasetId: string,
    options: { page: number; pageSize: number; entity?: string; scenario?: string; search?: string },
  ): { total: number; records: SyntheticRecord[] } {
    this.getReadyDatasetRow(datasetId);
    const clauses = ["dataset_id = ?"];
    const params: Array<string | number> = [datasetId];
    if (options.entity) {
      clauses.push("entity_name = ?");
      params.push(options.entity);
    }
    if (options.scenario) {
      clauses.push("scenario_id = ?");
      params.push(options.scenario);
    }
    if (options.search) {
      clauses.push("(instr(lower(record_id), lower(?)) > 0 OR instr(lower(COALESCE(business_id, '')), lower(?)) > 0 OR instr(lower(payload_json), lower(?)) > 0)");
      params.push(options.search, options.search, options.search);
    }
    const where = clauses.join(" AND ");
    const total = (this.database
      .prepare(`SELECT COUNT(*) AS count FROM synthetic_records WHERE ${where}`)
      .get(...params) as { count: number }).count;
    const rows = this.database
      .prepare(`
        SELECT record_id, entity_name, business_id, payload_json, scenario_id, expected_valid,
               reason, source_record_id, parent_record_id
        FROM synthetic_records
        WHERE ${where}
        ORDER BY id
        LIMIT ? OFFSET ?
      `)
      .all(...params, options.pageSize, (options.page - 1) * options.pageSize) as RecordRow[];
    return { total, records: rows.map(recordFromRow) };
  }

  exportFile(datasetId: string, kind: string, entityName?: string): ExportDownload {
    const manifest = this.getManifest(datasetId);
    let fileName: string | undefined;
    if (kind === "combined") {
      fileName = manifest.files.combined;
    } else if (kind === "manifest") {
      fileName = manifest.files.manifest;
    } else if (kind === "entity-json" || kind === "entity-csv") {
      const entity = manifest.files.entities.find((file) => file.name === entityName);
      fileName = kind === "entity-json" ? entity?.json : entity?.csv;
    } else {
      throw new HttpError(400, "INVALID_EXPORT_KIND", "Export kind must be combined, manifest, entity-json, or entity-csv.");
    }
    if (!fileName) throw new HttpError(404, "EXPORT_NOT_FOUND", "Requested dataset export was not found.");
    const datasetDirectory = resolve(this.storageRoot, datasetId);
    const path = resolve(datasetDirectory, fileName);
    if (dirname(path) !== datasetDirectory || !existsSync(path)) {
      throw new HttpError(404, "EXPORT_NOT_FOUND", "Requested dataset export was not found.");
    }
    return {
      path,
      downloadName: fileName,
      contentType: fileName.endsWith(".csv") ? "text/csv; charset=utf-8" : "application/json; charset=utf-8",
    };
  }

  recoverIncompleteExports(): void {
    mkdirSync(this.storageRoot, { recursive: true });
    const generating = this.database
      .prepare("SELECT id FROM datasets WHERE status = 'GENERATING'")
      .all() as Array<{ id: string }>;
    const markFailed = this.database.transaction((datasetId: string) => {
      this.database.prepare("DELETE FROM synthetic_records WHERE dataset_id = ?").run(datasetId);
      this.database.prepare(`
        UPDATE datasets SET status = 'FAILED', error = ?, completed_at = ?, manifest_json = NULL
        WHERE id = ? AND status = 'GENERATING'
      `).run("Interrupted while generating or publishing dataset.", new Date().toISOString(), datasetId);
    });
    for (const row of generating) {
      removeOwnedDirectory(join(this.storageRoot, `.staging-${row.id}`));
      removeOwnedDirectory(join(this.storageRoot, row.id));
      markFailed(row.id);
    }
    for (const entry of readdirSync(this.storageRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && /^\.staging-[0-9a-f-]{36}$/i.test(entry.name)) {
        removeOwnedDirectory(join(this.storageRoot, entry.name));
      }
    }
  }

  private getReadyDatasetRow(datasetId: string): DatasetRow {
    const row = this.database
      .prepare("SELECT * FROM datasets WHERE id = ?")
      .get(datasetId) as DatasetRow | undefined;
    if (!row) throw new HttpError(404, "DATASET_NOT_FOUND", `Dataset ${datasetId} was not found.`);
    if (row.status !== "READY") throw new HttpError(409, "DATASET_NOT_READY", `Dataset ${datasetId} is not ready.`);
    return row;
  }

  private getModelVersion(modelVersionId: string): { model: CanonicalModel } {
    const row = this.database
      .prepare("SELECT model_json FROM model_versions WHERE id = ?")
      .get(modelVersionId) as { model_json: string } | undefined;
    if (!row) throw new HttpError(404, "MODEL_VERSION_NOT_FOUND", `Model version ${modelVersionId} was not found.`);
    return { model: JSON.parse(row.model_json) as CanonicalModel };
  }
}

function createFileManifest(entityNames: string[]): DatasetFileManifest {
  return {
    combined: "combined.json",
    manifest: "manifest.json",
    entities: entityNames.map((name, index) => {
      const safeName = name.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "entity";
      const base = `${String(index + 1).padStart(2, "0")}-${safeName}`;
      return { name, json: `${base}.json`, csv: `${base}.csv` };
    }),
  };
}

function writeExports(
  stagingDirectory: string,
  manifest: DatasetManifest,
  records: SyntheticRecord[],
  entityOrder: string[],
): void {
  const recordEnvelope = (record: SyntheticRecord) => ({
    recordId: record.recordId,
    entity: record.entity,
    businessId: record.businessId ?? null,
    data: record.payload,
    metadata: record.metadata,
  });
  writeFileSync(join(stagingDirectory, manifest.files.combined), JSON.stringify({
    dataset: { id: manifest.id, name: manifest.name, seed: manifest.seed, referenceDate: manifest.referenceDate },
    records: records.map(recordEnvelope),
  }, null, 2), "utf8");

  for (const entityFile of manifest.files.entities) {
    const entityRecords = records.filter((record) => record.entity === entityFile.name);
    writeFileSync(join(stagingDirectory, entityFile.json), JSON.stringify({
      datasetId: manifest.id,
      entity: entityFile.name,
      records: entityRecords.map(recordEnvelope),
    }, null, 2), "utf8");
    writeFileSync(join(stagingDirectory, entityFile.csv), recordsToCsv(entityRecords), "utf8");
  }
  if (entityOrder.length !== manifest.files.entities.length) {
    throw new Error("Export manifest does not match the model entity list.");
  }
  writeFileSync(join(stagingDirectory, manifest.files.manifest), JSON.stringify(manifest, null, 2), "utf8");
}

function recordsToCsv(records: SyntheticRecord[]): string {
  const fields = Array.from(new Set(records.flatMap((record) => Object.keys(record.payload))));
  const columns = [
    "_recordId", "_scenarioId", "_expectedValid", "_reason",
    "_sourceRecordId", "_parentRecordId", ...fields,
  ];
  const lines = [
    columns.map(csvValue).join(","),
    ...records.map((record) => columns.map((column) => {
      switch (column) {
        case "_recordId": return csvValue(record.recordId);
        case "_scenarioId": return csvValue(record.metadata.scenarioId);
        case "_expectedValid": return csvValue(record.metadata.expectedValid);
        case "_reason": return csvValue(record.metadata.reason ?? "");
        case "_sourceRecordId": return csvValue(record.metadata.sourceRecordId ?? "");
        case "_parentRecordId": return csvValue(record.metadata.parentRecordId ?? "");
        default: return csvValue(record.payload[column] ?? "");
      }
    }).join(",")),
  ];
  return `${lines.join("\r\n")}\r\n`;
}

function csvValue(value: PrimitiveValue | string): string {
  const text = value === null ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function recordFromRow(row: RecordRow): SyntheticRecord {
  return {
    recordId: row.record_id,
    entity: row.entity_name,
    ...(row.business_id === null ? {} : { businessId: row.business_id }),
    payload: JSON.parse(row.payload_json) as Record<string, PrimitiveValue>,
    metadata: {
      scenarioId: row.scenario_id,
      expectedValid: row.expected_valid === 1,
      ...(row.reason === null ? {} : { reason: row.reason }),
      ...(row.source_record_id === null ? {} : { sourceRecordId: row.source_record_id }),
      ...(row.parent_record_id === null ? {} : { parentRecordId: row.parent_record_id }),
    },
  };
}

function removeOwnedDirectory(path: string): void {
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
