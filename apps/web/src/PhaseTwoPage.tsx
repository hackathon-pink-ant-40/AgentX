import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ApiError,
  CanonicalModel,
  DatasetManifest,
  DatasetPreviewResponse,
  DatasetRecordsResponse,
  GenerationProfile,
  GenerationProfileInput,
  ModelListItem,
  ModelResponse,
  ModelSourceFormat,
  ModelVersion,
  NegativeScenarioKind,
  SyntheticRecord,
} from "@agentx/shared";

type Props = { initialTab?: "models" | "data" };

const sourceFormats: ModelSourceFormat[] = ["canonical", "json-schema", "mermaid"];
const scenarioOptions: Array<{ id: NegativeScenarioKind; label: string }> = [
  { id: "missing_required", label: "Missing required value" },
  { id: "null_required", label: "Null required value" },
  { id: "invalid_enum", label: "Invalid enum" },
  { id: "invalid_length", label: "Invalid length" },
  { id: "invalid_format", label: "Invalid format" },
  { id: "orphan_fk", label: "Orphan foreign key" },
  { id: "duplicate_match", label: "Duplicate match" },
  { id: "boundary", label: "Boundary values" },
  { id: "unicode", label: "Unicode edge cases" },
];

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    let message = `Request failed with status ${response.status}`;
    try {
      const body = await response.json() as ApiError;
      message = body.error?.message ?? message;
    } catch {
      // Keep the HTTP status when an endpoint returns a non-JSON error.
    }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

function jsonBody(value: unknown): RequestInit {
  return { method: "POST", body: JSON.stringify(value) };
}

