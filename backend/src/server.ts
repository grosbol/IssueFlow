import "express-async-errors";
import bcrypt from "bcrypt";
import cors from "cors";
import crypto from "crypto";
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import fs from "fs";
import multer from "multer";
import path from "path";
import { z } from "zod";
import { config } from "./config.js";
import { pool } from "./db.js";

// Augment Express's Request so requireAuth can stash the authenticated user id.
// This avoids per-handler casts that break on routes with typed path params.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: number;
    }
  }
}

const UPLOADS_DIR = path.resolve(process.cwd(), "uploads");
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (_req, _file, cb) => cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}`),
});
const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg", "image/png", "image/gif", "image/webp", "image/svg+xml",
  "application/pdf",
  "text/plain", "text/csv",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/zip",
]);

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME_TYPES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`File type ${file.mimetype} is not allowed`));
    }
  },
});

const SALT_ROUNDS = 12;

// Sessions live in the database (source of truth) so they survive restarts and
// are shared across instances. This in-memory Map is a write-through cache to
// avoid a DB round-trip on every authenticated request; entries carry their own
// expiry so stale ones self-heal without waiting for a restart.
interface CachedSession {
  userId: number;
  expiresAt: number; // epoch millis
}
const sessions = new Map<string, CachedSession>();

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function generateToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

async function createSession(userId: number): Promise<string> {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await pool.query(
    "INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)",
    [token, userId, expiresAt]
  );
  sessions.set(token, { userId, expiresAt: expiresAt.getTime() });
  return token;
}

// Resolve a token to a user id, consulting the cache first and falling back to
// the database. Returns null for unknown or expired tokens.
async function resolveSession(token: string): Promise<number | null> {
  const cached = sessions.get(token);
  if (cached) {
    if (cached.expiresAt > Date.now()) return cached.userId;
    sessions.delete(token); // expired — fall through and clean up the DB row
  }

  const { rows } = await pool.query(
    "SELECT user_id, expires_at FROM sessions WHERE token = $1",
    [token]
  );
  if (rows.length === 0) return null;

  const expiresAt = new Date(rows[0].expires_at).getTime();
  if (expiresAt <= Date.now()) {
    await pool.query("DELETE FROM sessions WHERE token = $1", [token]);
    return null;
  }

  sessions.set(token, { userId: rows[0].user_id, expiresAt });
  return rows[0].user_id;
}

async function destroySession(token: string): Promise<void> {
  sessions.delete(token);
  await pool.query("DELETE FROM sessions WHERE token = $1", [token]);
}

const app = express();

app.use(helmet());
app.use(cors({ origin: config.corsOrigin }));
app.use(express.json({ limit: "5mb" }));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: "Too many login attempts, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
});

// Auth middleware — applied to all routes except /health and /api/auth/*
async function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return res.status(401).json({ error: "Unauthorized" });
  const userId = await resolveSession(auth.slice(7));
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  req.userId = userId;
  next();
}

app.get("/health", async (_req, res) => {
  await pool.query("SELECT 1");
  res.json({ ok: true });
});

async function requireAdmin(actorId: number): Promise<boolean> {
  const { rows } = await pool.query("SELECT role FROM users WHERE id = $1", [actorId]);
  return rows.length > 0 && rows[0].role === "admin";
}

// Middleware guard for routes that require an admin session. Relies on
// requireAuth having already populated req.userId.
async function adminOnly(req: express.Request, res: express.Response, next: express.NextFunction) {
  const actorId = req.userId!;
  if (!await requireAdmin(actorId)) return res.status(403).json({ error: "Admin access required" });
  next();
}

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

app.post("/api/auth/login", loginLimiter, async (req, res) => {
  const body = loginSchema.parse(req.body);
  const { rows } = await pool.query(
    "SELECT id, name, email, role, locale, password_hash FROM users WHERE email = $1",
    [body.email]
  );
  if (rows.length === 0) return res.status(401).json({ error: "Invalid email or password" });
  const user = rows[0];
  if (!user.password_hash) return res.status(401).json({ error: "No password set for this account" });
  const match = await bcrypt.compare(body.password, user.password_hash);
  if (!match) return res.status(401).json({ error: "Invalid email or password" });
  const token = await createSession(user.id);
  res.json({ token, id: user.id, name: user.name, email: user.email, role: user.role, locale: user.locale });
});

app.post("/api/auth/logout", async (req, res) => {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) await destroySession(auth.slice(7));
  res.json({ ok: true });
});

// All routes below this point require a valid session token
app.use("/api", requireAuth);

app.get("/api/users", async (_req, res) => {
  const { rows } = await pool.query(
    "SELECT id, name, email, role, locale, (password_hash IS NOT NULL) AS has_password FROM users ORDER BY name"
  );
  res.json(rows);
});

const userSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(6),
  role: z.enum(["admin", "user"]).default("user"),
  locale: z.string().default("en-US"),
});

app.post("/api/users", async (req, res) => {
  const actorId = req.userId!;
  const body = userSchema.parse(req.body);
  if (!await requireAdmin(actorId)) return res.status(403).json({ error: "Admin access required" });
  const existing = await pool.query("SELECT id FROM users WHERE email = $1", [body.email]);
  if (existing.rowCount! > 0) return res.status(409).json({ error: "Email already in use" });
  const hash = await bcrypt.hash(body.password, SALT_ROUNDS);
  const { rows } = await pool.query(
    "INSERT INTO users (name, email, password_hash, role, locale) VALUES ($1, $2, $3, $4, $5) RETURNING id, name, email, role, locale",
    [body.name, body.email, hash, body.role, body.locale]
  );
  res.status(201).json(rows[0]);
});

const updateUserSchema = z.object({
  name: z.string().min(1).optional(),
  email: z.string().email().optional(),
  password: z.string().min(6).optional(),
  role: z.enum(["admin", "user"]).optional(),
  locale: z.string().optional(),
});

app.patch("/api/users/:userId", async (req, res) => {
  const actorId = req.userId!;
  const userId = Number(req.params.userId);
  const body = updateUserSchema.parse(req.body);
  if (!await requireAdmin(actorId)) return res.status(403).json({ error: "Admin access required" });
  const updates: string[] = [];
  const values: unknown[] = [];
  let idx = 1;
  if (body.name !== undefined) { updates.push(`name = $${idx++}`); values.push(body.name); }
  if (body.email !== undefined) { updates.push(`email = $${idx++}`); values.push(body.email); }
  if (body.role !== undefined) { updates.push(`role = $${idx++}`); values.push(body.role); }
  if (body.locale !== undefined) { updates.push(`locale = $${idx++}`); values.push(body.locale); }
  if (body.password !== undefined) {
    const hash = await bcrypt.hash(body.password, SALT_ROUNDS);
    updates.push(`password_hash = $${idx++}`);
    values.push(hash);
  }
  if (updates.length === 0) return res.json({ ok: true });
  values.push(userId);
  const result = await pool.query(
    `UPDATE users SET ${updates.join(", ")} WHERE id = $${idx} RETURNING id, name, email, role, locale`,
    values
  );
  if (result.rowCount === 0) return res.status(404).json({ error: "User not found" });
  res.json(result.rows[0]);
});

app.delete("/api/users/:userId", async (req, res) => {
  const actorId = req.userId!;
  const userId = Number(req.params.userId);
  if (!await requireAdmin(actorId)) return res.status(403).json({ error: "Admin access required" });
  const assigned = await pool.query(
    "SELECT COUNT(*) FROM issues WHERE assignee_id = $1 OR reporter_id = $1",
    [userId]
  );
  if (Number(assigned.rows[0].count) > 0) {
    return res.status(409).json({ error: "User is assigned to issues and cannot be deleted" });
  }
  const result = await pool.query("DELETE FROM users WHERE id = $1", [userId]);
  if (result.rowCount === 0) return res.status(404).json({ error: "User not found" });
  res.json({ ok: true });
});

app.get("/api/projects", async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT p.id, p.name, p.key, p.workflow_id AS "workflowId",
            COUNT(i.id)::int AS "issueCount"
     FROM projects p
     LEFT JOIN issues i ON i.project_id = p.id
     GROUP BY p.id ORDER BY p.id`
  );
  res.json(rows);
});

