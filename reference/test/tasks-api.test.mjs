import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { createBackend } from "../backend/server.mjs";

test("任务 API 返回指定状态的任务", async (context) => {
  const server = createBackend();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  const base = `http://127.0.0.1:${server.address().port}/api/tasks`;

  for (const [status, expected] of [
    ["", ["T-104", "T-103", "T-102", "T-101"]],
    ["queued", ["T-104", "T-101"]],
    ["running", ["T-103"]],
    ["completed", ["T-102"]],
  ]) {
    const url = new URL(base);
    if (status) url.searchParams.set("status", status);
    const response = await fetch(url);
    assert.equal(response.status, 200);
    const { tasks } = await response.json();
    assert.deepEqual(tasks.map((task) => task.id), expected);
  }

  const invalid = await fetch(`${base}?status=invalid`);
  assert.equal(invalid.status, 400);
});
