import { FormEvent, useEffect, useState } from "react";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

function apiFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const token = localStorage.getItem("authToken");
  return fetch(`${API_URL}${path}`, {
    ...options,
    headers: { ...options.headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
}

type User = { id: number; name: string; email: string; role: "admin" | "user"; locale: string; has_password: boolean };

const LOCALES: { value: string; label: string }[] = [
  { value: "da-DK", label: "Danish (da-DK)" },
  { value: "en-US", label: "English US (en-US)" },
  { value: "en-GB", label: "English UK (en-GB)" },
  { value: "de-DE", label: "German (de-DE)" },
  { value: "fr-FR", label: "French (fr-FR)" },
  { value: "sv-SE", label: "Swedish (sv-SE)" },
  { value: "nb-NO", label: "Norwegian (nb-NO)" },
  { value: "fi-FI", label: "Finnish (fi-FI)" },
];
type CurrentUser = { id: number; name: string; email: string; role: "admin" | "user" };

export default function UsersPage({ currentUser }: { currentUser: CurrentUser }) {
  const [users, setUsers] = useState<User[]>([]);
  const [error, setError] = useState("");

  const [newName, setNewName] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newRole, setNewRole] = useState<"admin" | "user">("user");
  const [newLocale, setNewLocale] = useState("en-US");
  const [createError, setCreateError] = useState("");

  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [editEmail, setEditEmail] = useState("");
  const [editPassword, setEditPassword] = useState("");
  const [editRole, setEditRole] = useState<"admin" | "user">("user");
  const [editLocale, setEditLocale] = useState("en-US");
  const [editError, setEditError] = useState("");

  async function load() {
    const res = await apiFetch(`/api/users`);
    setUsers(await res.json());
  }

  useEffect(() => { void load(); }, []);

  async function createUser(e: FormEvent) {
    e.preventDefault();
    setCreateError("");
    const res = await apiFetch(`/api/users`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actorId: currentUser.id, name: newName, email: newEmail, password: newPassword, role: newRole, locale: newLocale }),
    });
    if (!res.ok) { setCreateError((await res.json()).error ?? "Failed to create user"); return; }
    setNewName(""); setNewEmail(""); setNewPassword(""); setNewRole("user"); setNewLocale("en-US");
    await load();
  }

  function startEdit(user: User) {
    setEditingId(user.id);
    setEditName(user.name);
    setEditEmail(user.email);
    setEditPassword("");
    setEditRole(user.role);
    setEditLocale(user.locale);
    setEditError("");
  }

  async function saveEdit(e: FormEvent) {
    e.preventDefault();
    if (editingId === null) return;
    setEditError("");
    const body: Record<string, string | number> = { actorId: currentUser.id, name: editName, email: editEmail, role: editRole, locale: editLocale };
    if (editPassword) body.password = editPassword;
    const res = await apiFetch(`/api/users/${editingId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) { setEditError((await res.json()).error ?? "Failed to update user"); return; }
    setEditingId(null);
    await load();
  }

  async function deleteUser(user: User) {
    setError("");
    const res = await apiFetch(`/api/users/${user.id}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actorId: currentUser.id }),
    });
    if (!res.ok) { setError((await res.json()).error ?? "Failed to delete user"); return; }
    await load();
  }

  return (
    <div className="users-page">
      <h2>User administration</h2>
      {error && <p className="form-error">{error}</p>}

      <table className="users-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Email</th>
            <th>Role</th>
            <th>Locale</th>
            <th>Password</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {users.map((user) =>
            editingId === user.id ? (
              <tr key={user.id}>
                <td colSpan={6}>
                  <form className="inline-edit-form six-col" onSubmit={saveEdit}>
                    <input value={editName} onChange={(e) => setEditName(e.target.value)} required placeholder="Name" />
                    <input value={editEmail} onChange={(e) => setEditEmail(e.target.value)} required type="email" placeholder="Email" />
                    <select value={editRole} onChange={(e) => setEditRole(e.target.value as "admin" | "user")}>
                      <option value="user">User</option>
                      <option value="admin">Admin</option>
                    </select>
                    <select value={editLocale} onChange={(e) => setEditLocale(e.target.value)}>
                      {LOCALES.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
                    </select>
                    <input value={editPassword} onChange={(e) => setEditPassword(e.target.value)} type="password" placeholder="New password (optional)" />
                    <div className="inline-edit-actions">
                      <button className="btn-primary" type="submit">Save</button>
                      <button className="btn-ghost" type="button" onClick={() => setEditingId(null)}>Cancel</button>
                    </div>
                    {editError && <p className="form-error">{editError}</p>}
                  </form>
                </td>
              </tr>
            ) : (
              <tr key={user.id}>
                <td><strong>{user.name}</strong></td>
                <td className="meta-label">{user.email}</td>
                <td>
                  <span className={`role-badge role-badge--${user.role}`}>{user.role}</span>
                </td>
                <td className="meta-label">{user.locale}</td>
                <td>
                  {user.has_password
                    ? <span className="badge-set">Set</span>
                    : <span className="badge-unset">Not set</span>}
                </td>
                <td className="user-actions">
                  <button className="btn-ghost" onClick={() => startEdit(user)}>Edit</button>
                  <button className="btn-danger" onClick={() => void deleteUser(user)}>Delete</button>
                </td>
              </tr>
            )
          )}
        </tbody>
      </table>

      <div className="users-create">
        <h3>Add user</h3>
        <form className="create-user-form" onSubmit={createUser}>
          <div className="create-user-grid">
            <input value={newName} onChange={(e) => setNewName(e.target.value)} required placeholder="Full name" />
            <input value={newEmail} onChange={(e) => setNewEmail(e.target.value)} required type="email" placeholder="Email address" />
            <input value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required type="password" placeholder="Password (min 6 chars)" minLength={6} />
            <select value={newRole} onChange={(e) => setNewRole(e.target.value as "admin" | "user")}>
              <option value="user">User</option>
              <option value="admin">Admin</option>
            </select>
            <select value={newLocale} onChange={(e) => setNewLocale(e.target.value)}>
              {LOCALES.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
            </select>
          </div>
          <button className="btn-primary" type="submit" style={{ marginTop: 12, alignSelf: "start" }}>Add user</button>
          {createError && <p className="form-error">{createError}</p>}
        </form>
      </div>
    </div>
  );
}
