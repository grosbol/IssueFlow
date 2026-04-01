import { FormEvent, useEffect, useRef, useState } from "react";
import DOMPurify from "dompurify";
import UsersPage from "./UsersPage";
import LoginPage from "./LoginPage";
import RichEditor from "./RichEditor";
import WorkflowPage from "./WorkflowPage";
import ProjectsPage from "./ProjectsPage";

type ActiveUser = { id: number; name: string; email: string; role: "admin" | "user"; locale: string };

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

function apiFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const token = localStorage.getItem("authToken");
  return fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      ...options.headers,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
}

type Project = { id: number; name: string; key: string; workflowId: number; issueCount: number };
type User = { id: number; name: string; email: string };
type Status = { id: number; name: string; color: string; sortOrder: number };
type IssueCard = {
  id: number;
  title: string;
  description: string;
  priority: string;
  createdAt: string;
  statusId: number;
  assignee: null | User;
};
type Transition = { fromStatusId: number; toStatusId: number };
type BoardData = {
  project: { id: number; name: string; key: string; workflowId: number };
  statuses: Status[];
  issues: IssueCard[];
  transitions: Transition[];
};
type Attachment = {
  id: number;
  originalName: string;
  mimeType: string;
  size: number;
  createdAt: string;
  uploadedBy: null | User;
};
type IssueDetail = {
  issue: {
    id: number;
    title: string;
    description: string;
    priority: string;
    createdAt: string;
    updatedAt: string;
    projectId: number;
    status: { id: number; name: string; color: string };
    assignee: null | User;
    reporter: null | User;
  };
  comments: Array<{ id: number; content: string; createdAt: string; author: User }>;
  history: Array<{
    id: number;
    field: string;
    fromValue: string | null;
    toValue: string | null;
    createdAt: string;
    actor: null | User;
  }>;
  nextStatuses: Array<{ id: number; name: string; color: string }>;
  attachments: Attachment[];
};

const PRIORITIES = ["low", "medium", "high"] as const;

