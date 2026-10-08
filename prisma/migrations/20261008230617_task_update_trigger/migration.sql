-- State-change notification trigger (TASK-014)
-- Emits pg_notify('task_updates', {"id","status","progress"}) on every Task UPDATE.
-- Notifications are hints only; PostgreSQL remains the source of truth.

CREATE OR REPLACE FUNCTION awty_notify_task_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  payload json;
BEGIN
  payload := json_build_object(
    'id', NEW."id",
    'status', NEW."status"::text,
    'progress', NEW."progress"
  );
  PERFORM pg_notify('task_updates', payload::text);
  RETURN NEW;
END;
$$;

CREATE TRIGGER task_update_notify
AFTER UPDATE ON "Task"
FOR EACH ROW
EXECUTE FUNCTION awty_notify_task_update();
