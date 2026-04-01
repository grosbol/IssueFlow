import { FormEvent, useEffect, useState } from "react";

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
type Workflow = { id: number; name: string };

export default function ProjectsPage({ onProjectsChange }: { onProjectsChange: () => void }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [error, setError] = useState("");

  // create form
  const [newName, setNewName] = useState("");
  const [newKey, setNewKey] = useState("");
  const [newWorkflowId, setNewWorkflowId] = useState<number | "">("");

  // edit state
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [editKey, setEditKey] = useState("");
  const [editWorkflowId, setEditWorkflowId] = useState<number | "">("");

  async function load() {
    const [pr, wr] = await Promise.all([
      apiFetch("/api/projects"),
      apiFetch("/api/workflows"),
    ]);
    setProjects(await pr.json());
    setWorkflows(await wr.json());
  }

  useEffect(() => { void load(); }, []);

  async function createProject(e: FormEvent) {
    e.preventDefault();
    setError("");
    const res = await apiFetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName, key: newKey, workflowId: newWorkflowId }),
    });
    if (!res.ok) {
      const data = await res.json();
      setError(data.error ?? "Failed to create project");
      return;
    }
    setNewName("");
    setNewKey("");
    setNewWorkflowId("");
    await load();
    onProjectsChange();
  }

  function startEdit(p: Project) {
    setEditingId(p.id);
    setEditName(p.name);
    setEditKey(p.key);
    setEditWorkflowId(p.workflowId);
    setError("");
  }

  async function saveEdit(e: FormEvent) {
    e.preventDefault();
    if (!editingId) return;
    setError("");
    const res = await apiFetch(`/api/projects/${editingId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: editName, key: editKey, workflowId: editWorkflowId }),
    });
    if (!res.ok) {
      const data = await res.json();
      setError(data.error ?? "Failed to update project");
      return;
    }
    setEditingId(null);
    await load();
    onProjectsChange();
  }

  async function deleteProject(id: number) {
    setError("");
    const res = await apiFetch(`/api/projects/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json();
      setError(data.error ?? "Failed to delete project");
      return;
    }
    await load();
    onProjectsChange();
  }

  return (
    <div className="users-page">
      <h2>Projects</h2>

      <table className="users-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Key</th>
            <th>Workflow</th>
            <th>Issues</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {projects.map((p) =>
            editingId === p.id ? (
              <tr key={p.id}>
                <td colSpan={5}>
                  <form className="inline-edit-form six-col" onSubmit={saveEdit}>
                    <input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      placeholder="Project name"
                      required
                    />
                    <input
                      value={editKey}
                      onChange={(e) => setEditKey(e.target.value.toUpperCase())}
                      placeholder="KEY"
                      maxLength={10}
                      required
                    />
                    <select
                      value={editWorkflowId}
                      onChange={(e) => setEditWorkflowId(Number(e.target.value))}
                      required
                    >
                      <option value="">Workflow…</option>
                      {workflows.map((w) => (
                        <option key={w.id} value={w.id}>{w.name}</option>
                      ))}
                    </select>
                    <div className="inline-edit-actions">
                      <button className="btn-primary" type="submit" style={{ padding: "7px 14px", fontSize: 13 }}>Save</button>
                      <button type="button" className="btn-ghost" onClick={() => setEditingId(null)}>Cancel</button>
                    </div>
                  </form>
                </td>
              </tr>
            ) : (
              <tr key={p.id}>
                <td><strong>{p.name}</strong></td>
                <td><span className="issue-key">{p.key}</span></td>
                <td>{workflows.find((w) => w.id === p.workflowId)?.name ?? p.workflowId}</td>
                <td>{p.issueCount}</td>
                <td>
                  <div className="user-actions">
                    <button className="btn-ghost" style={{ fontSize: 12 }} onClick={() => startEdit(p)}>Edit</button>
                    <button
                      className="btn-danger"
                      onClick={() => void deleteProject(p.id)}
                      disabled={p.issueCount > 0}
                      title={p.issueCount > 0 ? "Cannot delete project with issues" : "Delete project"}
                    >
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            )
          )}
        </tbody>
      </table>

      <div className="users-create">
        <h3>New project</h3>
        <form className="projects-create-form" onSubmit={createProject}>
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Project name"
            required
          />
          <input
            value={newKey}
            onChange={(e) => setNewKey(e.target.value.toUpperCase())}
            placeholder="KEY"
            maxLength={10}
            required
          />
          <select
            value={newWorkflowId}
            onChange={(e) => setNewWorkflowId(Number(e.target.value))}
            required
          >
            <option value="">Select workflow…</option>
            {workflows.map((w) => (
              <option key={w.id} value={w.id}>{w.name}</option>
            ))}
          </select>
          <button className="btn-primary" type="submit">Create</button>
        </form>
        {error && <p className="form-error">{error}</p>}
      </div>
    </div>
  );
}
