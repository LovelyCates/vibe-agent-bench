export function listTasks(tasks, status) {
  return status === undefined ? tasks : tasks.filter((task) => task.status === status);
}