const projectSchema = z.object({
  name: z.string().min(1),
  key: z.string().min(1).max(10).toUpperCase(),
  workflowId: z.number().int().positive(),
});

app.post("/api/projects", adminOnly, async (req, res) => {
  const body = projectSchema.parse(req.body);
  const exists = await pool.query("SELECT id FROM projects WHERE key = $1", [body.key]);
  if (exists.rowCount! > 0) return res.status(409).json({ error: "Project key already in use" });
  const { rows } = await pool.query(
    `INSERT INTO projects (name, key, workflow_id) VALUES ($1, $2, $3) RETURNING id, name, key, workflow_id AS "workflowId"`,
    [body.name, body.key, body.workflowId]
  );
  res.status(201).json(rows[0]);
});

app.patch("/api/projects/:projectId", adminOnly, async (req, res) => {
  const projectId = Number(req.params.projectId);
  const body = projectSchema.partial().parse(req.body);
  const updates: string[] = [];
  const values: unknown[] = [];
  let idx = 1;
  if (body.name !== undefined)       { updates.push(`name = $${idx++}`);        values.push(body.name); }
  if (body.key !== undefined)        { updates.push(`key = $${idx++}`);         values.push(body.key); }
  if (body.workflowId !== undefined) { updates.push(`workflow_id = $${idx++}`); values.push(body.workflowId); }
  if (!updates.length) return res.json({ ok: true });
  values.push(projectId);
  const { rows } = await pool.query(
    `UPDATE projects SET ${updates.join(", ")} WHERE id = $${idx} RETURNING id, name, key, workflow_id AS "workflowId"`,
    values
  );
  if (!rows.length) return res.status(404).json({ error: "Project not found" });
  res.json(rows[0]);
});

