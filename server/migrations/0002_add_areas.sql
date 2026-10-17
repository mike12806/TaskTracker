-- Areas: the level above lists, for keeping work and personal apart.
--
-- Every list belongs to an area, and so does every task: a task in a list is
-- in that list's area (the server keeps tasks.area_id in step with it), and a
-- task with no list is in that area's Inbox. So each area has its own Inbox,
-- which is what lets the app show "Work" without personal errands in it.
--
-- Areas are rows rather than a fixed Work/Personal flag, so a third one is a
-- row, not a migration. Every user gets Personal and Work. Existing lists and
-- tasks go to Personal: nothing here can tell which ones were work, and
-- moving a list to Work moves its tasks with it, so sorting them out is a
-- list edit or two.
CREATE TABLE areas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#5b5dff',
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_areas_user_id ON areas(user_id, position);

-- Nullable only because SQLite cannot add a NOT NULL column without a
-- default. The server always sets both, and the backfill below leaves no NULLs.
ALTER TABLE lists ADD COLUMN area_id INTEGER REFERENCES areas(id);
ALTER TABLE tasks ADD COLUMN area_id INTEGER REFERENCES areas(id);

CREATE INDEX idx_lists_area ON lists(area_id);
CREATE INDEX idx_tasks_area ON tasks(user_id, area_id, completed);

INSERT INTO areas (user_id, name, color, position)
  SELECT id, 'Personal', '#30a46c', 0 FROM users;
INSERT INTO areas (user_id, name, color, position)
  SELECT id, 'Work', '#0090ff', 1 FROM users;

UPDATE lists SET area_id = (
  SELECT a.id FROM areas a WHERE a.user_id = lists.user_id AND a.name = 'Personal'
);
UPDATE tasks SET area_id = (
  SELECT a.id FROM areas a WHERE a.user_id = tasks.user_id AND a.name = 'Personal'
);
