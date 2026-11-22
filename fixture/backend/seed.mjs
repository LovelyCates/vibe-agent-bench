const tasks = [
  { id: "T-104", title: "重新生成每日报表", status: "queued" },
  { id: "T-103", title: "同步历史记录", status: "running" },
  { id: "T-102", title: "汇总审计日志", status: "completed" },
  { id: "T-101", title: "清理过期缓存", status: "queued" },
];

export function seedTasks(name) {
  return tasks.filter((task) => name !== "without-completed" || task.status !== "completed");
}
