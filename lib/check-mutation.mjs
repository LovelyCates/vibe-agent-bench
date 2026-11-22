import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { assertTaskResponse } from "./check-contract.mjs";
import { readHttp, runNode, waitForService } from "./check-process.mjs";

const reporterUrl = new URL("./check-test-reporter.mjs", import.meta.url).href;
const mutantStore = `export function listTasks(tasks, status) {
  return status === undefined ? tasks : tasks.filter((task) =>
    task.status === status || (status === "completed" && task.id === "T-104"));
}
`;

async function runTests(workspace, tests) {
  const processHandle = runNode([
    "--test", "--test-isolation=none", `--test-reporter=${reporterUrl}`, ...tests,
  ], workspace, { FORCE_COLOR: "0" });
  const result = await processHandle.wait(25_000);
  const outcomes = [];
  for (const line of processHandle.state.stdout.trim().split("\n")) {
    try {
      const event = JSON.parse(line);
      if (event.result === "pass" || event.result === "fail") outcomes.push(event);
    } catch {
      // Preserve unrelated process output in the raw log.
    }
  }
  return { ...result, outcomes, stdout: processHandle.state.stdout, stderr: processHandle.state.stderr };
}

async function probe(workspace, ids) {
  const processHandle = runNode(["backend/server.mjs"], workspace, { PORT: "0" });
  try {
    const { url } = await waitForService(processHandle, "backend");
    const response = await readHttp(`${url}/api/tasks?status=completed`);
    assertTaskResponse(response, ids);
    return { status: "pass", response };
  } catch (error) {
    return { status: "fail", message: error.message, stderr: processHandle.state.stderr };
  } finally {
    await processHandle.close();
  }
}

function key(event, workspace) {
  return JSON.stringify([event.file && relative(workspace, event.file), event.name, event.nesting]);
}

export async function verifyMutation(workspace, tests, trace) {
  trace.tests = tests;
  if (!tests.length) return ["fail", "未发现 Agent 新增或修改的 .test.mjs 文件。"];
  const temporaryParent = await realpath(tmpdir());
  const root = await mkdtemp(join(temporaryParent, "vibe-mutation-"));
  const healthy = join(root, "healthy");
  const mutant = join(root, "mutant");
  try {
    for (const name of ["backend", "frontend", "test"]) {
      await cp(join(workspace, name), join(healthy, name), { recursive: true });
    }
    await cp(healthy, mutant, { recursive: true });
    const storeFile = join(mutant, "backend/task-store.mjs");
    const originalStore = await readFile(storeFile);
    await writeFile(storeFile, mutantStore);

    trace.healthyProbe = await probe(healthy, ["T-102"]);
    if (trace.healthyProbe.status !== "pass") {
      return ["blocked", "健康副本的已完成任务接口不满足契约，无法判定测试辨别力。"];
    }
    trace.mutantProbe = await probe(mutant, ["T-104", "T-102"]);
    if (trace.mutantProbe.status !== "pass") {
      return ["blocked", "变异副本未复现已知缺陷，无法判定测试辨别力。"];
    }

    trace.healthy = await runTests(healthy, tests);
    const healthyTests = trace.healthy.outcomes.filter((event) => !event.skip && !event.todo && event.result === "pass");
    if (trace.healthy.code !== 0 || !healthyTests.length) {
      const error = trace.healthy.timedOut || trace.healthy.error || trace.healthy.code === null;
      return [error ? "error" : "fail", "健康副本的 Agent 测试未全部通过或没有实际执行的测试。"];
    }

    trace.mutant = await runTests(mutant, tests);
    if (trace.mutant.timedOut || trace.mutant.error || trace.mutant.code === null) {
      return ["error", "缺陷副本的测试进程超时或异常退出。"];
    }
    if (trace.mutant.code === 0) {
      return ["fail", "Agent 测试在健康版和缺陷版均通过，未抓住已知缺陷。"];
    }

    const healthyKeys = new Set(healthyTests.map((event) => key(event, healthy)));
    const failures = trace.mutant.outcomes.filter((event) => event.result === "fail"
      && !event.skip && !event.todo && event.failureType !== "subtestsFailed");
    if (!failures.length || !failures.every((event) => event.assertion && healthyKeys.has(key(event, mutant)))) {
      return ["fail", "缺陷副本未产生可归因到健康版通过测试的断言失败。"];
    }
    trace.failedAssertions = failures.map(({ name, message }) => ({ name, message }));

    await writeFile(storeFile, originalStore);
    trace.restored = await runTests(mutant, tests);
    const restoredKeys = new Set(trace.restored.outcomes.filter((event) => !event.skip && !event.todo
      && event.result === "pass").map((event) => key(event, mutant)));
    if (trace.restored.code !== 0 || !failures.every((event) => restoredKeys.has(key(event, mutant)))) {
      return ["blocked", "恢复正常存储后未复现通过结果，无法确认断言失败由已知缺陷引起。"];
    }
    return ["pass", `健康版和恢复版通过，缺陷副本触发 ${failures.length} 项对应断言失败。`];
  } finally {
    if (dirname(root) === temporaryParent) await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
}