function App() {
  const [currentUser, setCurrentUser] = useState<ActiveUser | null>(null);
  const [theme, setTheme] = useState<"dark" | "light">(
    () => (localStorage.getItem("theme") === "light" ? "light" : "dark")
  );

  const [draggingId, setDraggingId] = useState<number | null>(null);
  const [dragOverStatusId, setDragOverStatusId] = useState<number | null>(null);
  const [page, setPage] = useState<"board" | "users" | "workflows" | "projects">("board");
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<number>(
    () => Number(localStorage.getItem("activeProjectId") || 1)
  );
  const [board, setBoard] = useState<BoardData | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [selectedIssueId, setSelectedIssueId] = useState<number | null>(null);
  const [detail, setDetail] = useState<IssueDetail | null>(null);
  const [newComment, setNewComment] = useState("");
  const [commentUserId, setCommentUserId] = useState<number | null>(null);

  // create form
  const [showCreate, setShowCreate] = useState(false);
  const [createTitle, setCreateTitle] = useState("");
  const [createDesc, setCreateDesc] = useState("");
  const [createPriority, setCreatePriority] = useState<"low" | "medium" | "high">("medium");
  const [createAssignee, setCreateAssignee] = useState<number | "">("");

  // edit state
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [editPriority, setEditPriority] = useState<"low" | "medium" | "high">("medium");
  const [editAssignee, setEditAssignee] = useState<number | "">("");

  function closeModal() {
    setSelectedIssueId(null);
    setDetail(null);
    setEditing(false);
  }

  function closeCreate() {
    setShowCreate(false);
    setCreateTitle("");
    setCreateDesc("");
    setCreatePriority("medium");
    setCreateAssignee("");
  }

  async function loadProjects() {
    const res = await apiFetch(`/api/projects`);
    const list: Project[] = await res.json();
    setProjects(list);
    if (list.length && !list.find((p) => p.id === activeProjectId)) {
      switchProject(list[0].id);
    }
  }

  function switchProject(id: number) {
    setActiveProjectId(id);
    localStorage.setItem("activeProjectId", String(id));
    setBoard(null);
    setSelectedIssueId(null);
    setDetail(null);
  }

  async function loadBoard() {
    const res = await apiFetch(`/api/projects/${activeProjectId}/board`);
    setBoard(await res.json());
  }

  async function loadIssue(id: number) {
    const res = await apiFetch(`/api/issues/${id}`);
    const data: IssueDetail = await res.json();
    setDetail(data);
    setEditTitle(data.issue.title);
    setEditDesc(data.issue.description);
    setEditPriority(data.issue.priority as "low" | "medium" | "high");
    setEditAssignee(data.issue.assignee?.id ?? "");
  }

  useEffect(() => { void loadProjects(); }, []);
  useEffect(() => { void loadBoard(); }, [activeProjectId]);
  useEffect(() => {
    apiFetch(`/api/users`).then((r) => r.json()).then(setUsers);
  }, []);
  useEffect(() => {
    if (selectedIssueId !== null) void loadIssue(selectedIssueId);
  }, [selectedIssueId]);

  // Close modals on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (detail) closeModal();
      else if (showCreate) closeCreate();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [detail, showCreate]);

  async function changeStatus(issueId: number, nextStatusId: number) {
    await apiFetch(`/api/issues/${issueId}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actorId: currentUser!.id, nextStatusId }),
    });
    await loadBoard();
    if (detail?.issue.id === issueId) await loadIssue(issueId);
  }

  async function handleDrop(targetStatusId: number) {
    if (draggingId === null || !board) return;
    const issue = board.issues.find((i) => i.id === draggingId);
    if (!issue || issue.statusId === targetStatusId) return;

    const allowed = board.transitions.some(
      (t) => t.fromStatusId === issue.statusId && t.toStatusId === targetStatusId
    );
    if (!allowed) return;

    await changeStatus(draggingId, targetStatusId);
    setDraggingId(null);
    setDragOverStatusId(null);
  }

  async function submitComment(e: FormEvent) {
    e.preventDefault();
    if (!detail || !newComment.trim()) return;
    await apiFetch(`/api/issues/${detail.issue.id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: commentUserId ?? currentUser!.id, content: newComment }),
    });
    setNewComment("");
    await loadIssue(detail.issue.id);
  }

  async function uploadAttachment(e: React.ChangeEvent<HTMLInputElement>) {
    if (!detail || !e.target.files?.length) return;
    const file = e.target.files[0];
    const fd = new FormData();
    fd.append("file", file);
    fd.append("uploadedBy", String(currentUser!.id));
    await apiFetch(`/api/issues/${detail.issue.id}/attachments`, { method: "POST", body: fd });
    e.target.value = "";
    await loadIssue(detail.issue.id);
  }

  async function downloadAttachment(id: number, name: string) {
    const res = await apiFetch(`/api/attachments/${id}/file`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function deleteAttachment(id: number) {
    if (!detail) return;
    await apiFetch(`/api/attachments/${id}`, { method: "DELETE" });
    await loadIssue(detail.issue.id);
  }

  function formatBytes(bytes: number) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  async function createIssue(e: FormEvent) {
    e.preventDefault();
    if (!createTitle.trim()) return;
    await apiFetch(`/api/issues`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: activeProjectId,
        title: createTitle,
        description: createDesc,
        assigneeId: createAssignee === "" ? null : createAssignee,
        reporterId: currentUser!.id,
        priority: createPriority,
      }),
    });
    closeCreate();
    await loadBoard();
  }

  async function saveEdit(e: FormEvent) {
    e.preventDefault();
    if (!detail) return;
    await apiFetch(`/api/issues/${detail.issue.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: editTitle,
        description: editDesc,
        priority: editPriority,
        assigneeId: editAssignee === "" ? null : editAssignee,
        actorId: currentUser!.id,
      }),
    });
    setEditing(false);
    await loadBoard();
    await loadIssue(detail.issue.id);
  }

  // sync theme class on root element and persist
  document.documentElement.className = theme === "light" ? "light" : "";
  localStorage.setItem("theme", theme);

  if (!currentUser) return <LoginPage onLogin={setCurrentUser} />;
  if (!board && page === "board") return <div className="shell">Loading IssueFlow...</div>;

  return (
    <div className="shell">
      <nav className="app-nav">
        <span className="app-nav-logo">
          <svg width="20" height="20" viewBox="0 0 38 38" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ display: "inline-block", verticalAlign: "middle", marginRight: 7, marginBottom: 2 }}>
            <rect width="38" height="38" rx="12" fill="var(--color-accent)" fillOpacity="0.13"/>
            <circle cx="10" cy="19" r="3.5" fill="var(--color-accent)"/>
            <circle cx="28" cy="11" r="3.5" fill="var(--color-accent)"/>
            <circle cx="28" cy="27" r="3.5" fill="var(--color-accent)"/>
            <path d="M13.5 19L24.5 11.5" stroke="var(--color-accent)" strokeWidth="1.6" strokeLinecap="round" opacity="0.65"/>
            <path d="M13.5 19L24.5 26.5" stroke="var(--color-accent)" strokeWidth="1.6" strokeLinecap="round" opacity="0.65"/>
            <path d="M24.5 11.5V26.5" stroke="var(--color-accent)" strokeWidth="1.4" strokeLinecap="round" strokeDasharray="2.5 3.5" opacity="0.35"/>
          </svg>IssueFlow
        </span>

        {projects.length > 0 && page === "board" && (
          <select
            className="project-switcher"
            value={activeProjectId}
            onChange={(e) => switchProject(Number(e.target.value))}
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name} ({p.key})</option>
            ))}
          </select>
        )}

        <div className="app-nav-tabs">
          <button className={page === "board" ? "active" : ""} onClick={() => setPage("board")}>Board</button>
          {currentUser.role === "admin" && (
            <button className={page === "users" ? "active" : ""} onClick={() => setPage("users")}>Users</button>
          )}
          {currentUser.role === "admin" && (
            <button className={page === "workflows" ? "active" : ""} onClick={() => setPage("workflows")}>Workflows</button>
          )}
          {currentUser.role === "admin" && (
            <button className={page === "projects" ? "active" : ""} onClick={() => setPage("projects")}>Projects</button>
          )}
        </div>
        <div className="nav-user">
          <button
            className="btn-ghost theme-toggle"
            onClick={() => setTheme((t) => t === "dark" ? "light" : "dark")}
            title="Toggle theme"
          >
            {theme === "dark" ? "☀ Light" : "☾ Dark"}
          </button>
          <span className="meta-label">
            Signed in as <strong>{currentUser.name}</strong>
            <span className={`role-badge role-badge--${currentUser.role}`}>{currentUser.role}</span>
          </span>
          <button className="btn-ghost" onClick={() => {
            apiFetch("/api/auth/logout", { method: "POST" });
            localStorage.removeItem("authToken");
            setCurrentUser(null);
          }}>Sign out</button>
        </div>
      </nav>

      {page === "users" && currentUser.role === "admin" && <UsersPage currentUser={currentUser} />}
      {page === "workflows" && currentUser.role === "admin" && <WorkflowPage />}
      {page === "projects" && currentUser.role === "admin" && (
        <ProjectsPage onProjectsChange={() => { void loadProjects(); }} />
      )}
      {page === "board" && board && <>
      <header className="hero">
        <div className="hero-left">
          <div className="hero-brand">
            <div className="hero-icon-wrap">
              <svg width="38" height="38" viewBox="0 0 38 38" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect width="38" height="38" rx="12" fill="var(--color-accent)" fillOpacity="0.13"/>
                <circle cx="10" cy="19" r="3.5" fill="var(--color-accent)"/>
                <circle cx="28" cy="11" r="3.5" fill="var(--color-accent)"/>
                <circle cx="28" cy="27" r="3.5" fill="var(--color-accent)"/>
                <path d="M13.5 19L24.5 11.5" stroke="var(--color-accent)" strokeWidth="1.6" strokeLinecap="round" opacity="0.65"/>
                <path d="M13.5 19L24.5 26.5" stroke="var(--color-accent)" strokeWidth="1.6" strokeLinecap="round" opacity="0.65"/>
                <path d="M24.5 11.5V26.5" stroke="var(--color-accent)" strokeWidth="1.4" strokeLinecap="round" strokeDasharray="2.5 3.5" opacity="0.35"/>
              </svg>
            </div>
            <div>
              <p className="hero-eyebrow">IssueFlow &middot; {board.project.key}</p>
              <h1 className="hero-title">{board.project.name}</h1>
            </div>
          </div>
          <p className="hero-subtitle">Simple, focused issue tracking built for your team.</p>
          <div className="hero-chips">
            <span className="hero-chip">
              <span className="hero-chip-val">{board.issues.length}</span>
              <span className="hero-chip-label">Issues</span>
            </span>
            <span className="hero-chip">
              <span className="hero-chip-val">{board.statuses.length}</span>
              <span className="hero-chip-label">Statuses</span>
            </span>
            <span className="hero-chip">
              <span className="hero-chip-val">{users.length}</span>
              <span className="hero-chip-label">Members</span>
            </span>
          </div>
        </div>
        <div className="hero-actions">
          <button className="btn-primary hero-cta" onClick={() => setShowCreate(true)}>
            + New issue
          </button>
        </div>
      </header>

      {showCreate && (
        <div className="issue-modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) closeCreate(); }}>
          <div className="issue-modal">
            <button className="issue-modal-close" onClick={closeCreate} title="Close (Esc)">✕</button>
            <form className="create-form" style={{ border: "none", padding: 0, margin: 0, background: "none", backdropFilter: "none" }} onSubmit={createIssue}>
              <h3>Create issue</h3>
              <div className="form-row">
                <label>Title
                  <input
                    required
                    autoFocus
                    value={createTitle}
                    onChange={(e) => setCreateTitle(e.target.value)}
                    placeholder="Issue title"
                  />
                </label>
              </div>
              <div className="form-row">
                <label>Description</label>
                <RichEditor value={createDesc} onChange={setCreateDesc} placeholder="Optional description" />
              </div>
              <div className="form-row two-col">
                <label>Priority
                  <select value={createPriority} onChange={(e) => setCreatePriority(e.target.value as typeof createPriority)}>
                    {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                </label>
                <label>Assignee
                  <select value={createAssignee} onChange={(e) => setCreateAssignee(e.target.value === "" ? "" : Number(e.target.value))}>
                    <option value="">Unassigned</option>
                    {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                  </select>
                </label>
              </div>
              <button className="btn-primary" type="submit">Create</button>
            </form>
          </div>
        </div>
      )}

      <main className="board-full">
        {board.statuses.map((status) => {
          const issues = board.issues.filter((i) => i.statusId === status.id);
          return (
            <div
              className={`column ${dragOverStatusId === status.id ? "drop-target" : ""}`}
              key={status.id}
              onDragOver={(e) => { e.preventDefault(); setDragOverStatusId(status.id); }}
              onDragLeave={() => setDragOverStatusId(null)}
              onDrop={() => void handleDrop(status.id)}
            >
              <div className="column-header">
                <span className="status-dot" style={{ background: status.color }} />
                <h2>{status.name}</h2>
                <span>{issues.length}</span>
              </div>
              <div className="cards">
                {issues.map((issue) => (
                  <button
                    type="button"
                    draggable
                    className={`card ${selectedIssueId === issue.id ? "active" : ""} ${draggingId === issue.id ? "dragging" : ""}`}
                    key={issue.id}
                    onClick={() => { setSelectedIssueId(issue.id); setEditing(false); }}
                    onDragStart={() => setDraggingId(issue.id)}
                    onDragEnd={() => { setDraggingId(null); setDragOverStatusId(null); }}
                  >
                    <div className="card-top">
                      <span className={`pill ${issue.priority}`}>{issue.priority}</span>
                      <span className="issue-key">{board.project.key}-{issue.id}</span>
                    </div>
                    <strong>{issue.title}</strong>
                    {issue.description && <p className="card-desc">{issue.description.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim()}</p>}
                    <div className="card-bottom">
                      <span>{issue.assignee?.name ?? "Unassigned"}</span>
                      <span>{new Date(issue.createdAt).toLocaleDateString(currentUser.locale)}</span>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </main>
      </>}

      {/* Issue detail modal */}
      {detail && (
        <div className="issue-modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) closeModal(); }}>
          <div className="issue-modal">
            <button className="issue-modal-close" onClick={closeModal} title="Close (Esc)">✕</button>

            {editing ? (
              <form className="edit-form" onSubmit={saveEdit}>
                <div className="detail-head">
                  <p className="eyebrow">Editing {board?.project.key}-{detail.issue.id}</p>
                  <button type="button" className="btn-ghost" onClick={() => setEditing(false)}>Cancel</button>
                </div>
                <label>Title
                  <input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} required />
                </label>
                <label>Description</label>
                <RichEditor value={editDesc} onChange={setEditDesc} minHeight={120} />
                <div className="form-row two-col">
                  <label>Priority
                    <select value={editPriority} onChange={(e) => setEditPriority(e.target.value as typeof editPriority)}>
                      {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
                    </select>
                  </label>
                  <label>Assignee
                    <select value={editAssignee} onChange={(e) => setEditAssignee(e.target.value === "" ? "" : Number(e.target.value))}>
                      <option value="">Unassigned</option>
                      {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                    </select>
                  </label>
                </div>
                <button className="btn-primary" type="submit">Save changes</button>
              </form>
            ) : (
              <>
                <div className="detail-head">
                  <div>
                    <p className="eyebrow">{board?.project.key}-{detail.issue.id}</p>
                    <h2>{detail.issue.title}</h2>
                  </div>
                  <div className="detail-head-right">
                    <span className="status-badge" style={{ backgroundColor: detail.issue.status.color }}>
                      {detail.issue.status.name}
                    </span>
                    <button className="btn-ghost" onClick={() => setEditing(true)}>Edit</button>
                  </div>
                </div>

                {detail.issue.description
                  ? <div className="detail-copy rich-content" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(detail.issue.description) }} />
                  : <p className="detail-copy"><em>No description</em></p>
                }

                <div className="meta-grid">
                  <div>
                    <span className="meta-label">Priority</span>
                    <span className={`pill ${detail.issue.priority}`}>{detail.issue.priority}</span>
                  </div>
                  <div>
                    <span className="meta-label">Assignee</span>
                    <strong>{detail.issue.assignee?.name ?? "Unassigned"}</strong>
                  </div>
                  <div>
                    <span className="meta-label">Reporter</span>
                    <strong>{detail.issue.reporter?.name ?? "Unknown"}</strong>
                  </div>
                </div>

                <div className="actions">
                  <span className="meta-label">Move to</span>
                  <div className="action-row">
                    {detail.nextStatuses.length > 0 ? (
                      detail.nextStatuses.map((s) => (
                        <button key={s.id} style={{ background: s.color }} onClick={() => void changeStatus(detail.issue.id, s.id)}>
                          {s.name}
                        </button>
                      ))
                    ) : (
                      <span className="meta-label">No transitions available</span>
                    )}
                  </div>
                </div>
              </>
            )}

            <section className="panel">
              <h3>Comments</h3>
              <div className="stack">
                {detail.comments.map((c) => (
                  <article className="entry" key={c.id}>
                    <div className="entry-head">
                      <strong>{c.author.name}</strong>
                      <span className="meta-label">{new Date(c.createdAt).toLocaleString(currentUser.locale)}</span>
                    </div>
                    <div className="rich-content" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(c.content) }} />
                  </article>
                ))}
              </div>
              <form onSubmit={submitComment} className="comment-form">
                <select
                  value={commentUserId ?? ""}
                  onChange={(e) => setCommentUserId(Number(e.target.value))}
                  className="comment-user-select"
                >
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>{u.name}</option>
                  ))}
                </select>
                <RichEditor value={newComment} onChange={setNewComment} placeholder="Write a comment…" minHeight={80} />
                <button type="submit" className="btn-primary" disabled={!newComment.trim()}>
                  Add comment
                </button>
              </form>
            </section>

            <section className="panel">
              <div className="panel-header">
                <h3>Attachments</h3>
                <label className="attach-btn">
                  + Attach file
                  <input type="file" style={{ display: "none" }} onChange={uploadAttachment} />
                </label>
              </div>
              {detail.attachments.length > 0 ? (
                <div className="attachments-list">
                  {detail.attachments.map((a) => (
                    <div className="attachment-item" key={a.id}>
                      <span className="attachment-icon">📎</span>
                      <div className="attachment-info">
                        <button
                          className="attachment-name attachment-download"
                          onClick={() => void downloadAttachment(a.id, a.originalName)}
                        >
                          {a.originalName}
                        </button>
                        <span className="meta-label">{formatBytes(a.size)} · {a.uploadedBy?.name ?? "Unknown"} · {new Date(a.createdAt).toLocaleDateString(currentUser.locale)}</span>
                      </div>
                      <button className="btn-ghost attachment-delete" onClick={() => void deleteAttachment(a.id)} title="Remove">✕</button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="meta-label">No attachments yet.</p>
              )}
            </section>

            <section className="panel">
              <h3>History</h3>
              <div className="stack">
                {detail.history.map((h) => (
                  <article className="entry" key={h.id}>
                    <div className="entry-head">
                      <strong>{h.actor?.name ?? "System"}</strong>
                      <span className="meta-label">{new Date(h.createdAt).toLocaleString(currentUser.locale)}</span>
                    </div>
                    <p>{h.field}: {h.fromValue ?? "—"} → {h.toValue ?? "—"}</p>
                  </article>
                ))}
              </div>
            </section>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