app.delete("/api/projects/:projectId", adminOnly, async (req, res) => {
  const projectId = Number(req.params.projectId);
  const inUse = await pool.query("SELECT COUNT(*) FROM issues WHERE project_id = $1", [projectId]);
  if (Number(inUse.rows[0].count) > 0)
    return res.status(409).json({ error: "Project has issues and cannot be deleted" });
  const result = await pool.query("DELETE FROM projects WHERE id = $1", [projectId]);
  if (!result.rowCount) return res.status(404).json({ error: "Project not found" });
  res.json({ ok: true });
});

app.get("/api/projects/:projectId/board", async (req, res) => {
  const projectId = Number(req.params.projectId);

  const projectResult = await pool.query(
    `SELECT id, name, key, workflow_id AS "workflowId"
     FROM projects
     WHERE id = $1`,
    [projectId]
  );

  if (projectResult.rowCount === 0) {
    return res.status(404).json({ error: "Project not found" });
  }

  const project = projectResult.rows[0];

  const statusesResult = await pool.query(
    `SELECT id, name, color, sort_order AS "sortOrder"
     FROM statuses
     WHERE workflow_id = $1
     ORDER BY sort_order`,
    [project.workflowId]
  );

  const issuesResult = await pool.query(
    `SELECT
       i.id,
       i.title,
       i.description,
       i.priority,
       i.created_at AS "createdAt",
       i.status_id AS "statusId",
       json_build_object('id', u.id, 'name', u.name, 'email', u.email) AS assignee
     FROM issues i
     LEFT JOIN users u ON u.id = i.assignee_id
     WHERE i.project_id = $1
     ORDER BY i.created_at DESC`,
    [projectId]
  );

  const transitionsResult = await pool.query(
    `SELECT from_status_id AS "fromStatusId", to_status_id AS "toStatusId"
     FROM workflow_transitions
     WHERE workflow_id = $1`,
    [project.workflowId]
  );

  return res.json({
    project,
    statuses: statusesResult.rows,
    issues: issuesResult.rows,
    transitions: transitionsResult.rows,
  });
});

