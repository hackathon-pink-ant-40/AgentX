import { useCallback, useEffect, useState } from "react";
import PhaseTwoPage from "./PhaseTwoPage";
import PhaseThreePage from "./PhaseThreePage";
import PhaseFourPage from "./PhaseFourPage";
import type {
  Address,
  AddressResponse,
  AddressListResponse,
  ApiError,
  Customer,
  CustomerResponse,
  CustomerListResponse,
  CreateAddressRequest,
  CreateCustomerRequest,
  HealthResponse,
  MergeCustomersRequest,
  MergeCustomersResponse,
  PatchCustomerRequest,
} from "@agentx/shared";

type Page = "overview" | "mock-api" | "models" | "synthetic-data" | "test-configuration" | "test-execution" | "dashboard" | "audit" | "policies";

const apiBase = "/api/mock-api";

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const body = await response.json() as ApiError;
    throw new Error(body.error?.message ?? `Request failed with status ${response.status}`);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return response.json() as Promise<T>;
}

function App() {
  const [page, setPage] = useState<Page>("overview");
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const fetchWorkspace = useCallback(async () => {
    const [healthResponse, customerResponse] = await Promise.all([
      apiRequest<HealthResponse>("/api/health"),
      apiRequest<CustomerListResponse>(`${apiBase}/customers`),
    ]);
    setHealth(healthResponse);
    setCustomers(customerResponse.customers);
  }, []);

  async function loadCustomer(customerId: string): Promise<void> {
    const encodedId = encodeURIComponent(customerId.trim());
    const [customerResponse, addressResponse] = await Promise.all([
      apiRequest<CustomerResponse>(`${apiBase}/customers/${encodedId}`),
      apiRequest<AddressListResponse>(`${apiBase}/customers/${encodedId}/addresses`),
    ]);
    setSelectedCustomer(customerResponse.customer);
    setAddresses(addressResponse.addresses);
  }

  const refresh = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      await fetchWorkspace();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to reach the local API");
    } finally {
      setBusy(false);
    }
  }, [fetchWorkspace]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function perform(action: () => Promise<void>, successMessage: string): Promise<void> {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      await fetchWorkspace();
      setNotice(successMessage);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "The request failed");
    } finally {
      setBusy(false);
    }
  }

  async function inspectCustomer(customerId: string): Promise<void> {
    if (!customerId.trim()) {
      setError("Enter a customer ID before looking up a record.");
      return;
    }
    await perform(async () => {
      await loadCustomer(customerId);
    }, "Customer and related addresses loaded.");
  }

  async function createCustomer(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const input: CreateCustomerRequest = {
      customerId: String(form.get("customerId") ?? "").trim(),
      firstName: String(form.get("firstName") ?? "").trim(),
      lastName: String(form.get("lastName") ?? "").trim(),
      email: String(form.get("email") ?? "").trim() || undefined,
    };
    await perform(async () => {
      const response = await apiRequest<CustomerResponse>(`${apiBase}/customers`, {
        method: "POST",
        body: JSON.stringify(input),
      });
      setSelectedCustomer(response.customer);
      setAddresses([]);
      formElement.reset();
    }, `Customer ${input.customerId} created in the sandbox.`);
  }

  async function createAddress(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const input: CreateAddressRequest = {
      customerId: String(form.get("customerId") ?? "").trim(),
      street: String(form.get("street") ?? "").trim(),
      postalCode: String(form.get("postalCode") ?? "").trim(),
      country: String(form.get("country") ?? "").trim().toUpperCase(),
    };
    await perform(async () => {
      await apiRequest<AddressResponse>(`${apiBase}/addresses`, {
        method: "POST",
        body: JSON.stringify(input),
      });
      await loadCustomer(input.customerId);
      formElement.reset();
    }, `Address linked to ${input.customerId}.`);
  }

  async function updateCustomer(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!selectedCustomer) {
      setError("Look up a customer before editing it.");
      return;
    }
    const form = new FormData(event.currentTarget);
    const input: PatchCustomerRequest = {
      firstName: String(form.get("firstName") ?? "").trim(),
      lastName: String(form.get("lastName") ?? "").trim(),
    };
    await perform(async () => {
      const response = await apiRequest<CustomerResponse>(
        `${apiBase}/customers/${encodeURIComponent(selectedCustomer.customerId)}`,
        { method: "PATCH", body: JSON.stringify(input) },
      );
      setSelectedCustomer(response.customer);
    }, `Customer ${selectedCustomer.customerId} updated.`);
  }

  async function mergeCustomers(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const input: MergeCustomersRequest = {
      survivorId: String(form.get("survivorId") ?? "").trim(),
      mergedId: String(form.get("mergedId") ?? "").trim(),
    };
    const { survivorId, mergedId } = input;
    await perform(async () => {
      await apiRequest<MergeCustomersResponse>(`${apiBase}/customers/merge`, {
        method: "POST",
        body: JSON.stringify(input),
      });
      formElement.reset();
      if (selectedCustomer?.customerId === mergedId) {
        setSelectedCustomer(null);
        setAddresses([]);
      } else if (selectedCustomer?.customerId === survivorId) {
        await loadCustomer(survivorId);
      }
    }, `Merged ${mergedId} into ${survivorId}; related addresses were reassigned.`);
  }

  async function deleteCustomer(): Promise<void> {
    if (!selectedCustomer) {
      setError("Look up a customer before deleting it.");
      return;
    }
    const customerId = selectedCustomer.customerId;
    if (!window.confirm(`Permanently delete sandbox customer ${customerId} and its addresses?`)) {
      return;
    }
    await perform(async () => {
      await apiRequest(`${apiBase}/customers/${encodeURIComponent(customerId)}`, {
        method: "DELETE",
        headers: { "x-demo-sandbox": "true" },
      });
      setSelectedCustomer(null);
      setAddresses([]);
    }, `Customer ${customerId} and its addresses were deleted.`);
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#" onClick={() => setPage("overview")} aria-label="TestAgent AI overview">
          <span className="brand-mark">T</span>
          <span><strong>TestAgent</strong><small>AI WORKBENCH</small></span>
        </a>
        <div className="sidebar-label">WORKSPACE</div>
        <nav aria-label="Main navigation">
          <button className={`nav-item ${page === "overview" ? "active" : ""}`} onClick={() => setPage("overview")}>
            <span className="nav-icon">⌂</span> Overview
          </button>
          <button className={`nav-item ${page === "mock-api" ? "active" : ""}`} onClick={() => setPage("mock-api")}>
            <span className="nav-icon">⇄</span> Mock MDM API
          </button>
          <button className={`nav-item ${page === "models" ? "active" : ""}`} onClick={() => setPage("models")}>
            <span className="nav-icon">⌘</span> Data models
          </button>
          <button className={`nav-item ${page === "synthetic-data" ? "active" : ""}`} onClick={() => setPage("synthetic-data")}>
            <span className="nav-icon">▦</span> Synthetic data
          </button>
          <button className={`nav-item ${page === "test-configuration" ? "active" : ""}`} onClick={() => setPage("test-configuration")}>
            <span className="nav-icon">⚙</span> Test configuration
          </button>
          <button className={`nav-item ${page === "test-execution" ? "active" : ""}`} onClick={() => setPage("test-execution")}>
            <span className="nav-icon">▷</span> Test execution
          </button>
          <button className={`nav-item ${page === "dashboard" ? "active" : ""}`} onClick={() => setPage("dashboard")}><span className="nav-icon">◫</span> Dashboard</button>
          <button className={`nav-item ${page === "audit" ? "active" : ""}`} onClick={() => setPage("audit")}><span className="nav-icon">⌕</span> Audit explorer</button>
          <button className={`nav-item ${page === "policies" ? "active" : ""}`} onClick={() => setPage("policies")}><span className="nav-icon">✓</span> Release policies</button>
        </nav>
        <div className="sidebar-bottom">
          <span className="sandbox-dot" /> LOCAL SANDBOX
          <p>Data stays on this machine.</p>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div className="breadcrumbs">TestAgent AI <span>/</span> {page === "overview" ? "Overview" : page === "mock-api" ? "Mock MDM API" : page === "models" ? "Data models" : page === "synthetic-data" ? "Synthetic data" : page === "test-configuration" ? "Test configuration" : page === "test-execution" ? "Test execution" : page === "dashboard" ? "Dashboard" : page === "audit" ? "Audit explorer" : "Release policies"}</div>
          <div className="topbar-right">
            <span className="demo-badge"><span /> DEMO / SANDBOX</span>
            <span className="avatar">B</span>
          </div>
        </header>

        <div className="page-content">
          {error && <div className="alert alert-error" role="alert"><strong>Request error</strong><span>{error}</span><button onClick={() => setError("")}>×</button></div>}
          {notice && <div className="alert alert-success" role="status"><strong>Done</strong><span>{notice}</span><button onClick={() => setNotice("")}>×</button></div>}
          {page === "overview" ? (
            <Overview health={health} busy={busy} onOpenApi={() => setPage("mock-api")} onOpenModels={() => setPage("models")} onOpenTests={() => setPage("test-execution")} onRefresh={() => void refresh()} />
          ) : page === "mock-api" ? (
            <MockApiPage
              customers={customers}
              selectedCustomer={selectedCustomer}
              addresses={addresses}
              busy={busy}
              onCreateCustomer={createCustomer}
              onCreateAddress={createAddress}
              onInspect={(id) => void inspectCustomer(id)}
              onUpdate={updateCustomer}
              onMerge={mergeCustomers}
              onDelete={() => void deleteCustomer()}
            />
          ) : page === "models" || page === "synthetic-data" ? (
            <PhaseTwoPage key={page} initialTab={page === "synthetic-data" ? "data" : "models"} />
          ) : page === "dashboard" || page === "audit" || page === "policies" ? (
            <PhaseFourPage key={page} initialTab={page} />
          ) : (
            <PhaseThreePage key={page} initialTab={page === "test-execution" ? "execution" : "configuration"} />
          )}
        </div>
      </main>
    </div>
  );
}

