import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import bcrypt from "bcrypt";
import { pool } from "../src/db.js";
import { app, sessions } from "../src/server.js";

// Replace the real pg query with a controllable mock. Every handler funnels
// through pool.query at request time, so overriding the method intercepts all
// database access — no real Postgres connection is ever opened.
const query = vi.fn();
(pool as unknown as { query: typeof query }).query = query;

// Helper: register a fake session token and return an auth header. Seeding the
// in-memory cache directly means the auth middleware resolves the token without
// touching the (mocked) database, so per-test query sequences stay focused on
// the route under test.
function authAs(userId: number): string {
  const token = `test-token-${userId}`;
  sessions.set(token, { userId, expiresAt: Date.now() + 60_000 });
  return `Bearer ${token}`;
}

beforeEach(() => {
  query.mockReset();
  sessions.clear();
});

describe("auth middleware", () => {
  it("rejects requests without a token", async () => {
    const res = await request(app).get("/api/projects");
    expect(res.status).toBe(401);
  });

  it("rejects requests with an unknown token", async () => {
    // Not in the cache, so resolveSession falls back to the DB and finds nothing.
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // session lookup misses
    const res = await request(app)
      .get("/api/projects")
      .set("Authorization", "Bearer nope");
    expect(res.status).toBe(401);
  });

  it("allows requests with a valid session token", async () => {
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // GET projects list
    const res = await request(app)
      .get("/api/projects")
      .set("Authorization", authAs(1));
    expect(res.status).toBe(200);
  });
});

describe("login", () => {
  it("returns 400 when the body is invalid", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "not-an-email" });
    expect(res.status).toBe(400);
  });

  it("returns 401 for an unknown email", async () => {
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "ghost@example.com", password: "secret" });
    expect(res.status).toBe(401);
  });
});

describe("workflow transition validation", () => {
  // Shared first query: the issue + status name lookup.
  const issueLookup = {
    rowCount: 1,
    rows: [
      {
        statusId: 1,
        workflowId: 7,
        currentStatusName: "To Do",
        nextStatusName: "Done",
      },
    ],
  };

  it("rejects a transition that has no matching workflow edge", async () => {
    query.mockResolvedValueOnce(issueLookup); // issue lookup
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // transition check: none

    const res = await request(app)
      .patch("/api/issues/42/status")
      .set("Authorization", authAs(1))
      .send({ nextStatusId: 3 });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("not allowed");
    // It must not attempt the UPDATE when the transition is disallowed.
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("allows a transition backed by a workflow edge and records history", async () => {
    query.mockResolvedValueOnce(issueLookup); // issue lookup
    query.mockResolvedValueOnce({ rows: [{ "?column?": 1 }], rowCount: 1 }); // transition allowed
    query.mockResolvedValueOnce({ rowCount: 1, rows: [] }); // UPDATE issues
    query.mockResolvedValueOnce({ rowCount: 1, rows: [] }); // INSERT history

    const res = await request(app)
      .patch("/api/issues/42/status")
      .set("Authorization", authAs(9))
      .send({ nextStatusId: 3 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    // History is written with the acting user and the human-readable names.
    const historyCall = query.mock.calls.at(-1)!;
    expect(String(historyCall[0])).toContain("INSERT INTO issue_history");
    expect(historyCall[1]).toEqual([42, 9, "To Do", "Done"]);
  });

  it("returns 404 when the issue or target status does not exist", async () => {
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // issue lookup misses

    const res = await request(app)
      .patch("/api/issues/999/status")
      .set("Authorization", authAs(1))
      .send({ nextStatusId: 3 });

    expect(res.status).toBe(404);
  });
});

describe("admin authorization", () => {
  it("blocks a non-admin from creating a project", async () => {
    query.mockResolvedValueOnce({ rows: [{ role: "user" }], rowCount: 1 }); // requireAdmin

    const res = await request(app)
      .post("/api/projects")
      .set("Authorization", authAs(2))
      .send({ name: "New", key: "NEW", workflowId: 1 });

    expect(res.status).toBe(403);
  });

  it("blocks a non-admin from editing the workflow", async () => {
    query.mockResolvedValueOnce({ rows: [{ role: "user" }], rowCount: 1 }); // requireAdmin

    const res = await request(app)
      .post("/api/workflows/1/transitions")
      .set("Authorization", authAs(2))
      .send({ fromStatusId: 1, toStatusId: 2 });

    expect(res.status).toBe(403);
  });

  it("lets an admin create a project", async () => {
    query.mockResolvedValueOnce({ rows: [{ role: "admin" }], rowCount: 1 }); // requireAdmin
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // key uniqueness check
    query.mockResolvedValueOnce({
      rows: [{ id: 5, name: "New", key: "NEW", workflowId: 1 }],
      rowCount: 1,
    }); // INSERT project

    const res = await request(app)
      .post("/api/projects")
      .set("Authorization", authAs(1))
      .send({ name: "New", key: "NEW", workflowId: 1 });

    expect(res.status).toBe(201);
    expect(res.body.key).toBe("NEW");
  });
});

describe("issue creation uses the session as reporter", () => {
  it("ignores any client-supplied reporter and uses the authenticated user", async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 1, name: "To Do" }], rowCount: 1 }); // initial status
    query.mockResolvedValueOnce({ rows: [{ id: 100 }], rowCount: 1 }); // INSERT issue
    query.mockResolvedValueOnce({ rowCount: 1, rows: [] }); // INSERT history

    const res = await request(app)
      .post("/api/issues")
      .set("Authorization", authAs(77))
      .send({ projectId: 1, title: "A real issue", reporterId: 1 });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(100);

    // The INSERT into issues must carry the session user (77) as reporter
    // (params index 5), not the forged reporterId (1) from the request body.
    const insertCall = query.mock.calls.find((c) =>
      String(c[0]).includes("INSERT INTO issues")
    )!;
    expect(insertCall[1][5]).toBe(77);

    // And the history row's actor must also be the session user.
    const historyCall = query.mock.calls.find((c) =>
      String(c[0]).includes("INSERT INTO issue_history")
    )!;
    expect(historyCall[1]).toContain(77);
  });
});

