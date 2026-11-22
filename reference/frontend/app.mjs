const labels = { queued: "待处理", running: "进行中", completed: "已完成" };
const taskList = document.querySelector("#task-list");
const emptyState = document.querySelector("#empty-state");
const loadError = document.querySelector("#load-error");
const statusFilter = document.querySelector("#status-filter");
let currentRequest;

function renderTasks(tasks) {
  taskList.replaceChildren(...tasks.map((task) => {
    const row = document.createElement("tr");
    row.dataset.taskId = task.id;
    for (const value of [task.id, task.title, labels[task.status]]) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    }
    return row;
  }));
  emptyState.hidden = tasks.length > 0;
}

async function loadTasks() {
  currentRequest?.abort();
  currentRequest = new AbortController();
  const { signal } = currentRequest;
  const url = new URL("/api/tasks", location.origin);
  if (statusFilter.value) url.searchParams.set("status", statusFilter.value);
  loadError.hidden = true;
  try {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const { tasks } = await response.json();
    if (!signal.aborted) renderTasks(tasks);
  } catch {
    if (!signal.aborted) loadError.hidden = false;
  }
}

statusFilter.addEventListener("change", loadTasks);
await loadTasks();