function Overview({
  health,
  busy,
  onOpenApi,
  onOpenModels,
  onOpenTests,
  onRefresh,
}: {
  health: HealthResponse | null;
  busy: boolean;
  onOpenApi: () => void;
  onOpenModels: () => void;
  onOpenTests: () => void;
  onRefresh: () => void;
}) {
  return (
    <>
      <section className="page-heading">
        <div>
          <div className="eyebrow">YOUR QUALITY ENGINEERING WORKSPACE</div>
          <h1>Your quality workspace <span className="wave">✦</span></h1>
          <p>A local-first workbench for synthetic data and API quality.</p>
        </div>
        <button className="button button-secondary" onClick={onRefresh} disabled={busy}>
          <span className={busy ? "spin" : ""}>↻</span> Refresh status
        </button>
      </section>

      <section className="hero-card">
        <div className="hero-copy">
          <div className="hero-pill"><span /> PHASE 3 · API TEST EXECUTION</div>
          <h2>Design, execute, and inspect API tests.</h2>
          <p>Version test suites, exercise the local Customer MDM service over HTTP, and inspect persisted results and redacted JSONL evidence.</p>
          <div className="hero-actions"><button className="button button-light" onClick={onOpenTests}>Open Test Workbench <span>→</span></button><button className="button button-hero-secondary" onClick={onOpenModels}>Synthetic data</button></div>
        </div>
        <div className="hero-art" aria-hidden="true">
          <div className="orbit orbit-one" /><div className="orbit orbit-two" />
          <div className="art-node node-main">API</div><div className="art-node node-db">DB</div><div className="art-node node-check">✓</div>
          <div className="art-line line-one" /><div className="art-line line-two" />
        </div>
      </section>

      <section className="section-heading">
        <div><h2>System health</h2><p>Live status from the running backend and local database.</p></div>
      </section>
      <section className="stat-grid">
        <StatCard label="API SERVICE" value={health ? "Online" : "—"} icon="↗" tone={health ? "green" : "gray"} detail={health ? "Express · loopback API" : "Waiting for backend"} />
        <StatCard label="DATABASE" value={health ? "Connected" : "—"} icon="▤" tone={health ? "blue" : "gray"} detail={health ? "SQLite · local storage" : "No database connection"} />
        <StatCard label="CUSTOMERS" value={health ? String(health.counts.customers) : "—"} icon="♙" tone="violet" detail="Persisted sandbox records" />
        <StatCard label="ADDRESSES" value={health ? String(health.counts.addresses) : "—"} icon="⌖" tone="amber" detail="Linked to customers" />
      </section>

      <section className="section-heading section-heading-spaced">
        <div><h2>Foundation services</h2><p>Operational components available in this phase.</p></div>
      </section>
      <section className="service-list">
        <div className="service-row">
          <div className="service-icon icon-blue">⇄</div><div className="service-copy"><strong>Customer MDM sandbox</strong><span>CRUD, merge, address linking and sandbox-safe delete</span></div>
          <span className="service-status"><i /> {health ? "Operational" : "Connecting"}</span><button className="text-button" onClick={onOpenApi}>Open API <b>→</b></button>
        </div>
        <div className="service-row">
          <div className="service-icon icon-violet">⌘</div><div className="service-copy"><strong>Shared API contracts</strong><span>Typed request and response models shared by web and API workspaces</span></div>
          <span className="service-status"><i /> Built</span><span className="service-note">Phase 1</span>
        </div>
        <div className="service-row">
          <div className="service-icon icon-blue">▦</div><div className="service-copy"><strong>Synthetic data workbench</strong><span>Versioned models, configurable profiles, preview, datasets and exports</span></div>
          <span className="service-status"><i /> Operational</span><button className="text-button" onClick={onOpenModels}>Open models <b>→</b></button>
        </div>
        <div className="service-row">
          <div className="service-icon icon-violet">✓</div><div className="service-copy"><strong>API test execution</strong><span>Versioned suites, dependency-aware runs, live progress and persisted evidence</span></div>
          <span className="service-status"><i /> Operational</span><button className="text-button" onClick={onOpenTests}>Open tests <b>→</b></button>
        </div>
      </section>
      <footer className="page-footer"><span>TestAgent AI <span className="footer-dot">·</span> Local development build</span><span>Phase 3 of 5</span></footer>
    </>
  );
}

