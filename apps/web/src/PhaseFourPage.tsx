import { useCallback, useEffect, useState } from "react";
import type { DefectCandidate, GateDecision, ReleasePolicy, ReleasePolicyInput, RunMetrics, TestResult } from "@agentx/shared";

type Tab = "dashboard" | "audit" | "policies";
type Filters = { entity: string; operation: string; caseId: string; status: string; pbi: string; search: string; datasetId: string; environment: string; from: string; to: string };
type HistoryRun = { id: string; datasetId: string; status: string; createdAt: string; environment: string; suiteName: string; metrics: RunMetrics; decision: string };
type Group = { name: string; counts: Record<string, number> };
type Analytics = { metrics: RunMetrics; gate: GateDecision; entityGroups: Group[]; operationGroups: Group[] };
type SyntheticRecord = { datasetId: string; recordId: string; entity: string; businessId: string | null; scenarioId: string; expectedValid: boolean; payload: unknown; createdAt: string };
type Detail = { result: TestResult; datasetId: string; input: unknown; source: unknown; expectedStatuses: Record<string, number[]> };

const initialFilters: Filters = { entity: "", operation: "", caseId: "", status: "", pbi: "", search: "", datasetId: "", environment: "", from: "", to: "" };
const statuses = ["PASS", "FAIL", "ERROR", "BLOCKED", "CANCELLED", "RUNNING"] as const;
const colors: Record<string, string> = { PASS: "#35b985", FAIL: "#e65f70", ERROR: "#ec9a48", BLOCKED: "#9b88c9", CANCELLED: "#a5acb9", RUNNING: "#689be8" };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers } });
  if (!response.ok) {
    const body = await response.json() as { error?: { message?: string } };
    throw new Error(body.error?.message ?? `Request failed (${response.status}).`);
  }
  return response.json() as Promise<T>;
}

function query(filters: Filters, page = 1): string {
  const params = new URLSearchParams({ page: String(page), pageSize: "20" });
  Object.entries(filters).forEach(([key, value]) => { if (value) params.set(key, value); });
  return params.toString();
}

