-- Runs after the Chinook load (filename order). Populates pg_class.reltuples
-- so the introspector reports real row counts instead of 0 before first vacuum.
ANALYZE;