app.get("/api/issues/:issueId", async (req, res) => {
  const issueId = Number(req.params.issueId);

  const issueResult = await pool.query(
    `SELECT
       i.id,
       i.title,
       i.description,
       i.priority,
       i.created_at AS "createdAt",
       i.updated_at AS "updatedAt",
       i.project_id AS "projectId",
       json_build_object('id', s.id, 'name', s.name, 'color', s.color) AS status,
       json_build_object('id', a.id, 'name', a.name, 'email', a.email) AS assignee,
       json_build_object('id', r.id, 'name', r.name, 'email', r.email) AS reporter
     FROM issues i
     JOIN statuses s ON s.id = i.status_id
     LEFT JOIN users a ON a.id = i.assignee_id
     LEFT JOIN users r ON r.id = i.reporter_id
     WHERE i.id = $1`,
    [issueId]
  );

  if (issueResult.rowCount === 0) {
    return res.status(404).json({ error: "Issue not found" });
  }

  const commentsResult = await pool.query(
    `SELECT
       c.id,
       c.content,
       c.created_at AS "createdAt",
       json_build_object('id', u.id, 'name', u.name, 'email', u.email) AS author
     FROM comments c
     JOIN users u ON u.id = c.user_id
     WHERE c.issue_id = $1
     ORDER BY c.created_at ASC`,
    [issueId]
  );

  const historyResult = await pool.query(
    `SELECT
       h.id,
       h.field,
       h.from_value AS "fromValue",
       h.to_value AS "toValue",
       h.created_at AS "createdAt",
       json_build_object('id', u.id, 'name', u.name, 'email', u.email) AS actor
     FROM issue_history h
     LEFT JOIN users u ON u.id = h.actor_id
     WHERE h.issue_id = $1
     ORDER BY h.created_at DESC`,
    [issueId]
  );

  const attachmentsResult = await pool.query(
    `SELECT a.id, a.original_name AS "originalName", a.mime_type AS "mimeType", a.size,
            a.created_at AS "createdAt",
            json_build_object('id', u.id, 'name', u.name) AS "uploadedBy"
     FROM attachments a
     LEFT JOIN users u ON u.id = a.uploaded_by
     WHERE a.issue_id = $1
     ORDER BY a.created_at ASC`,
    [issueId]
  );

  const nextStatusesResult = await pool.query(
    `SELECT s.id, s.name, s.color
     FROM workflow_transitions wt
     JOIN issues i ON i.id = $1
     JOIN projects p ON p.id = i.project_id
     JOIN statuses s ON s.id = wt.to_status_id
     WHERE wt.workflow_id = p.workflow_id
       AND wt.from_status_id = i.status_id
     ORDER BY s.sort_order`,
    [issueId]
  );

  return res.json({
    issue: issueResult.rows[0],
    comments: commentsResult.rows,
    history: historyResult.rows,
    nextStatuses: nextStatusesResult.rows,
    attachments: attachmentsResult.rows,
  });
});

const createIssueSchema = z.object({
  projectId: z.number(),
  title: z.string().min(3),
  description: z.string().default(""),
  assigneeId: z.number().nullable().optional(),
  priority: z.enum(["low", "medium", "high"]).default("medium"),
});