export default function PhaseFourPage({ initialTab }: { initialTab: Tab }) {
  const [tab, setTab] = useState(initialTab);
  const [filters, setFilters] = useState<Filters>(initialFilters);
  const [history, setHistory] = useState<HistoryRun[]>([]);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [runId, setRunId] = useState("");
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [results, setResults] = useState<TestResult[]>([]);
  const [records, setRecords] = useState<SyntheticRecord[]>([]);
  const [auditType, setAuditType] = useState<"results" | "records">("results");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [recordDetail, setRecordDetail] = useState<SyntheticRecord | null>(null);
  const [policies, setPolicies] = useState<ReleasePolicy[]>([]);
  const [selectedPolicy, setSelectedPolicy] = useState("");
  const [policyForm, setPolicyForm] = useState<ReleasePolicyInput>({ name: "", environment: "DEMO", passThreshold: 80, minimumCoverage: 100, maxCriticalFailures: 0, allowErrors: false, allowBlocked: false });
  const [defects, setDefects] = useState<DefectCandidate[]>([]);
  const [regression, setRegression] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);

  const changeFilter = useCallback((key: keyof Filters, value: string) => {
    setFilters((current) => ({ ...current, [key]: value }));
    setPage(1);
    setHistoryPage(1);
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    Promise.all([
      request<{ runs: HistoryRun[]; total: number }>(`/api/analytics/runs?${query(filters, historyPage)}`),
      request<{ policies: ReleasePolicy[] }>("/api/release-policies"),
      request<{ defects: DefectCandidate[] }>("/api/defects"),
      request<{ enabled: boolean }>("/api/demo/regression"),
    ]).then(([runs, policyResponse, defectResponse, regressionResponse]) => {
      if (!active) return;
      setHistory(runs.runs); setHistoryTotal(runs.total); setPolicies(policyResponse.policies);
      setDefects(defectResponse.defects); setRegression(regressionResponse.enabled);
      setRunId((current) => runs.runs.some((run) => run.id === current) ? current : runs.runs[0]?.id || "");
      setError("");
    }).catch((failure: unknown) => { if (active) setError(failure instanceof Error ? failure.message : "Unable to load analytics."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [filters, historyPage, refresh]);

  useEffect(() => {
    let active = true;
    if (!runId) { setAnalytics(null); setResults([]); return () => { active = false; }; }
    Promise.all([
      request<Analytics>(`/api/analytics/runs/${encodeURIComponent(runId)}?${query(filters)}`),
      request<{ results: TestResult[]; total: number }>(`/api/analytics/runs/${encodeURIComponent(runId)}/results?${query(filters, page)}`),
    ]).then(([data, resultResponse]) => {
      if (!active) return;
      setAnalytics(data); setResults(resultResponse.results);
      if (auditType === "results") setTotal(resultResponse.total);
    }).catch((failure: unknown) => { if (active) setError(failure instanceof Error ? failure.message : "Unable to load run."); });
    return () => { active = false; };
  }, [runId, filters, page, auditType, refresh]);

  useEffect(() => {
    if (auditType !== "records") return;
    let active = true;
    request<{ records: SyntheticRecord[]; total: number }>(`/api/analytics/records?${query(filters, page)}`)
      .then((data) => { if (active) { setRecords(data.records); setTotal(data.total); } })
      .catch((failure: unknown) => { if (active) setError(failure instanceof Error ? failure.message : "Unable to load records."); });
    return () => { active = false; };
  }, [auditType, filters, page, refresh]);

  async function perform(action: () => Promise<void>): Promise<void> {
    setError("");
    try { await action(); setRefresh((value) => value + 1); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Request failed."); }
  }

  const selectPolicy = (id: string) => {
    setSelectedPolicy(id);
    const policy = policies.find((item) => item.id === id);
    if (policy) setPolicyForm({ name: policy.name, environment: policy.environment, passThreshold: policy.passThreshold,
      minimumCoverage: policy.minimumCoverage, maxCriticalFailures: policy.maxCriticalFailures,
      allowErrors: policy.allowErrors, allowBlocked: policy.allowBlocked });
    else setPolicyForm({ name: "", environment: "DEMO", passThreshold: 80, minimumCoverage: 100, maxCriticalFailures: 0, allowErrors: false, allowBlocked: false });
  };

  const metrics = analytics?.metrics;
  const values = metrics ? [
    ["Planned", metrics.planned], ["Executed", metrics.executed], ["Passed", metrics.passed], ["Failed", metrics.failed],
    ["Errors", metrics.errors], ["Blocked", metrics.blocked], ["Cancelled", metrics.cancelled], ["Critical non-PASS", metrics.criticalNonPass],
    ["Pass rate", `${metrics.passRate.toFixed(2)}%`], ["Coverage", `${metrics.coverage.toFixed(2)}%`], ["Elapsed", `${(metrics.elapsedMs / 1000).toFixed(2)}s`],
  ] : [];
  let offset = 0;
  const donutSegments = metrics && metrics.planned ? statuses.map((status) => {
    const count = status === "PASS" ? metrics.passed : status === "FAIL" ? metrics.failed : status === "ERROR" ? metrics.errors :
      status === "BLOCKED" ? metrics.blocked : status === "CANCELLED" ? metrics.cancelled : metrics.running;
    const start = offset; offset += count / metrics.planned * 100;
    return `${colors[status]} ${start}% ${offset}%`;
  }) : [];
  if (offset < 100) donutSegments.push(`#eef0f5 ${offset}% 100%`);
  const donut = donutSegments.join(", ");

  return <div className="phase-four">
    <div className="page-heading"><div><div className="eyebrow">PERSISTED EXECUTION EVIDENCE</div><h1>Release intelligence</h1><p>Local recommendations only; no deployment or external tickets.</p></div>
      <button className="button button-secondary" onClick={() => setRefresh((value) => value + 1)}>Refresh</button></div>
    <div className="phase-tabs">{(["dashboard", "audit", "policies"] as const).map((item) => <button key={item} className={tab === item ? "selected" : ""} onClick={() => setTab(item)}>{item === "audit" ? "Audit explorer" : item === "policies" ? "Release policies & defects" : "Dashboard"}</button>)}</div>
    {error && <div role="alert" className="alert alert-error"><strong>Error</strong><span>{error}</span><button onClick={() => setError("")}>×</button></div>}
    {loading && <p role="status">Loading persisted data…</p>}
    {tab !== "policies" && <>
      <div className="panel phase-form analytics-filters">
        <label>Historical run<select value={runId} onChange={(event) => { setRunId(event.target.value); setPage(1); setDetail(null); }}>
          <option value="">Select a run</option>{runId && !history.some((run) => run.id === runId) && <option value={runId}>{runId}</option>}
          {history.map((run) => <option key={run.id} value={run.id}>{new Date(run.createdAt).toLocaleString()} · {run.suiteName} · {run.decision}</option>)}</select></label>
        {(["entity", "operation", "caseId", "pbi", "datasetId", "environment", "search"] as const).map((key) => <label key={key}>{({ entity: "Entity", operation: "Operation", caseId: "Case ID", pbi: "PBI", datasetId: "Dataset ID", environment: "Environment", search: "Search ID / customer" })[key]}<input value={filters[key]} onChange={(event) => changeFilter(key, event.target.value)} /></label>)}
        <label>Status<select value={filters.status} onChange={(event) => changeFilter("status", event.target.value)}><option value="">All statuses</option>{statuses.map((status) => <option key={status}>{status}</option>)}</select></label>
        <label>From date<input type="date" value={filters.from} onChange={(event) => changeFilter("from", event.target.value)} /></label>
        <label>To date<input type="date" value={filters.to} onChange={(event) => changeFilter("to", event.target.value)} /></label>
        <button className="button button-secondary" onClick={() => { setFilters(initialFilters); setHistoryPage(1); setPage(1); }}>Clear filters</button>
      </div>
      <div className="analytics-pagination"><button disabled={historyPage === 1} onClick={() => setHistoryPage(historyPage - 1)}>Previous runs</button><span>Runs page {historyPage} · {historyTotal} total</span><button disabled={historyPage * 20 >= historyTotal} onClick={() => setHistoryPage(historyPage + 1)}>Next runs</button></div>
    </>}
    {tab === "dashboard" && <>
      {!runId && !loading && <div className="empty-state"><strong>No runs yet</strong><span>Execute a test suite to populate the dashboard.</span></div>}
      {metrics && analytics && <>
        <div className="stat-grid">{values.map(([label, value]) => <div className="stat-card" key={label}><div className="stat-top">{label}</div><strong className="stat-value">{value}</strong></div>)}</div>
        <p className="analytics-note">Filtered metrics use matching persisted results. The release recommendation always uses the complete run and its captured policy.</p>
        <div className="panel phase-form"><h2>Recommendation: {analytics.gate.decision}</h2><p>{analytics.gate.policy ? `${analytics.gate.policy.name} v${analytics.gate.policy.version} · ${analytics.gate.policy.environment}` : "No captured policy"}</p><ul>{analytics.gate.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul></div>
        <div className="analytics-charts">
          <div className="panel phase-form"><h2>Status distribution</h2><div className="analytics-donut" role="img" aria-label="Status distribution" style={{ background: `conic-gradient(${donut})` }} /><div className="analytics-legend">{statuses.map((status) => <button key={status} onClick={() => changeFilter("status", filters.status === status ? "" : status)}><i style={{ background: colors[status] }} />{status}</button>)}</div></div>
          <BarChart title="By entity" groups={analytics.entityGroups} onSelect={(value) => changeFilter("entity", value)} />
          <BarChart title="By operation" groups={analytics.operationGroups} onSelect={(value) => changeFilter("operation", value)} />
          <div className="panel phase-form"><h2>Historical pass rate</h2><p>Current history page, matching result filters.</p>{history.slice().reverse().map((run) => <button className="trend-row" key={run.id} onClick={() => setRunId(run.id)}><span>{new Date(run.createdAt).toLocaleDateString()} · {run.id.slice(0, 8)}</span><span className="trend-track"><i style={{ width: `${run.metrics.passRate}%` }} /></span><strong>{run.metrics.passRate.toFixed(1)}%</strong></button>)}</div>
        </div>
        <button className="button button-primary" onClick={() => { setAuditType("results"); setTab("audit"); }}>Explore run results</button>
      </>}
    </>}
    {tab === "audit" && <>
      <div className="phase-tabs"><button className={auditType === "results" ? "selected" : ""} onClick={() => { setAuditType("results"); setPage(1); }}>Test results</button><button className={auditType === "records" ? "selected" : ""} onClick={() => { setAuditType("records"); setPage(1); }}>Synthetic records</button></div>
      {auditType === "records" && <p className="analytics-note">Synthetic records use dataset, entity, and search filters; the other filters apply to run results.</p>}
      <div className="panel table-wrap"><table><thead><tr>{(auditType === "results" ? ["Case", "Entity / operation", "Status", "Record", "PBI"] : ["Record", "Entity", "Customer / business ID", "Scenario", "Dataset"]).map((label) => <th key={label}>{label}</th>)}</tr></thead><tbody>
        {auditType === "results" ? results.map((result) => <tr key={result.id} onClick={() => void perform(async () => { setDetail(await request<Detail>(`/api/analytics/results/${encodeURIComponent(result.id)}`)); setRecordDetail(null); })}><td><button className="text-button">{result.caseName}</button></td><td>{result.entity} / {result.operation}</td><td>{result.status}</td><td>{result.inputRecordId}</td><td>{result.pbi ?? "—"}</td></tr>) :
          records.map((record) => <tr key={`${record.datasetId}:${record.recordId}`} onClick={() => { setRecordDetail(record); setDetail(null); }}><td><button className="text-button">{record.recordId}</button></td><td>{record.entity}</td><td>{record.businessId ?? "—"}</td><td>{record.scenarioId}</td><td>{record.datasetId}</td></tr>)}
      </tbody></table>{total === 0 && <div className="empty-state"><strong>No matching records</strong></div>}</div>
      <div className="analytics-pagination"><button disabled={page === 1} onClick={() => setPage(page - 1)}>Previous</button><span>Page {page} · {total} results</span><button disabled={page * 20 >= total} onClick={() => setPage(page + 1)}>Next</button></div>
      {detail && <div className="panel phase-form"><h2>Request / response evidence · {detail.result.caseName}</h2><p>{detail.result.status} · {detail.result.scenarioId} · {detail.result.durationMs} ms · {new Date(detail.result.startedAt).toLocaleString()}</p><a href={`/api/test-runs/${encodeURIComponent(detail.result.runId)}/log`}>Download run JSONL</a><a href={`/api/datasets/${encodeURIComponent(detail.datasetId)}/export/combined`}>Export dataset JSON</a><h3>Source record and execution input</h3><pre>{JSON.stringify({ source: detail.source, input: detail.input }, null, 2)}</pre>{detail.result.steps.map((step) => <div key={step.id}><h3>{step.name} · {step.method} {step.url}</h3><p>Expected {detail.expectedStatuses[step.stepId]?.join(", ")} · actual {step.responseStatus ?? "no response"} · {step.latencyMs ?? "—"} ms · {new Date(step.createdAt).toLocaleString()} · correlation {step.correlationId}</p><pre>{JSON.stringify({ request: step.requestBody, response: step.responseBody, assertions: step.assertions, error: step.error }, null, 2)}</pre></div>)}</div>}
      {recordDetail && <div className="panel phase-form"><h2>Synthetic record · {recordDetail.recordId}</h2><a href={`/api/datasets/${encodeURIComponent(recordDetail.datasetId)}/export/combined`}>Export dataset JSON</a><pre>{JSON.stringify(recordDetail, null, 2)}</pre></div>}
    </>}
    {tab === "policies" && <>
      <div className="panel phase-form"><h2>Simulate merge regression</h2><p>Global local sandbox setting. Changing it is blocked while any run is active. The merge API will stop reparenting addresses until disabled.</p><button className="button button-secondary" onClick={() => void perform(async () => { await request("/api/demo/regression", { method: "POST", body: JSON.stringify({ enabled: !regression }) }); })}>{regression ? "Disable regression" : "Enable regression"} · {regression ? "ON" : "OFF"}</button></div>
      <form className="panel phase-form" onSubmit={(event) => { event.preventDefault(); void perform(async () => {
        await request(selectedPolicy ? `/api/release-policies/${encodeURIComponent(selectedPolicy)}` : "/api/release-policies", { method: selectedPolicy ? "PUT" : "POST", body: JSON.stringify(policyForm) });
      }); }}><h2>Versioned release policy</h2><label>Policy<select value={selectedPolicy} onChange={(event) => selectPolicy(event.target.value)}><option value="">Create new policy</option>{policies.map((policy) => <option key={policy.id} value={policy.id}>{policy.name} · {policy.environment} · v{policy.version}</option>)}</select></label>
        <label>Name<input required value={policyForm.name} onChange={(event) => setPolicyForm({ ...policyForm, name: event.target.value })} /></label>
        <label>Environment<select disabled={Boolean(selectedPolicy)} value={policyForm.environment} onChange={(event) => setPolicyForm({ ...policyForm, environment: event.target.value as ReleasePolicyInput["environment"] })}>{["DEMO", "DEV", "QA", "UAT"].map((item) => <option key={item}>{item}</option>)}</select></label>
        {(["passThreshold", "minimumCoverage", "maxCriticalFailures"] as const).map((field) => <label key={field}>{field}<input type="number" min="0" max={field === "maxCriticalFailures" ? undefined : 100} step={field === "maxCriticalFailures" ? 1 : "any"} value={policyForm[field]} onChange={(event) => setPolicyForm({ ...policyForm, [field]: Number(event.target.value) })} /></label>)}
        <label className="analytics-check"><input type="checkbox" checked={policyForm.allowErrors} onChange={(event) => setPolicyForm({ ...policyForm, allowErrors: event.target.checked })} />Allow errors</label><label className="analytics-check"><input type="checkbox" checked={policyForm.allowBlocked} onChange={(event) => setPolicyForm({ ...policyForm, allowBlocked: event.target.checked })} />Allow blocked</label>
        <p>Any critical non-PASS result blocks promotion regardless of the configured maximum.</p><button className="button button-primary" type="submit">{selectedPolicy ? "Save new version" : "Create policy"}</button></form>
      <div className="panel phase-form"><h2>Local defect candidates</h2><a href="/api/defects/export">Export defect candidates as JSON</a>{defects.length === 0 && <p>No defect candidates yet.</p>}{defects.map((defect) => <details key={defect.id}><summary>{defect.title} · {defect.severity} · {defect.occurrences.length} occurrence(s)</summary><pre>{JSON.stringify(defect, null, 2)}</pre></details>)}</div>
    </>}
  </div>;
}

function BarChart({ title, groups, onSelect }: { title: string; groups: Group[]; onSelect: (value: string) => void }) {
  const maximum = Math.max(1, ...groups.map((group) => Object.values(group.counts).reduce((sum, count) => sum + count, 0)));
  return <div className="panel phase-form"><h2>{title}</h2>{groups.length === 0 && <p>No matching results.</p>}{groups.map((group) => <button key={group.name} className="group-row" onClick={() => onSelect(group.name)}><span>{group.name}</span><span className="group-track">{statuses.map((status) => <i key={status} title={`${status}: ${group.counts[status] ?? 0}`} style={{ background: colors[status], width: `${(group.counts[status] ?? 0) / maximum * 100}%` }} />)}</span><strong>{Object.values(group.counts).reduce((sum, count) => sum + count, 0)}</strong></button>)}</div>;
}
