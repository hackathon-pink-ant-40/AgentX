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

  it("uses an optional import name and keeps saved model names in sync with versions", async () => {
    const fixtures = [
      ["canonical", "customer-address.canonical.json"],
      ["json-schema", "customer-address.schema.json"],
      ["mermaid", "customer-address.mmd"],
    ] as const;
    for (const [sourceFormat, fileName] of fixtures) {
      const content = readFileSync(new URL(fileName, sampleRoot), "utf8");
      const imported = await request(app).post("/api/models/import")
        .send({ sourceFormat, content, name: "  Banking model  " }).expect(201);
      expect(imported.body.model.model.name).toBe("Banking model");
      const saved = await request(app).get(`/api/models/${imported.body.model.modelId}`).expect(200);
      expect(saved.body.model.model.name).toBe("Banking model");
    }
    const content = readFileSync(new URL("customer-address.canonical.json", sampleRoot), "utf8");
    const defaultImport = await request(app).post("/api/models/import").send({ sourceFormat: "canonical", content }).expect(201);
    expect(defaultImport.body.model.model.name).toBe(JSON.parse(content).name);
    for (const name of ["  ", "x".repeat(121), 123]) {
      await request(app).post("/api/models/import").send({ sourceFormat: "canonical", content, name }).expect(400);
    }
    const longName = "x".repeat(120);
    const longImport = await request(app).post("/api/models/import").send({ sourceFormat: "canonical", content, name: longName }).expect(201);
    await request(app).post("/api/generation-profiles").send({ modelVersionId: longImport.body.model.id }).expect(201);
    await request(app).post(`/api/models/${defaultImport.body.model.modelId}/versions`)
      .send({ model: { ...defaultImport.body.model.model, name: "Renamed model" } }).expect(201);
    const list = await request(app).get("/api/models").expect(200);
    expect(list.body.models.find((model: { id: string }) => model.id === defaultImport.body.model.modelId).name).toBe("Renamed model");
  });

  it("imports Smart MDM fields as separate entities without inventing relationships", async () => {
    const schema = {
      format: "smart-mdm/schema", formatVersion: 1, domain: "party", domainLabel: "Party Master",
      schema: {
        fields: [
          { key: "party_id", type: "text", required: true },
          { key: "status", type: "dropdown", required: false, options: ["active", "retired"] },
          { key: "birth_date", type: "date", required: false, pii: "sensitive", qualityRules: { weight: 0 } },
          { key: "country", type: "dropdown", required: false },
          { key: "postal_code", type: "text", required: false },
        ],
        children: [{
          key: "identifiers", label: "Identifiers", matchKey: "value", maxOccurrences: 5, absence: "snapshot",
          fields: [
            { key: "value", type: "text", required: true, qualityRules: { unique: true } },
            { key: "verified", type: "boolean", required: false },
            { key: "postal_code", type: "text", required: false },
          ],
        }],
        roles: { Viewer: { canEdit: false } },
      },
    };
    const content = JSON.stringify(schema);
    const wrongFormat = await request(app).post("/api/models/import").send({ sourceFormat: "json-schema", content }).expect(400);
    expect(wrongFormat.body.error.code).toBe("WRONG_MODEL_FORMAT");
    const imported = await request(app).post("/api/models/import").send({ sourceFormat: "smart-mdm", content }).expect(201);
    const model = imported.body.model.model;
    expect(model.name).toBe("Party Master");
    const renamed = await request(app).post("/api/models/import")
      .send({ sourceFormat: "smart-mdm", content, name: "Banking party" }).expect(201);
    expect(renamed.body.model.model.name).toBe("Banking party");
    expect(imported.body.model.sourceFormat).toBe("smart-mdm");
    expect(model.entities.map((entity: { name: string }) => entity.name)).toEqual(["party", "identifiers"]);
    expect(model.entities[0].fields.find((field: { name: string }) => field.name === "status").enum).toEqual(["active", "retired"]);
    expect(model.entities[0].fields.find((field: { name: string }) => field.name === "country").enum).toBeUndefined();
    expect(model.entities[1].fields.find((field: { name: string }) => field.name === "value").unique).toBe(true);
    expect(model.entities.flatMap((entity: { fields: Array<{ primaryKey: boolean; foreignKey?: unknown }> }) => entity.fields)
      .every((field: { primaryKey: boolean; foreignKey?: unknown }) => !field.primaryKey && !field.foreignKey)).toBe(true);
    const profile = await request(app).post("/api/generation-profiles").send({ modelVersionId: imported.body.model.id }).expect(201);
    await request(app).post("/api/datasets").send({ profileId: profile.body.profile.id, name: "Smart MDM data" }).expect(201);

    const unsupported = structuredClone(schema);
    unsupported.schema.fields[0].type = "unsupported";
    await request(app).post("/api/models/import").send({ sourceFormat: "smart-mdm", content: JSON.stringify(unsupported) }).expect(400);
    const wrongVersion = { ...schema, formatVersion: 2 };
    await request(app).post("/api/models/import").send({ sourceFormat: "smart-mdm", content: JSON.stringify(wrongVersion) }).expect(400);
    const unknownRule = structuredClone(schema);
    Object.assign(unknownRule.schema.fields[1], { qualityRules: { min: 5 } });
    await request(app).post("/api/models/import").send({ sourceFormat: "smart-mdm", content: JSON.stringify(unknownRule) }).expect(400);
  });

  it("imports extended canonical models for review and requires acknowledgment before generating", async () => {
    const source = {
      name: "Banking model", modelFormat: "TestAgent canonical entities/fields JSON",
      description: "Extended model", businessRules: [{ description: "Example" }],
      entities: [
        { name: "Party", description: "Parent", scope: "core", uniqueConstraints: [["externalId"]], fields: [
          { name: "id", type: "string", required: true, primaryKey: true, generationRule: { type: "uuid" } },
          { name: "externalId", type: "string", required: true, generationRule: { type: "approvedFixtureOnly" } },
        ] },
        { name: "Child", subtypeOf: "Party", uniqueConstraints: [["id", "partyId"]], fields: [
          { name: "id", type: "string", required: true, primaryKey: true },
          { name: "partyId", type: "string", required: true, foreignKey: { entity: "Party", field: "id" } },
        ] },
      ],
    };
    const content = JSON.stringify(source);
    const wrong = await request(app).post("/api/models/import").send({ sourceFormat: "json-schema", content }).expect(400);
    expect(wrong.body.error.code).toBe("WRONG_MODEL_FORMAT");
    const imported = await request(app).post("/api/models/import").send({ sourceFormat: "extended-canonical", content }).expect(201);
    const version = imported.body.model;
    expect(version.model.entities[0].fields[1].unique).toBe(true);
    expect(version.model.entities[1].fields[1].foreignKey).toEqual({ entity: "Party", field: "id" });
    expect(version.model.entities[1].fields[1].unique).toBe(false);
    const blocked = await request(app).post("/api/generation-profiles").send({ modelVersionId: version.id }).expect(409);
    expect(blocked.body.error.code).toBe("PARTIAL_MODEL_REVIEW_REQUIRED");
    await request(app).post(`/api/models/${version.modelId}/versions`).send({ model: version.model }).expect(409);
    const reviewed = await request(app).post(`/api/models/${version.modelId}/versions`)
      .send({ model: version.model, acknowledgePartialModel: true }).expect(201);
    await request(app).post("/api/generation-profiles").send({ modelVersionId: reviewed.body.model.id }).expect(201);
    await request(app).post("/api/generation-profiles").send({ modelVersionId: version.id }).expect(409);
    const unsupported = structuredClone(source);
    Object.assign(unsupported.entities[0].fields[0], { undocumentedConstraint: true });
    await request(app).post("/api/models/import").send({ sourceFormat: "extended-canonical", content: JSON.stringify(unsupported) }).expect(400);
  });

  it("generates date-formatted strings and explicitly repairs legacy profile rules", async () => {
    const source = {
      name: "Dates", entities: [{ name: "Person", fields: [
        { name: "dateOfDeath", type: "string", format: "date", required: false },
        { name: "createdAt", type: "string", format: "date-time", required: true },
        { name: "dateOfBirth", type: "string", format: "date", required: true },
        { name: "note", type: "string", required: true },
      ] }],
    };
    const imported = await request(app).post("/api/models/import")
      .send({ sourceFormat: "canonical", content: JSON.stringify(source) }).expect(201);
    const profileResponse = await request(app).post("/api/generation-profiles")
      .send({ modelVersionId: imported.body.model.id }).expect(201);
    const profile = profileResponse.body.profile as GenerationProfile;
    expect(profile.rules["Person.dateOfDeath"].kind).toBe("date");
    expect(profile.rules["Person.createdAt"].kind).toBe("datetime");
    expect(profile.rules["Person.dateOfBirth"]).toMatchObject({ kind: "date", ageMin: 18, ageMax: 90 });
    const oldModel = structuredClone(imported.body.model.model);
    oldModel.entities[0].fields[0].suggestion.rule = { kind: "string", minLength: 6, maxLength: 16 };
    database.prepare("UPDATE model_versions SET model_json = ? WHERE id = ?").run(JSON.stringify(oldModel), imported.body.model.id);
    const legacyModelProfile = await request(app).post("/api/generation-profiles")
      .send({ modelVersionId: imported.body.model.id }).expect(201);
    expect(legacyModelProfile.body.profile.rules["Person.dateOfDeath"].kind).toBe("date");
    const rules = {
      ...profile.rules,
      "Person.dateOfDeath": { kind: "string", minLength: 6, maxLength: 16, nullProbability: 0.25 },
      "Person.createdAt": { kind: "string", minLength: 6, maxLength: 16 },
      "Person.dateOfBirth": { kind: "date", ageMin: 20, ageMax: 25 },
    };
    await request(app).patch(`/api/generation-profiles/${profile.id}`).send({ rules }).expect(200);
    const failure = await request(app).post("/api/datasets/preview").send({ profileId: profile.id }).expect(422);
    expect(failure.body.error.message).toContain("dateOfDeath:format");
    const repaired = await request(app).post(`/api/generation-profiles/${profile.id}/repair-date-rules`).send({}).expect(200);
    expect(repaired.body.updatedFields).toEqual(["Person.dateOfDeath", "Person.createdAt"]);
    expect(repaired.body.profile.rules["Person.dateOfDeath"]).toEqual({ kind: "date", nullProbability: 0.25 });
    expect(repaired.body.profile.rules["Person.dateOfBirth"]).toEqual({ kind: "date", ageMin: 20, ageMax: 25 });
    expect(repaired.body.profile.rules["Person.note"]).toEqual(profile.rules["Person.note"]);
    const preview = await request(app).post("/api/datasets/preview").send({ profileId: profile.id }).expect(200);
    const row = preview.body.records.find((record: { payload: { dateOfDeath?: unknown } }) => record.payload.dateOfDeath !== null);
    expect(row.payload.dateOfDeath).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(row.payload.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const again = await request(app).post(`/api/generation-profiles/${profile.id}/repair-date-rules`).send({}).expect(200);
    expect(again.body.updatedFields).toEqual([]);
  });

  it("allocates unique foreign keys without reusing parents and explains impossible counts", async () => {
    const source = {
      name: "One-to-one",
      entities: [
        { name: "Party", fields: [{ name: "id", type: "string", required: true, primaryKey: true }] },
        { name: "Person", fields: [{ name: "partyId", type: "string", required: true, primaryKey: true, foreignKey: { entity: "Party", field: "id" } }] },
      ],
    };
    const imported = await request(app).post("/api/models/import")
      .send({ sourceFormat: "canonical", content: JSON.stringify(source) }).expect(201);
    const created = await request(app).post("/api/generation-profiles")
      .send({ modelVersionId: imported.body.model.id }).expect(201);
    const profile = created.body.profile as GenerationProfile;
    expect(profile.recordCounts).toEqual({ Party: 20, Person: 20 });
    const dataset = await request(app).post("/api/datasets").send({ profileId: profile.id, name: "One-to-one" }).expect(201);
    const records = (await request(app).get(`/api/datasets/${dataset.body.dataset.id}/records?pageSize=100`).expect(200))
      .body.records as Array<{ entity: string; payload: { id?: string; partyId?: string } }>;
    const parents = new Set(records.filter((record) => record.entity === "Party").map((record) => record.payload.id));
    const children = records.filter((record) => record.entity === "Person").map((record) => record.payload.partyId);
    expect(new Set(children).size).toBe(20);
    expect(children.every((id) => parents.has(id))).toBe(true);

    await request(app).patch(`/api/generation-profiles/${profile.id}`).send({ recordCounts: { Party: 20, Person: 7 } }).expect(200);
    await request(app).post("/api/datasets/preview").send({ profileId: profile.id }).expect(200);
    await request(app).patch(`/api/generation-profiles/${profile.id}`).send({ recordCounts: { Party: 20, Person: 0 } }).expect(200);
    await request(app).post("/api/datasets/preview").send({ profileId: profile.id }).expect(200);
    await request(app).patch(`/api/generation-profiles/${profile.id}`).send({ recordCounts: { Party: 20, Person: 30 } }).expect(200);
    const invalid = await request(app).post("/api/datasets/preview").send({ profileId: profile.id }).expect(400);
    expect(invalid.body.error.code).toBe("INVALID_RELATIONSHIP_COUNTS");
    expect(invalid.body.error.message).toContain("Person.partyId");
    expect(invalid.body.error.message).toContain("30 Person");
    expect(invalid.body.error.message).toContain("20 Party");
  });

  it("honors explicit cardinality and uniqueness configured in foreign-key rules", async () => {
    const source = {
      name: "Configured relationship",
      entities: [
        { name: "Parent", fields: [{ name: "id", type: "string", required: true, primaryKey: true }] },
        { name: "Child", fields: [
          { name: "id", type: "string", required: true, primaryKey: true },
          { name: "parentId", type: "string", required: true, foreignKey: { entity: "Parent", field: "id" }, cardinality: { min: 1, max: 2 } },
        ] },
      ],
    };
    const imported = await request(app).post("/api/models/import").send({ sourceFormat: "canonical", content: JSON.stringify(source) }).expect(201);
    const created = await request(app).post("/api/generation-profiles").send({ modelVersionId: imported.body.model.id }).expect(201);
    const profile = created.body.profile as GenerationProfile;
    await request(app).patch(`/api/generation-profiles/${profile.id}`).send({
      recordCounts: { Parent: 20, Child: 20 },
      rules: { ...profile.rules, "Child.parentId": { kind: "foreignKey", unique: true } },
    }).expect(200);
    await request(app).post("/api/datasets/preview").send({ profileId: profile.id }).expect(200);
    await request(app).patch(`/api/generation-profiles/${profile.id}`).send({ recordCounts: { Parent: 20, Child: 0 } }).expect(200);
    const invalid = await request(app).post("/api/datasets/preview").send({ profileId: profile.id }).expect(400);
    expect(invalid.body.error.message).toContain("Child.parentId");
    expect(invalid.body.error.message).toContain("0 Child");
  });

  it("uses the model pattern for saved string rules without overriding an explicit rule pattern", async () => {
    const source = {
      name: "Patterned fields",
      entities: [{ name: "Person", fields: [
        { name: "birthCountry", type: "string", required: true, pattern: "^[A-Z]{2}$" },
      ] }],
    };
    const imported = await request(app).post("/api/models/import")
      .send({ sourceFormat: "canonical", content: JSON.stringify(source) }).expect(201);
    const created = await request(app).post("/api/generation-profiles")
      .send({ modelVersionId: imported.body.model.id }).expect(201);
    const profile = created.body.profile as GenerationProfile;
    expect(profile.rules["Person.birthCountry"].kind).toBe("string");
    const first = await request(app).post("/api/datasets/preview").send({ profileId: profile.id }).expect(200);
    const second = await request(app).post("/api/datasets/preview").send({ profileId: profile.id }).expect(200);
    const values = (body: { records: Array<{ payload: { birthCountry: string } }> }) =>
      body.records.map((record) => record.payload.birthCountry);
    expect(values(first.body)).toEqual(values(second.body));
    expect(values(first.body).every((value) => /^[A-Z]{2}$/.test(value))).toBe(true);

    await request(app).patch(`/api/generation-profiles/${profile.id}`).send({
      rules: { "Person.birthCountry": { kind: "string", pattern: "^[0-9]{2}$" } },
    }).expect(200);
    const invalid = await request(app).post("/api/datasets/preview").send({ profileId: profile.id }).expect(422);
    expect(invalid.body.error.message).toContain("birthCountry:pattern");

    const unsafe = structuredClone(source);
    unsafe.entities[0].fields[0].pattern = "^(?=A)A$";
    const unsafeModel = await request(app).post("/api/models/import")
      .send({ sourceFormat: "canonical", content: JSON.stringify(unsafe) }).expect(201);
    const rejected = await request(app).post("/api/generation-profiles")
      .send({ modelVersionId: unsafeModel.body.model.id }).expect(400);
    expect(rejected.body.error.code).toBe("UNSAFE_REGEX");
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
