import { listTasks } from "./task-store.mjs";

export function tasksResponse(tasks) {
  return { status: 200, body: { tasks: listTasks(tasks) } };
}