function StatCard({ label, value, icon, tone, detail }: { label: string; value: string; icon: string; tone: string; detail: string }) {
  return (
    <article className="stat-card">
      <div className="stat-top"><span>{label}</span><span className={`stat-icon ${tone}`}>{icon}</span></div>
      <strong className="stat-value">{value}</strong><span className="stat-detail">{detail}</span>
    </article>
  );
}

function MockApiPage({
  customers,
  selectedCustomer,
  addresses,
  busy,
  onCreateCustomer,
  onCreateAddress,
  onInspect,
  onUpdate,
  onMerge,
  onDelete,
}: {
  customers: Customer[];
  selectedCustomer: Customer | null;
  addresses: Address[];
  busy: boolean;
  onCreateCustomer: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
  onCreateAddress: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
  onInspect: (id: string) => void;
  onUpdate: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
  onMerge: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
  onDelete: () => void;
}) {
  const [lookupId, setLookupId] = useState("");

  return (
    <>
      <section className="page-heading">
        <div><div className="eyebrow">STATEFUL REST SERVICE</div><h1>Mock Customer MDM API</h1><p>Exercise real HTTP operations against the local SQLite-backed sandbox.</p></div>
        <span className="connection-chip"><i /> API ready · localhost</span>
      </section>

      <div className="api-info">
        <div className="api-info-icon">i</div>
        <div><strong>Sandbox-only service</strong><p>All requests stay on this machine. Customer deletion requires an explicit sandbox confirmation header.</p></div>
        <code>127.0.0.1:3001/api/mock-api</code>
      </div>

      <div className="api-layout">
        <section className="panel records-panel">
          <div className="panel-header"><div><h2>Customers</h2><p>{customers.length} persisted record{customers.length === 1 ? "" : "s"} · max 100 shown</p></div><span className="live-tag"><i /> LIVE</span></div>
          <div className="lookup-row">
            <label className="sr-only" htmlFor="lookup-id">Customer ID</label>
            <input id="lookup-id" value={lookupId} onChange={(event) => setLookupId(event.target.value)} placeholder="Look up by customer ID" />
            <button className="button button-dark" onClick={() => onInspect(lookupId)} disabled={busy}>Inspect</button>
          </div>
          {customers.length === 0 ? (
            <div className="empty-state"><div className="empty-icon">♙</div><strong>No customers yet</strong><span>Create your first sandbox record using the form.</span></div>
          ) : (
            <div className="table-wrap">
              <table><thead><tr><th>CUSTOMER</th><th>EMAIL</th><th>STATUS</th></tr></thead>
                <tbody>{customers.map((customer) => (
                  <tr key={customer.customerId} className={selectedCustomer?.customerId === customer.customerId ? "selected-row" : ""} onClick={() => { setLookupId(customer.customerId); onInspect(customer.customerId); }}>
                    <td><span className="customer-avatar">{customer.firstName.charAt(0)}{customer.lastName.charAt(0)}</span><span className="customer-name"><strong>{customer.firstName} {customer.lastName}</strong><small>{customer.customerId}{customer.mergedInto ? ` · merged into ${customer.mergedInto}` : ""}</small></span></td>
                    <td>{customer.email ?? <span className="muted">—</span>}</td><td><span className={`status-tag ${customer.mergedInto ? "merged" : "active"}`}>{customer.mergedInto ? "MERGED" : customer.status}</span></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
          {selectedCustomer && <div className="selected-detail">
            <div className="detail-heading"><div><span className="eyebrow">SELECTED CUSTOMER</span><h3>{selectedCustomer.firstName} {selectedCustomer.lastName}</h3></div><button className="button button-danger-outline" onClick={onDelete} disabled={busy || Boolean(selectedCustomer.mergedInto)}>Delete sandbox record</button></div>
            <p className="detail-id">{selectedCustomer.customerId} · {selectedCustomer.email ?? "No email address"} · {selectedCustomer.status}</p>
            <strong className="subsection-title">Linked addresses ({addresses.length})</strong>
            {addresses.length === 0 ? <p className="muted">No addresses linked to this customer.</p> : addresses.map((address) => <div className="address-row" key={address.addressId}><span>⌖</span>{address.street}, {address.postalCode}, {address.country}<small>{address.addressId}</small></div>)}
            {!selectedCustomer.mergedInto && <form key={selectedCustomer.customerId} className="inline-edit" onSubmit={(event) => void onUpdate(event)}>
              <label>First name<input name="firstName" required defaultValue={selectedCustomer.firstName} /></label>
              <label>Last name<input name="lastName" required defaultValue={selectedCustomer.lastName} /></label>
              <button className="button button-secondary" disabled={busy}>Save changes</button>
            </form>}
          </div>}
        </section>

        <div className="forms-column">
          <section className="panel form-panel">
            <div className="panel-header"><div><h2>Create customer</h2><p>POST /customers</p></div><span className="method-tag method-post">POST</span></div>
            <form onSubmit={(event) => void onCreateCustomer(event)} className="form-grid">
              <label>Customer ID<input name="customerId" required maxLength={200} placeholder="e.g. cust-1001" /></label>
              <div className="two-fields"><label>First name<input name="firstName" required maxLength={200} placeholder="First name" /></label><label>Last name<input name="lastName" required maxLength={200} placeholder="Last name" /></label></div>
              <label>Email <span className="optional">(optional)</span><input name="email" type="email" maxLength={320} placeholder="name@example.test" /></label>
              <button className="button button-primary" disabled={busy}>Create customer <span>→</span></button>
            </form>
          </section>

          <section className="panel form-panel">
            <div className="panel-header"><div><h2>Link an address</h2><p>POST /addresses</p></div><span className="method-tag method-post">POST</span></div>
            <form key={selectedCustomer?.customerId ?? "new-address"} onSubmit={(event) => void onCreateAddress(event)} className="form-grid">
              <label>Customer ID<input name="customerId" required placeholder="Existing customer ID" defaultValue={selectedCustomer?.customerId ?? ""} /></label>
              <label>Street address<input name="street" required placeholder="12 Sample Street" /></label>
              <div className="two-fields"><label>Postal code<input name="postalCode" required placeholder="1234 AB" /></label><label>Country code<input name="country" required minLength={2} maxLength={2} placeholder="NL" /></label></div>
              <button className="button button-secondary" disabled={busy}>Add address <span>→</span></button>
            </form>
          </section>

          <section className="panel form-panel">
            <div className="panel-header"><div><h2>Merge customers</h2><p>POST /customers/merge · addresses are reparented</p></div><span className="method-tag method-post">POST</span></div>
            <form onSubmit={(event) => void onMerge(event)} className="form-grid">
              <div className="two-fields"><label>Survivor ID<input name="survivorId" required placeholder="Keep this record" /></label><label>Merge ID<input name="mergedId" required placeholder="Mark as merged" /></label></div>
              <button className="button button-secondary" disabled={busy}>Merge records <span>→</span></button>
            </form>
          </section>
        </div>
      </div>
      <footer className="page-footer"><span>Data persisted in local SQLite <span className="footer-dot">·</span> No external target connections</span><span>Customer MDM sandbox</span></footer>
    </>
  );
}

export default App;