describe("attachment authorization", () => {
  it("lets the original uploader delete their own attachment", async () => {
    query.mockResolvedValueOnce({
      rows: [{ filename: "abc", uploaded_by: 5 }],
      rowCount: 1,
    }); // SELECT attachment
    query.mockResolvedValueOnce({ rowCount: 1, rows: [] }); // DELETE attachment

    const res = await request(app)
      .delete("/api/attachments/1")
      .set("Authorization", authAs(5));

    expect(res.status).toBe(200);
  });

  it("lets an admin delete someone else's attachment", async () => {
    query.mockResolvedValueOnce({
      rows: [{ filename: "abc", uploaded_by: 5 }],
      rowCount: 1,
    }); // SELECT attachment
    query.mockResolvedValueOnce({ rows: [{ role: "admin" }], rowCount: 1 }); // requireAdmin
    query.mockResolvedValueOnce({ rowCount: 1, rows: [] }); // DELETE attachment

    const res = await request(app)
      .delete("/api/attachments/1")
      .set("Authorization", authAs(9));

    expect(res.status).toBe(200);
  });

  it("forbids a non-owner non-admin from deleting an attachment", async () => {
    query.mockResolvedValueOnce({
      rows: [{ filename: "abc", uploaded_by: 5 }],
      rowCount: 1,
    }); // SELECT attachment
    query.mockResolvedValueOnce({ rows: [{ role: "user" }], rowCount: 1 }); // requireAdmin

    const res = await request(app)
      .delete("/api/attachments/1")
      .set("Authorization", authAs(8));

    expect(res.status).toBe(403);
    // It must not issue a DELETE when the actor is not authorized.
    const deleteCall = query.mock.calls.find((c) =>
      String(c[0]).includes("DELETE FROM attachments")
    );
    expect(deleteCall).toBeUndefined();
  });

  it("returns 404 when deleting a missing attachment", async () => {
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // SELECT attachment misses

    const res = await request(app)
      .delete("/api/attachments/999")
      .set("Authorization", authAs(5));

    expect(res.status).toBe(404);
  });
});

describe("session lifecycle", () => {
  it("persists a session to the database on login", async () => {
    const hash = await bcrypt.hash("secret", 10);
    query.mockResolvedValueOnce({
      rows: [
        { id: 3, name: "Ada", email: "ada@example.com", role: "user", locale: "en-US", password_hash: hash },
      ],
      rowCount: 1,
    }); // user lookup
    query.mockResolvedValueOnce({ rowCount: 1, rows: [] }); // INSERT session

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "ada@example.com", password: "secret" });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeTypeOf("string");

    const insertCall = query.mock.calls.find((c) =>
      String(c[0]).includes("INSERT INTO sessions")
    )!;
    expect(insertCall).toBeDefined();
    expect(insertCall[1][1]).toBe(3); // user_id persisted
  });

  it("deletes the session from the database on logout", async () => {
    query.mockResolvedValueOnce({ rowCount: 1, rows: [] }); // DELETE session

    const res = await request(app)
      .post("/api/auth/logout")
      .set("Authorization", authAs(5));

    expect(res.status).toBe(200);
    const deleteCall = query.mock.calls.find((c) =>
      String(c[0]).includes("DELETE FROM sessions")
    )!;
    expect(deleteCall).toBeDefined();
  });
});
