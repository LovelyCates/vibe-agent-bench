import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { seedTasks } from "./seed.mjs";
import { tasksResponse } from "./tasks-route.mjs";

function sendJson(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

export function createBackend({ seed } = {}) {
  const tasks = seedTasks(seed);
  return createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, { service: "backend", ready: true });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/tasks") {
      const result = tasksResponse(tasks, url);
      sendJson(response, result.status, result.body);
      return;
    }
    sendJson(response, 404, { error: "Not found" });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createBackend({ seed: process.env.TASK_SEED });
  server.listen(Number(process.env.PORT ?? 0), "127.0.0.1", () => {
    console.log(JSON.stringify({ service: "backend", port: server.address().port }));
  });
}
