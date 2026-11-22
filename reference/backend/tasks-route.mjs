import { listTasks } from "./task-store.mjs";

const statuses = new Set(["queued", "running", "completed"]);

export function tasksResponse(tasks, url) {
  const values = url.searchParams.getAll("status");
  const [status] = values;
  if (values.length > 1 || (status !== undefined && !statuses.has(status))) {
    return { status: 400, body: { error: "Invalid status" } };
  }
  return { status: 200, body: { tasks: listTasks(tasks, status) } };
}
