import { useCallback, useEffect, useState } from "react";
import type {
  ConnectionInput,
  DatasetListResponse,
  DatasetManifest,
  SystemConnection,
  TestResult,
  TestRun,
  TestRunInput,
  TestSuite,
  TestSuiteInput,
} from "@agentx/shared";

type Tab = "configuration" | "execution";

interface ApiErrorBody {
  error?: { message?: string };
}

interface ConnectionCheck {
  ok: boolean;
  status: number;
  latencyMs: number;
}

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
      const body = await response.json() as ApiErrorBody;
      message = body.error?.message ?? message;
    } catch {
      // The response may not be JSON; preserve the HTTP status as the surfaced error.
    }
    throw new Error(message);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function isActiveRun(run: TestRun | null): boolean {
  return run?.status === "QUEUED" || run?.status === "RUNNING";
}

function verdictClass(status: string): string {
  return `verdict-tag verdict-${status.toLowerCase()}`;
}

export default function PhaseThreePage({ initialTab = "configuration" }: { initialTab?: Tab }) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [connections, setConnections] = useState<SystemConnection[]>([]);
  const [suites, setSuites] = useState<Array<{ id: string; name: string; latestVersion: number; caseCount: number }>>([]);
  const [datasets, setDatasets] = useState<DatasetManifest[]>([]);
  const [runs, setRuns] = useState<TestRun[]>([]);
  const [suiteId, setSuiteId] = useState("");
  const [connectionId, setConnectionId] = useState("");
  const [datasetId, setDatasetId] = useState("");
  const [selectedSuiteId, setSelectedSuiteId] = useState("");
  const [suiteDocument, setSuiteDocument] = useState("");
  const [selectedRunId, setSelectedRunId] = useState("");
  const [selectedRun, setSelectedRun] = useState<TestRun | null>(null);
  const [results, setResults] = useState<TestResult[]>([]);
  const [baseUrl, setBaseUrl] = useState("");
  const [connectionForm, setConnectionForm] = useState({
    name: "Local Customer MDM Sandbox",
    systemType: "Customer MDM",
    environment: "DEMO" as ConnectionInput["environment"],
    authType: "none" as ConnectionInput["authType"],
    secretRef: "",
    headersText: "{}",
    timeoutMs: 5000,
    maxConcurrency: 1,
    enabled: true,
  });
  const [editingConnectionId, setEditingConnectionId] = useState("");
  const [connectionCheck, setConnectionCheck] = useState<ConnectionCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const refreshWorkspace = useCallback(async () => {
    const [connectionResponse, suiteResponse, datasetResponse, runResponse, localDefault] = await Promise.all([
      apiRequest<{ connections: SystemConnection[] }>("/api/connections"),
      apiRequest<{ suites: Array<{ id: string; name: string; latestVersion: number; caseCount: number }> }>("/api/test-suites"),
      apiRequest<DatasetListResponse>("/api/datasets"),
      apiRequest<{ runs: TestRun[] }>("/api/test-runs"),
      apiRequest<{ baseUrl: string }>("/api/connections/local-default"),
    ]);
    setConnections(connectionResponse.connections);
    setSuites(suiteResponse.suites);
    const readyDatasets = datasetResponse.datasets.filter((dataset) => dataset.status === "READY");
    setDatasets(readyDatasets);
    setRuns(runResponse.runs);
    setBaseUrl(localDefault.baseUrl);
    setConnectionId((current) => current || connectionResponse.connections[0]?.id || "");
    setSuiteId((current) => current || suiteResponse.suites[0]?.id || "");
    setDatasetId((current) => current || readyDatasets[0]?.id || "");
  }, []);

  useEffect(() => {
    void refreshWorkspace().catch((requestError: unknown) => {
      setError(requestError instanceof Error ? requestError.message : "Unable to load test execution configuration.");
    });
  }, [refreshWorkspace]);

  const refreshSelectedRun = useCallback(async (runId: string) => {
    const [runResponse, resultResponse] = await Promise.all([
      apiRequest<{ run: TestRun }>(`/api/test-runs/${encodeURIComponent(runId)}`),
      apiRequest<{ results: TestResult[] }>(`/api/test-runs/${encodeURIComponent(runId)}/results`),
    ]);
    setSelectedRun(runResponse.run);
    setResults(resultResponse.results);
    setRuns((current) => [runResponse.run, ...current.filter((run) => run.id !== runResponse.run.id)]);
  }, []);

  useEffect(() => {
    if (!selectedRunId) return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async (): Promise<void> => {
      try {
        const [runResponse, resultResponse] = await Promise.all([
          apiRequest<{ run: TestRun }>(`/api/test-runs/${encodeURIComponent(selectedRunId)}`),
          apiRequest<{ results: TestResult[] }>(`/api/test-runs/${encodeURIComponent(selectedRunId)}/results`),
        ]);
        if (cancelled) return;
        setSelectedRun(runResponse.run);
        setResults(resultResponse.results);
        setRuns((current) => [runResponse.run, ...current.filter((run) => run.id !== runResponse.run.id)]);
        if (isActiveRun(runResponse.run)) timer = window.setTimeout(() => void poll(), 900);
      } catch (requestError) {
        if (!cancelled) setError(requestError instanceof Error ? requestError.message : "Unable to refresh run progress.");
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [selectedRunId]);

  async function perform(action: () => Promise<void>, successMessage: string): Promise<void> {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      setNotice(successMessage);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "The request failed.");
    } finally {
      setBusy(false);
    }
  }

  async function loadDemoConfiguration(): Promise<void> {
    await perform(async () => {
      const loaded = await apiRequest<{ connection: SystemConnection; suite: TestSuite }>("/api/demo/load", {
        method: "POST",
        body: JSON.stringify({}),
      });
      setConnectionId(loaded.connection.id);
      setSuiteId(loaded.suite.id);
      setSelectedSuiteId(loaded.suite.id);
      setSuiteDocument(JSON.stringify({ name: loaded.suite.name, cases: loaded.suite.cases }, null, 2));
      await refreshWorkspace();
    }, "Demo connection and immutable acceptance suite are ready.");
  }

  async function saveConnection(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    await perform(async () => {
      let headers: Record<string, string>;
      try {
        headers = JSON.parse(connectionForm.headersText) as Record<string, string>;
      } catch {
        throw new Error("Custom headers must be valid JSON.");
      }
      const input: ConnectionInput = {
        name: connectionForm.name.trim(),
        systemType: connectionForm.systemType.trim(),
        environment: connectionForm.environment,
        baseUrl,
        authType: connectionForm.authType,
        ...(connectionForm.authType === "none" || !connectionForm.secretRef.trim()
          ? {}
          : { secretRef: connectionForm.secretRef.trim() }),
        headers,
        timeoutMs: Number(connectionForm.timeoutMs),
        maxConcurrency: Number(connectionForm.maxConcurrency),
        enabled: connectionForm.enabled,
      };
      const endpoint = editingConnectionId
        ? `/api/connections/${encodeURIComponent(editingConnectionId)}`
        : "/api/connections";
      const response = await apiRequest<{ connection: SystemConnection }>(endpoint, {
        method: editingConnectionId ? "PATCH" : "POST",
        body: JSON.stringify(input),
      });
      setConnectionId(response.connection.id);
      setEditingConnectionId("");
      setConnectionCheck(null);
      await refreshWorkspace();
    }, editingConnectionId ? "Connection updated." : "Connection created.");
  }

  function editConnection(connection: SystemConnection): void {
    setEditingConnectionId(connection.id);
    setConnectionId(connection.id);
    setConnectionCheck(null);
    setConnectionForm({
      name: connection.name,
      systemType: connection.systemType,
      environment: connection.environment,
      authType: connection.authType,
      secretRef: connection.secretRef ?? "",
      headersText: JSON.stringify(connection.headers, null, 2),
      timeoutMs: connection.timeoutMs,
      maxConcurrency: connection.maxConcurrency,
      enabled: connection.enabled,
    });
    setError("");
  }

  async function checkConnection(id: string): Promise<void> {
    await perform(async () => {
      const result = await apiRequest<ConnectionCheck>(`/api/connections/${encodeURIComponent(id)}/check`, {
        method: "POST",
      });
      setConnectionCheck(result);
    }, "Local connection check passed.");
  }

  async function deleteConnection(id: string): Promise<void> {
    await perform(async () => {
      await apiRequest<void>(`/api/connections/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (connectionId === id) setConnectionId("");
      await refreshWorkspace();
    }, "Connection deleted.");
  }

  async function selectSuite(id: string): Promise<void> {
    setSelectedSuiteId(id);
    if (!id) {
      setSuiteDocument("");
      return;
    }
    await perform(async () => {
      const response = await apiRequest<{ suite: TestSuite }>(`/api/test-suites/${encodeURIComponent(id)}`);
      setSuiteDocument(JSON.stringify({ name: response.suite.name, cases: response.suite.cases }, null, 2));
    }, "Suite loaded.");
  }

  async function saveSuite(): Promise<void> {
    await perform(async () => {
      let input: TestSuiteInput;
      try {
        input = JSON.parse(suiteDocument) as TestSuiteInput;
      } catch {
        throw new Error("Suite configuration must be valid JSON.");
      }
      const endpoint = selectedSuiteId
        ? `/api/test-suites/${encodeURIComponent(selectedSuiteId)}`
        : "/api/test-suites";
      const response = await apiRequest<{ suite: TestSuite }>(endpoint, {
        method: selectedSuiteId ? "PATCH" : "POST",
        body: JSON.stringify(input),
      });
      setSelectedSuiteId(response.suite.id);
      setSuiteId(response.suite.id);
      setSuiteDocument(JSON.stringify({ name: response.suite.name, cases: response.suite.cases }, null, 2));
      await refreshWorkspace();
    }, "Suite saved as a new immutable version.");
  }

  async function startRun(): Promise<void> {
    await perform(async () => {
      const input: TestRunInput = { suiteId, connectionId, datasetId };
      const response = await apiRequest<{ run: TestRun }>("/api/test-runs", {
        method: "POST",
        body: JSON.stringify(input),
      });
      setSelectedRunId(response.run.id);
      setSelectedRun(response.run);
      setResults([]);
      setTab("execution");
      await refreshWorkspace();
    }, "Test run queued.");
  }

  async function cancelRun(): Promise<void> {
    if (!selectedRun) return;
    await perform(async () => {
      const response = await apiRequest<{ run: TestRun }>(`/api/test-runs/${encodeURIComponent(selectedRun.id)}/cancel`, {
        method: "POST",
      });
      setSelectedRun(response.run);
    }, "Cancellation requested.");
  }

  return (
    <div className="phase-three">
      {error && <div className="alert alert-error" role="alert"><strong>Request error</strong><span>{error}</span><button onClick={() => setError("")}>×</button></div>}
      {notice && <div className="alert alert-success" role="status"><strong>Done</strong><span>{notice}</span><button onClick={() => setNotice("")}>×</button></div>}

      <section className="page-heading">
        <div><div className="eyebrow">PHASE 3 · TEST DESIGN AND EXECUTION</div><h1>API test workbench</h1><p>Configure local sandbox connections, version suites, and inspect persisted execution evidence.</p></div>
        <div className="phase-actions">
          <button className="button button-secondary" disabled={busy} onClick={() => void perform(refreshWorkspace, "Workspace refreshed.")}>Refresh</button>
          <button className="button button-secondary" disabled={busy} onClick={() => void loadDemoConfiguration()}>Load demo configuration</button>
        </div>
      </section>

      <div className="phase-tabs" role="tablist" aria-label="Test workbench">
        <button className={tab === "configuration" ? "selected" : ""} onClick={() => setTab("configuration")} role="tab">Configuration <span>{connections.length + suites.length}</span></button>
        <button className={tab === "execution" ? "selected" : ""} onClick={() => setTab("execution")} role="tab">Execution <span>{runs.length}</span></button>
      </div>

      {tab === "configuration" ? (
        <div className="phase-three-grid">
          <div className="phase-stack">
            <section className="panel">
              <div className="panel-header"><div><h2>System connections</h2><p>Secrets are environment-variable references; targets are restricted to this local mock service.</p></div><span className="live-tag"><i /> {connections.length} CONNECTION{connections.length === 1 ? "" : "S"}</span></div>
              {connections.length === 0 ? <div className="phase-empty">Load the demo configuration or create a sandbox connection below.</div> : (
                <div className="phase-model-list">
                  {connections.map((connection) => (
                    <div className={`phase-model-item ${connection.id === connectionId ? "active" : ""}`} key={connection.id}>
                      <button className="phase-connection-select" onClick={() => setConnectionId(connection.id)}>
                        <span><strong>{connection.name}</strong><small>{connection.environment} · {connection.baseUrl}</small></span><b>{connection.enabled ? "ENABLED" : "DISABLED"}</b>
                      </button>
                      <div className="phase-actions">
                        <button className="button button-secondary" onClick={() => editConnection(connection)}>Edit</button>
                        <button className="button button-secondary" disabled={busy || !connection.enabled} onClick={() => void checkConnection(connection.id)}>Test</button>
                        <button className="text-button" disabled={busy} onClick={() => void deleteConnection(connection.id)}>Delete</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {connectionCheck && <div className="phase-three-callout">Connection healthy · HTTP {connectionCheck.status} · {connectionCheck.latencyMs} ms</div>}
            </section>

            <section className="panel">
              <div className="panel-header"><div><h2>{editingConnectionId ? "Edit connection" : "Create connection"}</h2><p>Execution is sandbox-scoped; external URLs are rejected by the API.</p></div></div>
              <form className="phase-form" onSubmit={(event) => void saveConnection(event)}>
                <label>Name<input required maxLength={100} value={connectionForm.name} onChange={(event) => setConnectionForm({ ...connectionForm, name: event.target.value })} /></label>
                <div className="phase-inline">
                  <label>System type<input required maxLength={80} value={connectionForm.systemType} onChange={(event) => setConnectionForm({ ...connectionForm, systemType: event.target.value })} /></label>
                  <label>Environment<select value={connectionForm.environment} onChange={(event) => setConnectionForm({ ...connectionForm, environment: event.target.value as ConnectionInput["environment"] })}><option>DEMO</option><option>DEV</option><option>QA</option><option>UAT</option></select></label>
                </div>
                <label>Base URL<input readOnly value={baseUrl} /></label>
                <div className="phase-inline">
                  <label>Authentication<select value={connectionForm.authType} onChange={(event) => setConnectionForm({ ...connectionForm, authType: event.target.value as ConnectionInput["authType"] })}><option value="none">None</option><option value="apiKey">API key</option><option value="bearer">Bearer token</option><option value="basic">Basic</option></select></label>
                  {connectionForm.authType !== "none" && <label>Secret environment variable<input required placeholder="DEMO_API_TOKEN" value={connectionForm.secretRef} onChange={(event) => setConnectionForm({ ...connectionForm, secretRef: event.target.value })} /></label>}
                </div>
                <label>Custom headers (JSON)<textarea rows={3} value={connectionForm.headersText} onChange={(event) => setConnectionForm({ ...connectionForm, headersText: event.target.value })} /></label>
                <div className="phase-inline">
                  <label>Timeout (ms)<input type="number" min={100} max={30000} value={connectionForm.timeoutMs} onChange={(event) => setConnectionForm({ ...connectionForm, timeoutMs: Number(event.target.value) })} /></label>
                  <label>Case concurrency<input type="number" min={1} max={5} value={connectionForm.maxConcurrency} onChange={(event) => setConnectionForm({ ...connectionForm, maxConcurrency: Number(event.target.value) })} /></label>
                </div>
                <label className="phase-checkbox"><input type="checkbox" checked={connectionForm.enabled} onChange={(event) => setConnectionForm({ ...connectionForm, enabled: event.target.checked })} /> Enabled</label>
                <div className="phase-actions"><button className="button button-primary" disabled={busy}>{editingConnectionId ? "Save connection" : "Create connection"}</button>{editingConnectionId && <button type="button" className="button button-secondary" onClick={() => setEditingConnectionId("")}>Cancel edit</button>}</div>
              </form>
            </section>
          </div>

          <div className="phase-stack">
            <section className="panel">
              <div className="panel-header"><div><h2>Versioned test suites</h2><p>Suite edits create immutable versions captured in each run snapshot.</p></div><span className="live-tag"><i /> {suites.length} SUITE{ suites.length === 1 ? "" : "S"}</span></div>
              {suites.length > 0 && <div className="phase-dataset-toolbar"><label>Selected suite<select value={selectedSuiteId} onChange={(event) => void selectSuite(event.target.value)}><option value="">Choose suite…</option>{suites.map((suite) => <option key={suite.id} value={suite.id}>{suite.name} · v{suite.latestVersion} · {suite.caseCount} cases</option>)}</select></label></div>}
              <div className="phase-form">
                <label>Suite JSON<textarea className="phase-three-code" rows={27} spellCheck={false} value={suiteDocument} onChange={(event) => setSuiteDocument(event.target.value)} placeholder={'{"name":"My suite","cases":[...]}'}/></label>
                <div className="phase-actions">
                  <button className="button button-primary" disabled={busy || !suiteDocument.trim()} onClick={() => void saveSuite()}>{selectedSuiteId ? "Save new version" : "Create suite"}</button>
                  <button className="button button-secondary" disabled={busy} onClick={() => { setSelectedSuiteId(""); setSuiteDocument(""); }}>New suite</button>
                </div>
                <p className="phase-help">Cases use JSON templates such as <code>{"{{record.customerId}}"}</code>, expected status codes, response assertions, extraction, and dependencies.</p>
              </div>
            </section>
          </div>
        </div>
      ) : (
        <div className="phase-stack">
          <section className="panel">
            <div className="panel-header"><div><h2>Start a test run</h2><p>Runs issue real HTTP requests to the configured local MDM sandbox.</p></div><span className="live-tag"><i /> SERVER EXECUTION</span></div>
            <div className="phase-three-toolbar">
              <label>Connection<select value={connectionId} onChange={(event) => setConnectionId(event.target.value)}><option value="">Select connection…</option>{connections.map((connection) => <option key={connection.id} value={connection.id}>{connection.name}{connection.enabled ? "" : " (disabled)"}</option>)}</select></label>
              <label>Suite<select value={suiteId} onChange={(event) => setSuiteId(event.target.value)}><option value="">Select suite…</option>{suites.map((suite) => <option key={suite.id} value={suite.id}>{suite.name} · v{suite.latestVersion}</option>)}</select></label>
              <label>Ready dataset<select value={datasetId} onChange={(event) => setDatasetId(event.target.value)}><option value="">Select dataset…</option>{datasets.map((dataset) => <option key={dataset.id} value={dataset.id}>{dataset.name} · {dataset.counts.total} records</option>)}</select></label>
              <button className="button button-primary" disabled={busy || !connectionId || !suiteId || !datasetId} onClick={() => void startRun()}>Start run <span>→</span></button>
            </div>
            {datasets.length === 0 && <div className="phase-three-callout">Generate a READY dataset in Synthetic data before starting a run.</div>}
          </section>

          <div className="phase-three-grid phase-three-execution">
            <section className="panel">
              <div className="panel-header"><div><h2>Run history</h2><p>Run state and counters are persisted in SQLite.</p></div><span className="live-tag"><i /> {runs.length} RUN{runs.length === 1 ? "" : "S"}</span></div>
              {runs.length === 0 ? <div className="phase-empty">No test runs yet.</div> : (
                <div className="phase-model-list">
                  {runs.map((run) => (
                    <button className={`phase-model-item ${run.id === selectedRunId ? "active" : ""}`} key={run.id} onClick={() => { setSelectedRunId(run.id); void refreshSelectedRun(run.id); }}>
                      <span><strong>{run.suiteName}</strong><small>{new Date(run.createdAt).toLocaleString()} · {run.datasetName}</small></span><b className={verdictClass(run.status)}>{run.status}</b>
                    </button>
                  ))}
                </div>
              )}
            </section>

            <section className="panel">
              <div className="panel-header"><div><h2>Live progress</h2><p>{selectedRun ? `${selectedRun.suiteName} · ${selectedRun.namespace}` : "Select or start a run to inspect evidence."}</p></div>
                {selectedRun && <div className="phase-actions">{isActiveRun(selectedRun) && <button className="button button-secondary" disabled={busy} onClick={() => void cancelRun()}>Cancel run</button>}<a className="button button-secondary phase-jsonl-link" href={`/api/test-runs/${encodeURIComponent(selectedRun.id)}/log`} download={`${selectedRun.id}.jsonl`}>Download JSONL</a></div>}
              </div>
              {selectedRun ? (
                <>
                  <div className="phase-counts">
                    <span><b>{selectedRun.counters.executed}/{selectedRun.counters.planned}</b> executed</span>
                    <span><b>{selectedRun.counters.passed}</b> PASS</span>
                    <span><b>{selectedRun.counters.failed}</b> FAIL</span>
                    <span><b>{selectedRun.counters.errors}</b> ERROR</span>
                    <span><b>{selectedRun.counters.blocked}</b> BLOCKED</span>
                    <span><b>{selectedRun.counters.cancelled}</b> CANCELLED</span>
                  </div>
                  <div className="phase-run-results">
                    {results.length === 0 ? <div className="phase-empty">Waiting for the first result…</div> : results.map((result) => (
                      <details className="phase-run-result" key={result.id} open={result.status === "FAIL" || result.status === "ERROR" || result.status === "BLOCKED"}>
                        <summary><span className={verdictClass(result.status)}>{result.status}</span><span className="phase-result-name">{result.caseName}</span><small>{result.inputRecordId} · {result.durationMs} ms</small></summary>
                        <p>{result.summary}</p>
                        {result.steps.map((step) => (
                          <div className="phase-step-evidence" key={step.id}>
                            <div><span className={`method-tag method-${step.method.toLowerCase()}`}>{step.method}</span><strong>{step.name}</strong><span>{step.responseStatus ? `HTTP ${step.responseStatus}` : step.error ?? "No response"}</span><small>{step.latencyMs === undefined ? "" : `${step.latencyMs} ms`}</small></div>
                            <code>{step.url}</code>
                            {step.assertions.length > 0 && <ul>{step.assertions.map((assertion, index) => <li key={`${assertion.path}-${index}`} className={assertion.passed ? "assertion-pass" : "assertion-fail"}>{assertion.passed ? "PASS" : "FAIL"} · {assertion.message}</li>)}</ul>}
                            {(step.requestBody !== undefined || step.responseBody !== undefined) && <pre>{JSON.stringify({ request: step.requestBody, response: step.responseBody }, null, 2)}</pre>}
                          </div>
                        ))}
                      </details>
                    ))}
                  </div>
                </>
              ) : <div className="phase-empty">Start a run or choose an item from run history.</div>}
            </section>
          </div>
        </div>
      )}
      <footer className="page-footer"><span>Loopback-only execution <span className="footer-dot">·</span> Redacted evidence <span className="footer-dot">·</span> SQLite + JSONL</span><span>Phase 3 · Test execution</span></footer>
    </div>
  );
}
