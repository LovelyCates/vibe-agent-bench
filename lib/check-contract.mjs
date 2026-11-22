import assert from "node:assert/strict";
import { seedTasks } from "../fixture/backend/seed.mjs";
import { readHttp } from "./check-process.mjs";

const taskIds = new Map([
  ["", ["T-104", "T-103", "T-102", "T-101"]],
  ["queued", ["T-104", "T-101"]],
  ["running", ["T-103"]],
  ["completed", ["T-102"]],
]);
const tasksById = new Map(seedTasks().map((task) => [task.id, task]));

export function expectedTaskIds(status) {
  return taskIds.get(status);
}

export function assertTaskResponse(response, ids) {
  assert.equal(response.status, 200);
  assert.match(response.contentType ?? "", /^application\/json\b/i);
  assert.deepEqual(response.body, { tasks: ids.map((id) => tasksById.get(id)) });
}

export async function probeApi(baseUrl, trace) {
  const cases = [];
  for (const [status, ids] of taskIds) {
    const path = `/api/tasks${status ? `?status=${status}` : ""}`;
    cases.push({ path, expected: { taskIds: ids }, verify: (response) => assertTaskResponse(response, ids) });
  }
  for (const query of ["status=unknown", "status=", "status=queued&status=running"]) {
    const path = `/api/tasks?${query}`;
    cases.push({
      path,
      expected: { status: 400 },
      verify(response) {
        assert.equal(response.status, 400, `${path} 应返回 400`);
        assert.match(response.contentType ?? "", /^application\/json\b/i);
        assert.equal(typeof response.body?.error, "string");
      },
    });
  }
  for (const { path, expected, verify } of cases) {
    const observation = { path, expected };
    trace.push(observation);
    try {
      observation.response = await readHttp(`${baseUrl}${path}`);
      verify(observation.response);
    } catch (error) {
      observation.error = error.message;
    }
  }
  return trace.filter(({ error }) => error).length;
}