export default function PhaseTwoPage({ initialTab = "models" }: Props) {
  const [tab, setTab] = useState<"models" | "data">(initialTab);
  const [models, setModels] = useState<ModelListItem[]>([]);
  const [selectedModel, setSelectedModel] = useState<ModelVersion | null>(null);
  const [modelContent, setModelContent] = useState("");
  const [sourceFormat, setSourceFormat] = useState<ModelSourceFormat>("canonical");
  const [importContent, setImportContent] = useState("");
  const [samples, setSamples] = useState<Array<{ name: string; format: ModelSourceFormat; content: string }>>([]);
  const [profiles, setProfiles] = useState<GenerationProfile[]>([]);
  const [activeProfileId, setActiveProfileId] = useState("");
  const [datasets, setDatasets] = useState<DatasetManifest[]>([]);
  const [activeDatasetId, setActiveDatasetId] = useState("");
  const [preview, setPreview] = useState<DatasetPreviewResponse | null>(null);
  const [records, setRecords] = useState<SyntheticRecord[]>([]);
  const [recordTotal, setRecordTotal] = useState(0);
  const [recordPage, setRecordPage] = useState(1);
  const [recordSearch, setRecordSearch] = useState("");
  const [profileDraft, setProfileDraft] = useState<GenerationProfile | null>(null);
  const [recordCountsText, setRecordCountsText] = useState("{}");
  const [rulesText, setRulesText] = useState("{}");
  const [datasetName, setDatasetName] = useState("Customer & Address demo");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const loadWorkspace = useCallback(async () => {
    const [modelResult, profileResult, datasetResult, sampleResult] = await Promise.all([
      apiRequest<{ models: ModelListItem[] }>("/api/models"),
      apiRequest<{ profiles: GenerationProfile[] }>("/api/generation-profiles"),
      apiRequest<{ datasets: DatasetManifest[] }>("/api/datasets"),
      apiRequest<{ samples: typeof samples }>("/api/models/samples"),
    ]);
    setModels(modelResult.models);
    setProfiles(profileResult.profiles);
    setDatasets(datasetResult.datasets);
    setSamples(sampleResult.samples);
    setActiveProfileId((current) => profileResult.profiles.some((profile) => profile.id === current) ? current : profileResult.profiles[0]?.id ?? "");
    setActiveDatasetId((current) => datasetResult.datasets.some((dataset) => dataset.id === current) ? current : datasetResult.datasets[0]?.id ?? "");
  }, []);

  useEffect(() => {
    void loadWorkspace().catch((loadError: unknown) => setError(messageOf(loadError)));
  }, [loadWorkspace]);

  useEffect(() => {
    const model = models[0];
    if (!selectedModel && model) void selectModel(model.id);
  }, [models, selectedModel]);

  useEffect(() => {
    const profile = profiles.find((candidate) => candidate.id === activeProfileId) ?? null;
    setProfileDraft(profile);
    setRecordCountsText(profile ? JSON.stringify(profile.recordCounts, null, 2) : "{}");
    setRulesText(profile ? JSON.stringify(profile.rules, null, 2) : "{}");
  }, [activeProfileId, profiles]);

  const activeDataset = datasets.find((dataset) => dataset.id === activeDatasetId) ?? null;

  const refreshRecords = useCallback(async (datasetId: string, page: number, search: string) => {
    const query = new URLSearchParams({ page: String(page), pageSize: "20" });
    if (search.trim()) query.set("search", search.trim());
    const result = await apiRequest<DatasetRecordsResponse>(`/api/datasets/${encodeURIComponent(datasetId)}/records?${query}`);
    setRecords(result.records);
    setRecordTotal(result.total);
    setRecordPage(result.page);
  }, []);

  useEffect(() => {
    if (!activeDatasetId) {
      setRecords([]);
      setRecordTotal(0);
      return;
    }
    void refreshRecords(activeDatasetId, recordPage, recordSearch).catch((loadError: unknown) => setError(messageOf(loadError)));
  }, [activeDatasetId, recordPage, recordSearch, refreshRecords]);

  async function perform(action: () => Promise<void>, successMessage: string): Promise<void> {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      setNotice(successMessage);
    } catch (actionError) {
      setError(messageOf(actionError));
    } finally {
      setBusy(false);
    }
  }

  async function selectModel(modelId: string): Promise<void> {
    const result = await apiRequest<ModelResponse>(`/api/models/${encodeURIComponent(modelId)}`);
    setSelectedModel(result.model);
    setModelContent(JSON.stringify(result.model.model, null, 2));
  }

  async function importModel(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    await perform(async () => {
      const result = await apiRequest<{ model: ModelVersion }>("/api/models/import", jsonBody({
        sourceFormat,
        content: importContent,
      }));
      setSelectedModel(result.model);
      setModelContent(JSON.stringify(result.model.model, null, 2));
      setImportContent("");
      await loadWorkspace();
    }, "Model imported and stored as version 1.");
  }

  async function saveModelVersion(): Promise<void> {
    if (!selectedModel) return;
    await perform(async () => {
      const model = JSON.parse(modelContent) as CanonicalModel;
      const result = await apiRequest<{ model: ModelVersion }>(
        `/api/models/${encodeURIComponent(selectedModel.modelId)}/versions`,
        jsonBody({ model }),
      );
      setSelectedModel(result.model);
      setModelContent(JSON.stringify(result.model.model, null, 2));
      await loadWorkspace();
    }, "A new immutable model version was saved.");
  }

  function setForeignKeyMapping(entityName: string, fieldName: string, reference: { entity: string; field: string }): void {
    try {
      const model = JSON.parse(modelContent) as CanonicalModel;
      const field = model.entities.find((entity) => entity.name === entityName)?.fields.find((candidate) => candidate.name === fieldName);
      if (!field) return;
      field.foreignKey = reference;
      field.mappingRequired = false;
      setModelContent(JSON.stringify(model, null, 2));
    } catch {
      setError("Fix the model JSON before editing foreign-key mappings.");
    }
  }

  async function createProfile(): Promise<void> {
    if (!selectedModel) return;
    await perform(async () => {
      const result = await apiRequest<{ profile: GenerationProfile }>("/api/generation-profiles", jsonBody({
        modelVersionId: selectedModel.id,
      }));
      await loadWorkspace();
      setActiveProfileId(result.profile.id);
      setTab("data");
    }, "Default generation profile created. Review and save its rules before generating.");
  }

  async function saveProfile(): Promise<void> {
    if (!profileDraft) return;
    await perform(async () => {
      const input: GenerationProfileInput = {
        modelVersionId: profileDraft.modelVersionId,
        name: profileDraft.name,
        locale: profileDraft.locale,
        seed: profileDraft.seed,
        referenceDate: profileDraft.referenceDate,
        recordCounts: JSON.parse(recordCountsText) as Record<string, number>,
        rules: JSON.parse(rulesText) as GenerationProfile["rules"],
        negativeScenarios: profileDraft.negativeScenarios,
      };
      const result = await apiRequest<{ profile: GenerationProfile }>(
        `/api/generation-profiles/${encodeURIComponent(profileDraft.id)}`,
        { method: "PATCH", body: JSON.stringify(input) },
      );
      await loadWorkspace();
      setActiveProfileId(result.profile.id);
    }, "Generation profile saved.");
  }

  async function runPreview(): Promise<void> {
    if (!activeProfileId) return;
    await perform(async () => {
      const result = await apiRequest<DatasetPreviewResponse>("/api/datasets/preview", jsonBody({ profileId: activeProfileId }));
      setPreview(result);
    }, "Preview generated using the configured seed and rules.");
  }

  async function createDataset(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!activeProfileId) return;
    await perform(async () => {
      const result = await apiRequest<{ dataset: DatasetManifest }>("/api/datasets", jsonBody({
        profileId: activeProfileId,
        name: datasetName,
      }));
      await loadWorkspace();
      setActiveDatasetId(result.dataset.id);
      setRecordPage(1);
      setPreview(null);
    }, "Dataset generated, persisted, and exports published.");
  }

  async function loadSample(sampleName: string): Promise<void> {
    const sample = samples.find((candidate) => candidate.name === sampleName);
    if (!sample) return;
    setSourceFormat(sample.format);
    setImportContent(sample.content);
  }

  const mappingFields = useMemo(() => {
    try {
      const model = JSON.parse(modelContent) as CanonicalModel;
      return model.entities.flatMap((entity) => entity.fields
        .filter((field) => field.mappingRequired || (field.foreignKeyCandidates?.length ?? 0) > 0)
        .map((field) => ({ entity: entity.name, field })));
    } catch {
      return [];
    }
  }, [modelContent]);

  return (
    <section className="phase-two">
      <div className="page-heading">
        <div><div className="eyebrow">MODEL-DRIVEN SYNTHETIC DATA</div><h1>Data models & synthetic data</h1><p>Import, map, configure, preview, and export deterministic test datasets.</p></div>
        <span className="connection-chip"><i /> Local SQLite · synthetic only</span>
      </div>
      {error && <div className="alert alert-error" role="alert"><strong>Request error</strong><span>{error}</span><button onClick={() => setError("")}>×</button></div>}
      {notice && <div className="alert alert-success" role="status"><strong>Done</strong><span>{notice}</span><button onClick={() => setNotice("")}>×</button></div>}
      <div className="phase-tabs" role="tablist" aria-label="Phase 2 workbench">
        <button className={tab === "models" ? "selected" : ""} onClick={() => setTab("models")} role="tab">Data models <span>{models.length}</span></button>
        <button className={tab === "data" ? "selected" : ""} onClick={() => setTab("data")} role="tab">Synthetic data <span>{datasets.length}</span></button>
      </div>

      {tab === "models" ? (
        <div className="phase-columns">
          <div className="phase-stack">
            <section className="panel">
              <div className="panel-header"><div><h2>Import a data model</h2><p>Canonical JSON, supported JSON Schema, or Mermaid ER.</p></div><span className="method-tag method-post">POST</span></div>
              <form className="phase-form" onSubmit={(event) => void importModel(event)}>
                <div className="phase-inline">
                  <label>Format<select value={sourceFormat} onChange={(event) => setSourceFormat(event.target.value as ModelSourceFormat)}>{sourceFormats.map((format) => <option key={format} value={format}>{format}</option>)}</select></label>
                  <label>Load sample<select defaultValue="" onChange={(event) => void loadSample(event.target.value)}><option value="">Choose sample…</option>{samples.map((sample) => <option key={sample.name} value={sample.name}>{sample.name}</option>)}</select></label>
                </div>
                <label>Model document<textarea value={importContent} onChange={(event) => setImportContent(event.target.value)} required rows={11} placeholder="Paste a model document or load a sample" /></label>
                <button className="button button-primary" disabled={busy || !importContent.trim()}>Import model <span>→</span></button>
              </form>
            </section>
            <section className="panel">
              <div className="panel-header"><div><h2>Saved models</h2><p>Immutable versions are stored locally.</p></div><span className="live-tag"><i /> {models.length} MODEL{models.length === 1 ? "" : "S"}</span></div>
              {models.length === 0 ? <div className="phase-empty">Import a sample or your own model to begin.</div> : (
                <div className="phase-model-list">{models.map((model) => (
                  <button className={`phase-model-item ${selectedModel?.modelId === model.id ? "active" : ""}`} key={model.id} onClick={() => void selectModel(model.id)}>
                    <span><strong>{model.name}</strong><small>Latest version {model.latestVersion}</small></span><b>→</b>
                  </button>
                ))}</div>
              )}
            </section>
          </div>
          <div className="phase-stack">
            <section className="panel">
              <div className="panel-header"><div><h2>Model review & mappings</h2><p>{selectedModel ? `${selectedModel.model.name} · v${selectedModel.version} · ${selectedModel.sourceFormat}` : "Select or import a model to review it."}</p></div>
                {selectedModel && <span className="method-tag method-post">v{selectedModel.version}</span>}
              </div>
              {selectedModel ? (
                <div className="phase-form">
                  <div className="phase-entity-summary">{selectedModel.model.entities.map((entity) => (
                    <span key={entity.name}><strong>{entity.name}</strong>{entity.fields.length} fields · {entity.fields.filter((field) => field.primaryKey).length} PK</span>
                  ))}</div>
                  {mappingFields.length > 0 && <div className="phase-mappings">
                    <strong>Resolve foreign-key mappings</strong>
                    {mappingFields.map(({ entity, field }) => (
                      <label key={`${entity}.${field.name}`}>{entity}.{field.name}
                        <select value={field.foreignKey ? `${field.foreignKey.entity}.${field.foreignKey.field}` : ""} onChange={(event) => {
                          const [targetEntity, targetField] = event.target.value.split(".");
                          if (targetEntity && targetField) setForeignKeyMapping(entity, field.name, { entity: targetEntity, field: targetField });
                        }}>
                          <option value="">Choose parent key…</option>
                          {(field.foreignKeyCandidates ?? []).map((candidate) => <option key={`${candidate.entity}.${candidate.field}`} value={`${candidate.entity}.${candidate.field}`}>{candidate.entity}.{candidate.field}</option>)}
                        </select>
                      </label>
                    ))}
                    <p>Saving a model version validates the selected relationships and prevents unresolved mappings from generating data.</p>
                  </div>}
                  <label className="phase-label">Canonical model JSON<textarea value={modelContent} onChange={(event) => setModelContent(event.target.value)} rows={16} spellCheck={false} /></label>
                  <div className="phase-actions"><button className="button button-secondary" disabled={busy} onClick={() => void saveModelVersion()}>Save as new version</button><button className="button button-primary" disabled={busy} onClick={() => void createProfile()}>Create profile <span>→</span></button></div>
                </div>
              ) : <div className="phase-empty">Model structure, inferred attributes, and relationship mappings appear here.</div>}
            </section>
          </div>
        </div>
      ) : (
        <div className="phase-stack">
          <section className="panel">
            <div className="panel-header"><div><h2>Generation profile</h2><p>Configure localized Faker values, cardinality, field rules, and negative scenarios.</p></div><span className="method-tag method-post">PROFILE</span></div>
            <div className="phase-form">
              <div className="phase-inline">
                <label>Profile<select value={activeProfileId} onChange={(event) => setActiveProfileId(event.target.value)}><option value="">Select a saved profile…</option>{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label>
                <label>Model version<select value={profileDraft?.modelVersionId ?? ""} disabled><option value="">Selected profile model version</option>{models.map((model) => <option key={model.latestVersionId} value={model.latestVersionId}>{model.name} · latest v{model.latestVersion}</option>)}</select></label>
              </div>
              {!profileDraft ? <div className="phase-empty">Import and select a model, then choose “Create profile”.</div> : (
                <>
                  <div className="phase-inline phase-profile-fields">
                    <label>Profile name<input value={profileDraft.name} onChange={(event) => setProfileDraft({ ...profileDraft, name: event.target.value })} /></label>
                    <label>Locale<select value={profileDraft.locale} onChange={(event) => setProfileDraft({ ...profileDraft, locale: event.target.value as GenerationProfile["locale"] })}><option value="en">English (en)</option><option value="nl">Dutch (nl)</option><option value="de">German (de)</option></select></label>
                    <label>Seed<input value={profileDraft.seed} onChange={(event) => setProfileDraft({ ...profileDraft, seed: event.target.value })} /></label>
                    <label>Reference date<input type="date" value={profileDraft.referenceDate} onChange={(event) => setProfileDraft({ ...profileDraft, referenceDate: event.target.value })} /></label>
                  </div>
                  <div className="phase-inline phase-json-editors">
                    <label>Per-entity record counts (JSON)<textarea value={recordCountsText} onChange={(event) => setRecordCountsText(event.target.value)} rows={7} spellCheck={false} /></label>
                    <label>Attribute generation rules (JSON)<textarea value={rulesText} onChange={(event) => setRulesText(event.target.value)} rows={7} spellCheck={false} /></label>
                  </div>
                  <div className="phase-scenarios"><strong>Negative scenarios</strong><div>{scenarioOptions.map((scenario) => (
                    <label key={scenario.id}><input type="checkbox" checked={profileDraft.negativeScenarios.includes(scenario.id)} onChange={(event) => {
                      const selected = event.target.checked
                        ? [...profileDraft.negativeScenarios, scenario.id]
                        : profileDraft.negativeScenarios.filter((item) => item !== scenario.id);
                      setProfileDraft({ ...profileDraft, negativeScenarios: selected });
                    }} />{scenario.label}</label>
                  ))}</div></div>
                  <div className="phase-actions"><button className="button button-secondary" disabled={busy} onClick={() => void saveProfile()}>Save profile</button><button className="button button-primary" disabled={busy} onClick={() => void runPreview()}>Preview data <span>→</span></button></div>
                </>
              )}
            </div>
          </section>

          {preview && <section className="panel">
            <div className="panel-header"><div><h2>Generation preview</h2><p>{preview.counts.total} valid records · deterministic preview</p></div><span className="live-tag"><i /> PREVIEW</span></div>
            <div className="phase-counts">{Object.entries(preview.counts.entities).map(([entity, count]) => <span key={entity}><b>{count}</b>{entity}</span>)}</div>
            <RecordTable records={preview.records} />
          </section>}

          <section className="panel">
            <div className="panel-header"><div><h2>Generate a dataset</h2><p>Persist records and publish JSON/CSV exports locally.</p></div><span className="method-tag method-post">DATASET</span></div>
            <form className="phase-form phase-generate" onSubmit={(event) => void createDataset(event)}>
              <label>Dataset name<input value={datasetName} onChange={(event) => setDatasetName(event.target.value)} required maxLength={100} /></label>
              <button className="button button-primary" disabled={busy || !activeProfileId}>Generate dataset <span>→</span></button>
            </form>
          </section>

          <section className="panel">
            <div className="panel-header"><div><h2>Persisted datasets</h2><p>Search, paginate, inspect scenario metadata, or download exports.</p></div><span className="live-tag"><i /> {datasets.length} READY</span></div>
            {datasets.length > 0 ? (
              <>
                <div className="phase-dataset-toolbar">
                  <label>Dataset<select value={activeDatasetId} onChange={(event) => { setActiveDatasetId(event.target.value); setRecordPage(1); }}><option value="">Select dataset…</option>{datasets.map((dataset) => <option key={dataset.id} value={dataset.id}>{dataset.name} · {dataset.createdAt.slice(0, 10)}</option>)}</select></label>
                  <label>Search records<input value={recordSearch} onChange={(event) => { setRecordSearch(event.target.value); setRecordPage(1); }} placeholder="ID or payload text" /></label>
                </div>
                {activeDataset && <>
                  <div className="phase-counts">{Object.entries(activeDataset.counts.entities).map(([entity, count]) => <span key={entity}><b>{count}</b>{entity}</span>)}<span><b>{activeDataset.counts.total}</b>Total</span></div>
                  <div className="phase-downloads">
                    <a href={`/api/datasets/${encodeURIComponent(activeDataset.id)}/export/combined`}>Download combined JSON</a>
                    <a href={`/api/datasets/${encodeURIComponent(activeDataset.id)}/export/manifest`}>Download manifest</a>
                    {activeDataset.files.entities.map((entity) => <span key={entity.name}><b>{entity.name}</b><a href={`/api/datasets/${encodeURIComponent(activeDataset.id)}/export/entity-json?entity=${encodeURIComponent(entity.name)}`}>JSON</a><a href={`/api/datasets/${encodeURIComponent(activeDataset.id)}/export/entity-csv?entity=${encodeURIComponent(entity.name)}`}>CSV</a></span>)}
                  </div>
                  <RecordTable records={records} />
                  <div className="phase-pagination"><span>{recordTotal} matching records</span><button className="button button-secondary" disabled={recordPage <= 1} onClick={() => setRecordPage((page) => page - 1)}>Previous</button><span>Page {recordPage} of {Math.max(1, Math.ceil(recordTotal / 20))}</span><button className="button button-secondary" disabled={recordPage * 20 >= recordTotal} onClick={() => setRecordPage((page) => page + 1)}>Next</button></div>
                </>}
              </>
            ) : <div className="phase-empty">Generated datasets will appear here with search, pagination, and downloadable exports.</div>}
          </section>
        </div>
      )}
      <footer className="page-footer"><span>Models, profiles, datasets, and exports stay on this machine.</span><span>Phase 2 · Synthetic-only data</span></footer>
    </section>
  );
}

function RecordTable({ records }: { records: SyntheticRecord[] }) {
  if (records.length === 0) return <div className="phase-empty">No records match this view.</div>;
  return (
    <div className="table-wrap phase-records">
      <table><thead><tr><th>RECORD</th><th>ENTITY</th><th>SCENARIO</th><th>VALID</th><th>PAYLOAD</th></tr></thead>
        <tbody>{records.map((record) => <tr key={record.recordId}>
          <td><code>{record.recordId}</code></td><td>{record.entity}</td><td><span className={`status-tag ${record.metadata.expectedValid ? "active" : "merged"}`}>{record.metadata.scenarioId}</span></td>
          <td>{record.metadata.expectedValid ? "Yes" : "No"}</td><td><code>{JSON.stringify(record.payload)}</code>{record.metadata.reason && <small className="phase-record-reason">{record.metadata.reason}</small>}</td>
        </tr>)}</tbody>
      </table>
    </div>
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "The request failed.";
}
