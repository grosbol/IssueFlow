import { useEffect, useRef, useState } from "react";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

function apiFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const token = localStorage.getItem("authToken");
  return fetch(`${API_URL}${path}`, {
    ...options,
    headers: { ...options.headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
}

type Workflow = { id: number; name: string };
type Status   = { id: number; name: string; color: string; sortOrder: number };
type Trans    = { fromStatusId: number; toStatusId: number };
type WFData   = { workflow: Workflow; statuses: Status[]; transitions: Trans[] };
type Pos      = { x: number; y: number };
type Mode     = "select" | "connect";

const NW = 148, NH = 50;

function layoutPositions(statuses: Status[]): Record<number, Pos> {
  const sorted = [...statuses].sort((a, b) => a.sortOrder - b.sortOrder);
  const cols = Math.min(4, Math.max(1, Math.ceil(sorted.length / 2)));
  const out: Record<number, Pos> = {};
  sorted.forEach((s, i) => {
    out[s.id] = { x: 80 + (i % cols) * 210, y: 80 + Math.floor(i / cols) * 170 };
  });
  return out;
}

function buildArrow(fromPos: Pos, toPos: Pos, flip: boolean): string {
  const fx = fromPos.x + NW / 2, fy = fromPos.y + NH / 2;
  const tx = toPos.x  + NW / 2, ty = toPos.y  + NH / 2;
  const dx = tx - fx, dy = ty - fy;
  const dist = Math.hypot(dx, dy) || 1;
  const nx = dx / dist, ny = dy / dist;
  const sx = fx + nx * (NW / 2 + 2), sy = fy + ny * (NH / 2 + 2);
  const ex = tx - nx * (NW / 2 + 9), ey = ty - ny * (NH / 2 + 9);
  const mx = (sx + ex) / 2, my = (sy + ey) / 2;
  const curve = Math.min(55, dist * 0.3);
  const sign = flip ? -1 : 1;
  const cx = mx + (-ny) * curve * sign;
  const cy = my + (nx)  * curve * sign;
  return `M ${sx.toFixed(1)} ${sy.toFixed(1)} Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${ex.toFixed(1)} ${ey.toFixed(1)}`;
}

export default function WorkflowPage() {
  const [workflows, setWorkflows]     = useState<Workflow[]>([]);
  const [activeId,  setActiveId]      = useState<number | null>(null);
  const [data,      setData]          = useState<WFData | null>(null);
  const [positions, setPositions]     = useState<Record<number, Pos>>({});
  const [mode,      setMode]          = useState<Mode>("select");
  const [selected,  setSelected]      = useState<number | null>(null);
  const [connectFrom, setConnectFrom] = useState<number | null>(null);
  const [error,     setError]         = useState("");

  // forms
  const [newName,   setNewName]   = useState("");
  const [newColor,  setNewColor]  = useState("#64748b");
  const [editName,  setEditName]  = useState("");
  const [editColor, setEditColor] = useState("#64748b");
  const [newWfName, setNewWfName] = useState("");
  const [showNewWf, setShowNewWf] = useState(false);

  const dragging = useRef<{ id: number; sm: Pos; sn: Pos } | null>(null);
  const svgRef   = useRef<SVGSVGElement>(null);

  async function loadWorkflows() {
    const r = await apiFetch(`/api/workflows`);
    const list: Workflow[] = await r.json();
    setWorkflows(list);
    if (list.length && activeId === null) setActiveId(list[0].id);
  }

  async function loadData(id: number) {
    const r = await apiFetch(`/api/workflows/${id}`);
    const d: WFData = await r.json();
    setData(d);
    setPositions(prev => {
      const next = layoutPositions(d.statuses);
      // preserve existing positions for nodes we already placed
      d.statuses.forEach(s => { if (prev[s.id]) next[s.id] = prev[s.id]; });
      return next;
    });
  }

  useEffect(() => { void loadWorkflows(); }, []);
  useEffect(() => { if (activeId !== null) void loadData(activeId); }, [activeId]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") setConnectFrom(null); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  useEffect(() => {
    if (!selected || !data) return;
    const s = data.statuses.find(s => s.id === selected);
    if (s) { setEditName(s.name); setEditColor(s.color); }
  }, [selected, data]);

  function svgPt(e: React.MouseEvent): Pos {
    const svg = svgRef.current!;
    const pt  = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const { x, y } = pt.matrixTransform(svg.getScreenCTM()!.inverse());
    return { x, y };
  }

  function onNodeDown(e: React.MouseEvent, id: number) {
    e.stopPropagation();
    if (mode === "connect") {
      if (connectFrom === null) { setConnectFrom(id); return; }
      if (connectFrom === id)   { setConnectFrom(null); return; }
      void doAddTransition(connectFrom, id);
      setConnectFrom(null);
      return;
    }
    setSelected(id);
    dragging.current = { id, sm: svgPt(e), sn: { ...positions[id] } };
  }

  function onSvgMove(e: React.MouseEvent) {
    if (!dragging.current) return;
    const { id, sm, sn } = dragging.current;
    const cur = svgPt(e);
    setPositions(p => ({ ...p, [id]: { x: sn.x + cur.x - sm.x, y: sn.y + cur.y - sm.y } }));
  }

  function onSvgUp() { dragging.current = null; }

  function onSvgClick(e: React.MouseEvent) {
    if ((e.target as Element).tagName === "svg") {
      setSelected(null);
      if (mode === "connect") setConnectFrom(null);
    }
  }

  async function doAddStatus(e: React.FormEvent) {
    e.preventDefault();
    if (!activeId) return;
    setError("");
    const sortOrder = (data?.statuses.length ?? 0) + 1;
    const r = await apiFetch(`/api/workflows/${activeId}/statuses`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName, color: newColor, sortOrder }),
    });
    if (!r.ok) { setError((await r.json()).error); return; }
    setNewName(""); setNewColor("#64748b");
    await loadData(activeId);
  }

  async function doSaveStatus(e: React.FormEvent) {
    e.preventDefault();
    if (!selected || !activeId) return;
    setError("");
    await apiFetch(`/api/statuses/${selected}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: editName, color: editColor }),
    });
    await loadData(activeId);
  }

  async function doDeleteStatus(id: number) {
    if (!activeId) return;
    setError("");
    const r = await apiFetch(`/api/statuses/${id}`, { method: "DELETE" });
    if (!r.ok) { setError((await r.json()).error); return; }
    setSelected(null);
    await loadData(activeId);
  }

  async function doAddTransition(fromId: number, toId: number) {
    if (!activeId) return;
    await apiFetch(`/api/workflows/${activeId}/transitions`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fromStatusId: fromId, toStatusId: toId }),
    });
    await loadData(activeId);
  }

  async function doRemoveTransition(fromId: number, toId: number) {
    if (!activeId) return;
    await apiFetch(`/api/workflows/${activeId}/transitions`, {
      method: "DELETE", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fromStatusId: fromId, toStatusId: toId }),
    });
    await loadData(activeId);
  }

  async function doCreateWorkflow(e: React.FormEvent) {
    e.preventDefault();
    const r = await apiFetch(`/api/workflows`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newWfName }),
    });
    const wf = await r.json();
    setNewWfName(""); setShowNewWf(false);
    await loadWorkflows();
    setActiveId(wf.id);
  }

  const transSet = new Set(data?.transitions.map(t => `${t.fromStatusId}-${t.toStatusId}`) ?? []);
  const selectedStatus = data?.statuses.find(s => s.id === selected);
  const fromSelected   = data?.transitions.filter(t => t.fromStatusId === selected) ?? [];

  const allX = Object.values(positions).map(p => p.x + NW + 60);
  const allY = Object.values(positions).map(p => p.y + NH + 60);
  const canvasW = Math.max(800, ...(allX.length ? allX : [800]));
  const canvasH = Math.max(480, ...(allY.length ? allY : [480]));

  return (
    <div className="wf-page">
      {/* Top bar */}
      <div className="wf-topbar">
        <div className="wf-topbar-left">
          <select
            className="wf-selector"
            value={activeId ?? ""}
            onChange={e => { setActiveId(Number(e.target.value)); setSelected(null); }}
          >
            {workflows.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
          <button className="btn-ghost" onClick={() => setShowNewWf(v => !v)}>+ New workflow</button>
          {showNewWf && (
            <form onSubmit={doCreateWorkflow} className="wf-inline-form">
              <input value={newWfName} onChange={e => setNewWfName(e.target.value)} placeholder="Workflow name" required autoFocus />
              <button className="btn-primary" type="submit">Create</button>
              <button className="btn-ghost" type="button" onClick={() => setShowNewWf(false)}>Cancel</button>
            </form>
          )}
        </div>
        <div className="wf-mode-group">
          <button
            className={`wf-mode-btn ${mode === "select" ? "active" : ""}`}
            onClick={() => { setMode("select"); setConnectFrom(null); }}
          >↖ Select</button>
          <button
            className={`wf-mode-btn ${mode === "connect" ? "active" : ""}`}
            onClick={() => { setMode("connect"); setSelected(null); }}
          >⇢ Connect</button>
        </div>
      </div>

      {connectFrom && (
        <div className="wf-hint">
          Source: <strong>{data?.statuses.find(s => s.id === connectFrom)?.name}</strong>
          &nbsp;— click a target status to create a transition &nbsp;·&nbsp;
          <button className="wf-hint-cancel" onClick={() => setConnectFrom(null)}>Cancel (Esc)</button>
        </div>
      )}

      {error && <p className="form-error" style={{ padding: "0 0 8px 0" }}>{error}</p>}

      <div className="wf-body">
        {/* Canvas */}
        <div className="wf-canvas-wrap">
          <svg
            ref={svgRef}
            width={canvasW}
            height={canvasH}
            className={`wf-canvas mode-${mode}${connectFrom ? " has-source" : ""}`}
            onMouseMove={onSvgMove}
            onMouseUp={onSvgUp}
            onMouseLeave={onSvgUp}
            onClick={onSvgClick}
          >
            <defs>
              <marker id="wf-arrow" markerWidth="9" markerHeight="9" refX="7" refY="3.5" orient="auto">
                <path d="M0,0 L0,7 L9,3.5 z" fill="var(--color-accent)" />
              </marker>
              <marker id="wf-arrow-del" markerWidth="9" markerHeight="9" refX="7" refY="3.5" orient="auto">
                <path d="M0,0 L0,7 L9,3.5 z" fill="#f87171" />
              </marker>
              <pattern id="wf-dots" x="0" y="0" width="28" height="28" patternUnits="userSpaceOnUse">
                <circle cx="1.5" cy="1.5" r="1.5" fill="var(--color-border-faint)" />
              </pattern>
            </defs>

            <rect width={canvasW} height={canvasH} fill="url(#wf-dots)" />

            {/* Transitions */}
            {data?.transitions.map(t => {
              const fp = positions[t.fromStatusId];
              const tp = positions[t.toStatusId];
              if (!fp || !tp) return null;
              const hasRev = transSet.has(`${t.toStatusId}-${t.fromStatusId}`);
              const flip   = hasRev && t.fromStatusId > t.toStatusId;
              const d = buildArrow(fp, tp, flip);
              return (
                <g key={`${t.fromStatusId}-${t.toStatusId}`} className="wf-trans-group">
                  <path d={d} stroke="transparent" strokeWidth="18" fill="none"
                    style={{ cursor: "pointer" }}
                    onClick={e => { e.stopPropagation(); void doRemoveTransition(t.fromStatusId, t.toStatusId); }} />
                  <path d={d} className="wf-arrow" stroke="var(--color-accent)" strokeWidth="1.8"
                    fill="none" markerEnd="url(#wf-arrow)" strokeOpacity="0.65"
                    style={{ cursor: "pointer" }}
                    onClick={e => { e.stopPropagation(); void doRemoveTransition(t.fromStatusId, t.toStatusId); }} />
                </g>
              );
            })}

            {/* Nodes */}
            {data?.statuses.map(s => {
              const pos = positions[s.id] ?? { x: 0, y: 0 };
              const isSel  = selected === s.id;
              const isSrc  = connectFrom === s.id;
              return (
                <g key={s.id}
                  transform={`translate(${pos.x},${pos.y})`}
                  className={`wf-node${isSel ? " sel" : ""}${isSrc ? " src" : ""}`}
                  onMouseDown={e => onNodeDown(e, s.id)}
                  style={{ cursor: mode === "connect" ? "crosshair" : "grab" }}
                >
                  {(isSel || isSrc) && (
                    <rect x="-5" y="-5" width={NW + 10} height={NH + 10} rx="15"
                      fill="none"
                      stroke={isSrc ? "#f59e0b" : "var(--color-accent)"}
                      strokeWidth="2.5" opacity="0.7" />
                  )}
                  <rect width={NW} height={NH} rx="11"
                    fill="var(--color-surface)"
                    stroke="var(--color-border)"
                    strokeWidth="1" />
                  <rect x="0" y="0" width="5" height={NH} rx="3"
                    fill={s.color} />
                  <text
                    x={NW / 2 + 4}
                    y={NH / 2 + 5}
                    textAnchor="middle"
                    fontSize="13"
                    fontWeight="600"
                    fill="var(--color-text)"
                    style={{ userSelect: "none", pointerEvents: "none" }}
                  >{s.name}</text>
                </g>
              );
            })}
          </svg>
        </div>

        {/* Sidebar */}
        <aside className="wf-sidebar">
          {mode === "connect" && (
            <div className="wf-panel">
              <h4>Connect mode</h4>
              <p className="meta-label" style={{ lineHeight: 1.6 }}>
                Click a status to set it as the source, then click the target to create a transition.
              </p>
              <p className="meta-label" style={{ lineHeight: 1.6, marginTop: 8 }}>
                Click any arrow to delete that transition.
              </p>
            </div>
          )}

          {mode === "select" && !selected && (
            <div className="wf-panel">
              <h4>Add status</h4>
              <form onSubmit={doAddStatus} className="wf-form">
                <input
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  placeholder="Status name"
                  required
                />
                <label className="wf-color-row">
                  Color
                  <span className="wf-color-swatch" style={{ background: newColor }} />
                  <input type="color" value={newColor} onChange={e => setNewColor(e.target.value)} />
                </label>
                <button className="btn-primary" type="submit">Add status</button>
              </form>
            </div>
          )}

          {mode === "select" && selected && selectedStatus && (
            <>
              <div className="wf-panel">
                <h4>Edit status</h4>
                <form onSubmit={doSaveStatus} className="wf-form">
                  <input value={editName} onChange={e => setEditName(e.target.value)} required />
                  <label className="wf-color-row">
                    Color
                    <span className="wf-color-swatch" style={{ background: editColor }} />
                    <input type="color" value={editColor} onChange={e => setEditColor(e.target.value)} />
                  </label>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button className="btn-primary" type="submit">Save</button>
                    <button type="button" className="btn-danger"
                      onClick={() => void doDeleteStatus(selected)}>Delete</button>
                  </div>
                </form>
              </div>

              <div className="wf-panel">
                <h4>Transitions from here</h4>
                {fromSelected.length === 0
                  ? <p className="meta-label">None — use Connect mode to add transitions.</p>
                  : fromSelected.map(t => {
                    const tgt = data?.statuses.find(s => s.id === t.toStatusId);
                    return (
                      <div key={t.toStatusId} className="wf-trans-row">
                        <span className="status-dot" style={{ background: tgt?.color }} />
                        <span className="wf-trans-name">{tgt?.name ?? "?"}</span>
                        <button className="wf-trans-del" onClick={() => void doRemoveTransition(t.fromStatusId, t.toStatusId)} title="Remove">✕</button>
                      </div>
                    );
                  })
                }
              </div>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
