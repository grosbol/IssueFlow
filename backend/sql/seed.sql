INSERT INTO users (name, email, role, locale)
VALUES
  ('Alex Jensen', 'alex@issueflow.local', 'admin', 'da-DK'),
  ('Mia Larsen', 'mia@issueflow.local', 'user', 'da-DK'),
  ('Jonas Holm', 'jonas@issueflow.local', 'user', 'da-DK'),
  ('Eddie Grosbol-Rais', 'grosbol@gmail.com', 'admin', 'da-DK')
ON CONFLICT (email) DO UPDATE SET role = EXCLUDED.role, locale = EXCLUDED.locale;

INSERT INTO workflows (id, name)
VALUES (1, 'Product Delivery')
ON CONFLICT (id) DO NOTHING;

INSERT INTO statuses (id, workflow_id, name, color, sort_order)
VALUES
  (1, 1, 'Todo', '#64748b', 1),
  (2, 1, 'In Progress', '#2563eb', 2),
  (3, 1, 'Review', '#f59e0b', 3),
  (4, 1, 'Blocked', '#dc2626', 4),
  (5, 1, 'Done', '#16a34a', 5)
ON CONFLICT (id) DO NOTHING;

INSERT INTO workflow_transitions (workflow_id, from_status_id, to_status_id)
VALUES
  (1, 1, 2),
  (1, 2, 3),
  (1, 2, 4),
  (1, 3, 2),
  (1, 3, 5),
  (1, 4, 2)
ON CONFLICT (from_status_id, to_status_id) DO NOTHING;

INSERT INTO projects (id, name, key, workflow_id)
VALUES (1, 'IssueFlow', 'IF', 1)
ON CONFLICT (id) DO NOTHING;

INSERT INTO issues (id, project_id, title, description, status_id, assignee_id, reporter_id, priority, due_date)
VALUES
  (1, 1, 'Design board experience', 'Create the kanban overview for the MVP.', 2, 1, 2, 'high', CURRENT_DATE + INTERVAL '3 days'),
  (2, 1, 'Guard workflow transitions', 'Reject invalid status changes in the API.', 3, 2, 1, 'high', CURRENT_DATE + INTERVAL '1 day'),
  (3, 1, 'Dockerize local setup', 'Prepare on-prem friendly deployment via Docker Compose.', 1, 3, 1, 'medium', CURRENT_DATE + INTERVAL '7 days'),
  (4, 1, 'Investigate SSO later', 'Nice-to-have after the MVP is stable.', 4, 1, 3, 'low', NULL)
ON CONFLICT (id) DO UPDATE SET due_date = EXCLUDED.due_date;

INSERT INTO labels (project_id, name, color)
SELECT *
FROM (
  VALUES
    (1, 'frontend', '#0f766e'),
    (1, 'backend', '#1d4ed8'),
    (1, 'ops', '#7c3aed'),
    (1, 'research', '#b45309'),
    (1, 'ux', '#be185d')
) AS seed(project_id, name, color)
WHERE NOT EXISTS (
  SELECT 1
  FROM labels l
  WHERE l.project_id = seed.project_id
    AND lower(l.name) = lower(seed.name)
);

INSERT INTO issue_labels (issue_id, label_id)
SELECT seed.issue_id, l.id
FROM (
  VALUES
    (1, 'frontend'),
    (1, 'ux'),
    (2, 'backend'),
    (3, 'ops'),
    (4, 'research')
) AS seed(issue_id, label_name)
JOIN labels l
  ON l.project_id = 1
 AND lower(l.name) = lower(seed.label_name)
ON CONFLICT DO NOTHING;

INSERT INTO comments (issue_id, user_id, content)
SELECT *
FROM (
  VALUES
    (1, 2, 'The board should load fast and keep the card chrome minimal.'),
    (2, 1, 'We only need project-level workflows for the first release.'),
    (3, 3, 'Compose is enough for now. Kubernetes can wait.')
) AS seed(issue_id, user_id, content)
WHERE NOT EXISTS (
  SELECT 1
  FROM comments c
  WHERE c.issue_id = seed.issue_id
    AND c.user_id = seed.user_id
    AND c.content = seed.content
);

INSERT INTO issue_history (issue_id, actor_id, field, from_value, to_value)
SELECT *
FROM (
  VALUES
    (1, 2, 'status', 'Todo', 'In Progress'),
    (2, 1, 'status', 'In Progress', 'Review'),
    (4, 3, 'status', 'In Progress', 'Blocked')
) AS seed(issue_id, actor_id, field, from_value, to_value)
WHERE NOT EXISTS (
  SELECT 1
  FROM issue_history h
  WHERE h.issue_id = seed.issue_id
    AND h.actor_id = seed.actor_id
    AND h.field = seed.field
    AND COALESCE(h.from_value, '') = COALESCE(seed.from_value, '')
    AND COALESCE(h.to_value, '') = COALESCE(seed.to_value, '')
);

-- Advance all sequences past the seeded IDs so inserts don't collide
SELECT setval(pg_get_serial_sequence('users',         'id'), GREATEST((SELECT MAX(id) FROM users),         1));
SELECT setval(pg_get_serial_sequence('workflows',     'id'), GREATEST((SELECT MAX(id) FROM workflows),     1));
SELECT setval(pg_get_serial_sequence('statuses',      'id'), GREATEST((SELECT MAX(id) FROM statuses),      1));
SELECT setval(pg_get_serial_sequence('projects',      'id'), GREATEST((SELECT MAX(id) FROM projects),      1));
SELECT setval(pg_get_serial_sequence('issues',        'id'), GREATEST((SELECT MAX(id) FROM issues),        1));
SELECT setval(pg_get_serial_sequence('labels',        'id'), GREATEST((SELECT MAX(id) FROM labels),        1));
SELECT setval(pg_get_serial_sequence('comments',      'id'), GREATEST((SELECT MAX(id) FROM comments),      1));
SELECT setval(pg_get_serial_sequence('issue_history', 'id'), GREATEST((SELECT MAX(id) FROM issue_history), 1));
