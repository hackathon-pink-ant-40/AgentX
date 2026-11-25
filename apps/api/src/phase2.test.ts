import type Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "./app.js";
import { openDatabase } from "./database.js";
import { DatasetService } from "./dataset-service.js";
import type { DatasetRecordsResponse, GenerationProfile } from "@agentx/shared";

const sampleRoot = new URL("../../../samples/", import.meta.url);

describe("model-driven synthetic data API", () => {
  let directory: string;
  let database: Database.Database;
  let datasetService: DatasetService;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "agentx-phase2-"));
    database = openDatabase(join(directory, "test.sqlite"));
    datasetService = new DatasetService(database, join(directory, "exports"));
    app = createApp(database, datasetService);
  });

  afterEach(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("imports canonical JSON, JSON Schema, and Mermaid samples and versions the model", async () => {
    const fixtures = [
      ["canonical", "customer-address.canonical.json"],
      ["json-schema", "customer-address.schema.json"],
      ["mermaid", "customer-address.mmd"],
    ] as const;
    for (const [sourceFormat, fileName] of fixtures) {
      const content = readFileSync(new URL(fileName, sampleRoot), "utf8");
      const imported = await request(app)
        .post("/api/models/import")
        .send({ sourceFormat, content });
      expect(imported.status, `${sourceFormat}: ${JSON.stringify(imported.body)}`).toBe(201);
      expect(imported.body.model.sourceFormat).toBe(sourceFormat);
      expect(imported.body.model.model.entities.map((entity: { name: string }) => entity.name)).toEqual(["Customer", "Address"]);
      expect(imported.body.model.model.entities[1].fields.find((field: { name: string }) => field.name === "customerId").foreignKey)
        .toEqual({ entity: "Customer", field: "customerId" });
    }

    const models = await request(app).get("/api/models").expect(200);
    expect(models.body.models).toHaveLength(3);
    const imported = await request(app)
      .post("/api/models/import")
      .send({
        sourceFormat: "canonical",
        content: readFileSync(new URL("customer-address.canonical.json", sampleRoot), "utf8"),
      })
      .expect(201);
    const versioned = await request(app)
      .post(`/api/models/${imported.body.model.modelId}/versions`)
      .send({ model: { ...imported.body.model.model, name: "Customer Master v2" } })
      .expect(201);
    expect(versioned.body.model.version).toBe(2);
    expect((await request(app).get(`/api/models/${imported.body.model.modelId}`).expect(200)).body.versions)
      .toHaveLength(2);
  });

  it("generates reproducible, referentially valid data and deliberate negative records with JSON/CSV exports", async () => {
    const modelContent = readFileSync(new URL("customer-address.canonical.json", sampleRoot), "utf8");
    const imported = await request(app).post("/api/models/import")
      .send({ sourceFormat: "canonical", content: modelContent }).expect(201);
    const profileResponse = await request(app).post("/api/generation-profiles")
      .send({ modelVersionId: imported.body.model.id }).expect(201);
    const profile = profileResponse.body.profile as GenerationProfile;
    const configured = await request(app).patch(`/api/generation-profiles/${profile.id}`).send({
      negativeScenarios: [
        "missing_required", "null_required", "invalid_enum", "invalid_length", "invalid_format",
        "orphan_fk", "duplicate_match", "boundary", "unicode",
      ],
    }).expect(200);
    expect(configured.body.profile.negativeScenarios).toHaveLength(9);

    const preview = await request(app).post("/api/datasets/preview").send({ profileId: profile.id });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body.records.length).toBeGreaterThan(0);
    const first = await request(app).post("/api/datasets").send({ profileId: profile.id, name: "Reproducible A" }).expect(201);
    const second = await request(app).post("/api/datasets").send({ profileId: profile.id, name: "Reproducible B" }).expect(201);
    expect(first.body.dataset.status).toBe("READY");
    expect(first.body.dataset.counts.total).toBeGreaterThan(first.body.dataset.counts.entities.Customer + first.body.dataset.counts.entities.Address - 1);

    const firstRecords = (await request(app).get(`/api/datasets/${first.body.dataset.id}/records?pageSize=100`).expect(200))
      .body as DatasetRecordsResponse;
    const secondRecords = (await request(app).get(`/api/datasets/${second.body.dataset.id}/records?pageSize=100`).expect(200))
      .body as DatasetRecordsResponse;
    const projection = (result: DatasetRecordsResponse) => result.records.map((record) => ({
      entity: record.entity,
      payload: record.payload,
      scenario: record.metadata.scenarioId,
      valid: record.metadata.expectedValid,
    }));
    expect(projection(firstRecords)).toEqual(projection(secondRecords));
    const customers = new Set(firstRecords.records
      .filter((record) => record.entity === "Customer" && record.metadata.expectedValid)
      .map((record) => record.payload.customerId));
    const validAddresses = firstRecords.records.filter((record) => record.entity === "Address" && record.metadata.expectedValid);
    expect(validAddresses.length).toBeGreaterThan(0);
    expect(validAddresses.every((record) => customers.has(record.payload.customerId))).toBe(true);
    const invalidRecords = firstRecords.records.filter((record) => !record.metadata.expectedValid);
    expect(invalidRecords.map((record) => record.metadata.scenarioId).sort()).toEqual([
      "duplicate_match", "invalid_enum", "invalid_format", "invalid_length", "missing_required", "null_required", "orphan_fk",
    ]);
    const validEdgeRecords = firstRecords.records.filter((record) =>
      ["boundary", "unicode"].includes(record.metadata.scenarioId));
    expect(validEdgeRecords).toHaveLength(2);
    expect(validEdgeRecords.every((record) => record.metadata.expectedValid)).toBe(true);
    const paged = await request(app).get(`/api/datasets/${first.body.dataset.id}/records?page=2&pageSize=20`).expect(200);
    expect(paged.body.records).toHaveLength(20);
    expect(paged.body.total).toBe(first.body.dataset.counts.total);

    const combined = await request(app).get(`/api/datasets/${first.body.dataset.id}/export/combined`).expect(200);
    expect(JSON.parse(combined.text).records).toHaveLength(first.body.dataset.counts.total);
    const addressCsv = await request(app)
      .get(`/api/datasets/${first.body.dataset.id}/export/entity-csv?entity=Address`)
      .expect(200);
    expect(addressCsv.text).toContain("_scenarioId");
    expect(addressCsv.text).toContain("customerId");
    const searched = await request(app).get(`/api/datasets/${first.body.dataset.id}/records?search=not-a-valid-email`).expect(200);
    expect(searched.body.total).toBe(1);
    expect(searched.body.records[0].metadata.scenarioId).toBe("invalid_format");

    const englishProfile = await request(app).post("/api/generation-profiles")
      .send({ modelVersionId: imported.body.model.id, locale: "en", seed: profile.seed }).expect(201);
    const englishDataset = await request(app).post("/api/datasets")
      .send({ profileId: englishProfile.body.profile.id, name: "English locale" }).expect(201);
    const englishRecords = (await request(app).get(`/api/datasets/${englishDataset.body.dataset.id}/records?pageSize=20`).expect(200))
      .body as DatasetRecordsResponse;
    const dutchFirstName = firstRecords.records.find((record) => record.entity === "Customer")?.payload.firstName;
    const englishFirstName = englishRecords.records.find((record) => record.entity === "Customer")?.payload.firstName;
    expect(englishFirstName).not.toBe(dutchFirstName);
  });

  it("rejects unresolved foreign keys and recovers interrupted dataset publication", async () => {
    const ambiguousModel = {
      name: "Ambiguous",
      entities: [
        { name: "Customer", fields: [{ name: "customerId", type: "string", required: true, primaryKey: true }] },
        { name: "Vendor", fields: [{ name: "vendorId", type: "string", required: true, primaryKey: true }] },
        { name: "Child", fields: [
          { name: "id", type: "string", required: true, primaryKey: true },
          { name: "ownerId", type: "string", required: true, foreignKey: true },
        ] },
      ],
    };
    const imported = await request(app).post("/api/models/import").send({
      sourceFormat: "canonical",
      content: JSON.stringify(ambiguousModel),
    }).expect(201);
    const profile = await request(app).post("/api/generation-profiles")
      .send({ modelVersionId: imported.body.model.id }).expect(409);
    expect(profile.body.error.code).toBe("FOREIGN_KEY_MAPPING_REQUIRED");
    const resolved = structuredClone(imported.body.model.model);
    const ownerField = resolved.entities.find((entity: { name: string }) => entity.name === "Child")
      .fields.find((field: { name: string }) => field.name === "ownerId");
    ownerField.foreignKey = { entity: "Customer", field: "customerId" };
    ownerField.mappingRequired = false;
    const versioned = await request(app).post(`/api/models/${imported.body.model.modelId}/versions`)
      .send({ model: resolved }).expect(201);
    await request(app).post("/api/generation-profiles").send({
      modelVersionId: versioned.body.model.id,
    }).expect(201);

    const standardImport = await request(app).post("/api/models/import").send({
      sourceFormat: "canonical",
      content: readFileSync(new URL("customer-address.canonical.json", sampleRoot), "utf8"),
    }).expect(201);
    const profileResponse = await request(app).post("/api/generation-profiles")
      .send({ modelVersionId: standardImport.body.model.id }).expect(201);
    const dataset = await request(app).post("/api/datasets").send({
      profileId: profileResponse.body.profile.id,
      name: "Interrupted",
    }).expect(201);
    const datasetId = dataset.body.dataset.id as string;
    database.prepare("UPDATE datasets SET status = 'GENERATING' WHERE id = ?").run(datasetId);
    const finalDirectory = join(datasetService.storageRoot, datasetId);
    expect(existsSync(finalDirectory)).toBe(true);
    datasetService.recoverIncompleteExports();
    expect(existsSync(finalDirectory)).toBe(false);
    expect(database.prepare("SELECT status FROM datasets WHERE id = ?").get(datasetId))
      .toEqual({ status: "FAILED" });
    await request(app).get(`/api/datasets/${datasetId}`).expect(409);
  });
});
