CREATE TABLE IF NOT EXISTS attachments (
  id            SERIAL PRIMARY KEY,
  issue_id      INTEGER      NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  filename      TEXT         NOT NULL,
  original_name TEXT         NOT NULL,
  mime_type     TEXT         NOT NULL DEFAULT 'application/octet-stream',
  size          INTEGER      NOT NULL,
  uploaded_by   INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