app.post("/api/issues", async (req, res) => {
  const reporterId = req.userId!;
  const body = createIssueSchema.parse(req.body);

  const initialStatusResult = await pool.query(
    `SELECT s.id, s.name
     FROM statuses s
     JOIN projects p ON p.workflow_id = s.workflow_id
     WHERE p.id = $1
     ORDER BY s.sort_order ASC
     LIMIT 1`,
    [body.projectId]
  );

  if (initialStatusResult.rowCount === 0) {
    return res.status(400).json({ error: "Project has no workflow statuses" });
  }

  const issueResult = await pool.query(
    `INSERT INTO issues (
       project_id, title, description, status_id, assignee_id, reporter_id, priority
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      body.projectId,
      body.title,
      body.description,
      initialStatusResult.rows[0].id,
      body.assigneeId ?? null,
      reporterId,
      body.priority,
    ]
  );

  const issueId = issueResult.rows[0].id;

  await pool.query(
    `INSERT INTO issue_history (issue_id, actor_id, field, from_value, to_value)
     VALUES ($1, $2, 'status', NULL, $3)`,
    [issueId, reporterId, initialStatusResult.rows[0].name]
  );

  res.status(201).json({ id: issueId });
});

const updateIssueSchema = z.object({
  title: z.string().min(3).optional(),
  description: z.string().optional(),
  priority: z.enum(["low", "medium", "high"]).optional(),
  assigneeId: z.number().nullable().optional(),
});

app.patch("/api/issues/:issueId", async (req, res) => {
  const actorId = req.userId!;
  const issueId = Number(req.params.issueId);
  const body = updateIssueSchema.parse(req.body);

  const issueResult = await pool.query("SELECT id FROM issues WHERE id = $1", [issueId]);
  if (issueResult.rowCount === 0) {
    return res.status(404).json({ error: "Issue not found" });
  }

  const updates: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (body.title !== undefined) { updates.push(`title = $${idx++}`); values.push(body.title); }
  if (body.description !== undefined) { updates.push(`description = $${idx++}`); values.push(body.description); }
  if (body.priority !== undefined) { updates.push(`priority = $${idx++}`); values.push(body.priority); }
  if (body.assigneeId !== undefined) { updates.push(`assignee_id = $${idx++}`); values.push(body.assigneeId); }

  if (updates.length === 0) return res.json({ ok: true });

  updates.push(`updated_at = NOW()`);
  values.push(issueId);

  await pool.query(
    `UPDATE issues SET ${updates.join(", ")} WHERE id = $${idx}`,
    values
  );

  const fields = ["title", "description", "priority", "assigneeId"] as const;
  for (const field of fields) {
    if (body[field] !== undefined) {
      await pool.query(
        `INSERT INTO issue_history (issue_id, actor_id, field, from_value, to_value)
         VALUES ($1, $2, $3, NULL, $4)`,
        [issueId, actorId, field, String(body[field])]
      );
    }
  }

  res.json({ ok: true });
});

const statusChangeSchema = z.object({
  nextStatusId: z.number(),
});

app.patch("/api/issues/:issueId/status", async (req, res) => {
  const actorId = req.userId!;
  const issueId = Number(req.params.issueId);
  const body = statusChangeSchema.parse(req.body);

  const issueResult = await pool.query(
    `SELECT
       i.status_id AS "statusId",
       p.workflow_id AS "workflowId",
       current_status.name AS "currentStatusName",
       next_status.name AS "nextStatusName"
     FROM issues i
     JOIN projects p ON p.id = i.project_id
     JOIN statuses current_status ON current_status.id = i.status_id
     JOIN statuses next_status ON next_status.id = $2
     WHERE i.id = $1`,
    [issueId, body.nextStatusId]
  );

  if (issueResult.rowCount === 0) {
    return res.status(404).json({ error: "Issue or status not found" });
  }

  const issue = issueResult.rows[0];

  const transitionResult = await pool.query(
    `SELECT 1
     FROM workflow_transitions
     WHERE workflow_id = $1
       AND from_status_id = $2
       AND to_status_id = $3`,
    [issue.workflowId, issue.statusId, body.nextStatusId]
  );

  if (transitionResult.rowCount === 0) {
    return res.status(400).json({
      error: `Transition from ${issue.currentStatusName} to ${issue.nextStatusName} is not allowed`,
    });
  }

  await pool.query(
    `UPDATE issues
     SET status_id = $2, updated_at = NOW()
     WHERE id = $1`,
    [issueId, body.nextStatusId]
  );

  await pool.query(
    `INSERT INTO issue_history (issue_id, actor_id, field, from_value, to_value)
     VALUES ($1, $2, 'status', $3, $4)`,
    [issueId, actorId, issue.currentStatusName, issue.nextStatusName]
  );

  res.json({ ok: true });
});

const commentSchema = z.object({
  content: z.string().min(1),
});

app.post("/api/issues/:issueId/comments", async (req, res) => {
  const actorId = req.userId!;
  const issueId = Number(req.params.issueId);
  const body = commentSchema.parse(req.body);

  await pool.query(
    `INSERT INTO comments (issue_id, user_id, content)
     VALUES ($1, $2, $3)`,
    [issueId, actorId, body.content]
  );

  await pool.query(
    `INSERT INTO issue_history (issue_id, actor_id, field, from_value, to_value)
     VALUES ($1, $2, 'comment', NULL, 'Comment added')`,
    [issueId, actorId]
  );

  res.status(201).json({ ok: true });
});

app.post("/api/issues/:issueId/attachments", upload.single("file"), async (req, res) => {
  const uploadedBy = req.userId!;
  const issueId = Number(req.params.issueId);
  if (!req.file) return res.status(400).json({ error: "No file provided" });

  // Multer has already written the file to disk by the time we get here, so if
  // the target issue does not exist we must clean up the orphaned upload before
  // returning, otherwise it would leak on the filesystem.
  const issueExists = await pool.query("SELECT 1 FROM issues WHERE id = $1", [issueId]);
  if (issueExists.rowCount === 0) {
    const orphanPath = path.join(UPLOADS_DIR, req.file.filename);
    if (fs.existsSync(orphanPath)) fs.unlinkSync(orphanPath);
    return res.status(404).json({ error: "Issue not found" });
  }

  const { rows } = await pool.query(
    `INSERT INTO attachments (issue_id, filename, original_name, mime_type, size, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, original_name AS "originalName", mime_type AS "mimeType", size, created_at AS "createdAt"`,
    [issueId, req.file.filename, req.file.originalname, req.file.mimetype, req.file.size, uploadedBy]
  );
  res.status(201).json(rows[0]);
});

app.get("/api/attachments/:id/file", async (req, res) => {
  const { rows } = await pool.query(
    "SELECT filename, original_name FROM attachments WHERE id = $1",
    [Number(req.params.id)]
  );
  if (rows.length === 0) return res.status(404).json({ error: "Attachment not found" });
  const filePath = path.join(UPLOADS_DIR, rows[0].filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "File not found" });
  res.download(filePath, rows[0].original_name);
});

app.delete("/api/attachments/:id", async (req, res) => {
  const actorId = req.userId!;
  const { rows } = await pool.query(
    "SELECT filename, uploaded_by FROM attachments WHERE id = $1",
    [Number(req.params.id)]
  );
  if (rows.length === 0) return res.status(404).json({ error: "Attachment not found" });

  // Only the original uploader or an admin may delete an attachment.
  if (rows[0].uploaded_by !== actorId && !await requireAdmin(actorId)) {
    return res.status(403).json({ error: "Not allowed to delete this attachment" });
  }

  await pool.query("DELETE FROM attachments WHERE id = $1", [Number(req.params.id)]);
  const filePath = path.join(UPLOADS_DIR, rows[0].filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  res.json({ ok: true });
});

// ── Workflow editor ──────────────────────────────────────────────────────

app.get("/api/workflows", async (_req, res) => {
  const { rows } = await pool.query("SELECT id, name FROM workflows ORDER BY id");
  res.json(rows);
});

app.get("/api/workflows/:id", async (req, res) => {
  const id = Number(req.params.id);
  const wf = await pool.query("SELECT id, name FROM workflows WHERE id = $1", [id]);
  if (!wf.rowCount) return res.status(404).json({ error: "Not found" });
  const statuses = await pool.query(
    `SELECT id, name, color, sort_order AS "sortOrder" FROM statuses WHERE workflow_id = $1 ORDER BY sort_order`,
    [id]
  );
  const transitions = await pool.query(
    `SELECT from_status_id AS "fromStatusId", to_status_id AS "toStatusId" FROM workflow_transitions WHERE workflow_id = $1`,
    [id]
  );
  res.json({ workflow: wf.rows[0], statuses: statuses.rows, transitions: transitions.rows });
});

const newWorkflowSchema = z.object({ name: z.string().min(1) });

app.post("/api/workflows", adminOnly, async (req, res) => {
  const body = newWorkflowSchema.parse(req.body);
  const { rows } = await pool.query(
    "INSERT INTO workflows (name) VALUES ($1) RETURNING id, name",
    [body.name]
  );
  res.status(201).json(rows[0]);
});

app.patch("/api/workflows/:id", adminOnly, async (req, res) => {
  const body = newWorkflowSchema.parse(req.body);
  const { rows } = await pool.query(
    "UPDATE workflows SET name = $1 WHERE id = $2 RETURNING id, name",
    [body.name, Number(req.params.id)]
  );
  if (!rows.length) return res.status(404).json({ error: "Not found" });
  res.json(rows[0]);
});

const newStatusSchema = z.object({
  name: z.string().min(1),
  color: z.string().default("#64748b"),
  sortOrder: z.number().default(0),
});

app.post("/api/workflows/:id/statuses", adminOnly, async (req, res) => {
  const workflowId = Number(req.params.id);
  const body = newStatusSchema.parse(req.body);
  const { rows } = await pool.query(
    `INSERT INTO statuses (workflow_id, name, color, sort_order) VALUES ($1, $2, $3, $4) RETURNING id, name, color, sort_order AS "sortOrder"`,
    [workflowId, body.name, body.color, body.sortOrder]
  );
  res.status(201).json(rows[0]);
});

const updateStatusSchema2 = z.object({
  name: z.string().min(1).optional(),
  color: z.string().optional(),
  sortOrder: z.number().optional(),
});

app.patch("/api/statuses/:id", adminOnly, async (req, res) => {
  const statusId = Number(req.params.id);
  const body = updateStatusSchema2.parse(req.body);
  const updates: string[] = [];
  const values: unknown[] = [];
  let idx = 1;
  if (body.name !== undefined)      { updates.push(`name = $${idx++}`);       values.push(body.name); }
  if (body.color !== undefined)     { updates.push(`color = $${idx++}`);      values.push(body.color); }
  if (body.sortOrder !== undefined) { updates.push(`sort_order = $${idx++}`); values.push(body.sortOrder); }
  if (!updates.length) return res.json({ ok: true });
  values.push(statusId);
  const { rows } = await pool.query(
    `UPDATE statuses SET ${updates.join(", ")} WHERE id = $${idx} RETURNING id, name, color, sort_order AS "sortOrder"`,
    values
  );
  if (!rows.length) return res.status(404).json({ error: "Not found" });
  res.json(rows[0]);
});

app.delete("/api/statuses/:id", adminOnly, async (req, res) => {
  const statusId = Number(req.params.id);
  const inUse = await pool.query("SELECT COUNT(*) FROM issues WHERE status_id = $1", [statusId]);
  if (Number(inUse.rows[0].count) > 0)
    return res.status(409).json({ error: "Status is in use by issues and cannot be deleted" });
  await pool.query("DELETE FROM workflow_transitions WHERE from_status_id = $1 OR to_status_id = $1", [statusId]);
  const result = await pool.query("DELETE FROM statuses WHERE id = $1", [statusId]);
  if (!result.rowCount) return res.status(404).json({ error: "Not found" });
  res.json({ ok: true });
});

const transitionBodySchema = z.object({ fromStatusId: z.number(), toStatusId: z.number() });

app.post("/api/workflows/:id/transitions", adminOnly, async (req, res) => {
  const workflowId = Number(req.params.id);
  const body = transitionBodySchema.parse(req.body);
  await pool.query(
    `INSERT INTO workflow_transitions (workflow_id, from_status_id, to_status_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [workflowId, body.fromStatusId, body.toStatusId]
  );
  res.status(201).json({ ok: true });
});

app.delete("/api/workflows/:id/transitions", adminOnly, async (req, res) => {
  const workflowId = Number(req.params.id);
  const body = transitionBodySchema.parse(req.body);
  await pool.query(
    `DELETE FROM workflow_transitions WHERE workflow_id = $1 AND from_status_id = $2 AND to_status_id = $3`,
    [workflowId, body.fromStatusId, body.toStatusId]
  );
  res.json({ ok: true });
});

// Global error handler — catches Zod validation errors and unhandled exceptions
// Must be registered after all routes
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof z.ZodError) {
    return res.status(400).json({ error: "Validation error", details: err.errors });
  }
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

export { app, sessions };

async function start() {
  app.listen(config.port, () => {
    console.log(`IssueFlow API listening on http://localhost:${config.port}`);
  });
}

// Only bind the port when run as the entrypoint, so tests can import `app`
// and drive it with supertest without opening a socket.
if (process.env.NODE_ENV !== "test") {
  start().catch((error) => {
    console.error("Failed to start server", error);
    process.exit(1);
  });
}
