import assert from "node:assert/strict";
import { join } from "node:path";
import { chromium } from "playwright";
import { assertTaskResponse, expectedTaskIds } from "./check-contract.mjs";

export async function launchBrowser() {
  const channels = process.platform === "win32" ? ["msedge", "chrome", undefined] : [undefined, "chrome", "msedge"];
  const failures = [];
  for (const channel of channels) {
    try {
      return await chromium.launch({ channel, headless: true, timeout: 9000 });
    } catch (error) {
      failures.push(error.message);
    }
  }
  throw new Error(`Chromium 无法启动。${failures.join("\n")}`);
}

async function checkSelection(page, baseUrl, status, ids, action, trace) {
  const [response] = await Promise.all([
    page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === "GET" && url.origin === baseUrl && url.pathname === "/api/tasks";
    }),
    action(),
  ]);
  const url = new URL(response.url());
  const result = {
    status: response.status(),
    contentType: await response.headerValue("content-type"),
    body: await response.json(),
  };
  const observation = { status, request: `${url.pathname}${url.search}`, response: result, expectedTaskIds: ids };
  trace.push(observation);
  assert.deepEqual(url.searchParams.getAll("status"), status ? [status] : []);
  assertTaskResponse(result, ids);
  await page.waitForFunction((expected) => {
    const rows = Array.from(document.querySelectorAll("#task-list [data-task-id]"));
    if (JSON.stringify(rows.map((row) => row.dataset.taskId)) !== JSON.stringify(expected)) return false;
    return rows.every((row) => {
      const style = getComputedStyle(row);
      return row.getClientRects().length > 0 && style.visibility === "visible" && Number(style.opacity) > 0;
    });
  }, ids, { timeout: 5000 });
  const received = await page.locator("#task-list [data-task-id]").evaluateAll((rows) => rows.map((row) => ({
    id: row.dataset.taskId,
    text: row.innerText,
  })));
  const emptyState = page.locator("#empty-state");
  await emptyState.waitFor({ state: ids.length ? "hidden" : "visible" });
  observation.rows = received;
  observation.emptyVisible = await emptyState.isVisible();
  assert.deepEqual(received.map(({ id }) => id), ids);
  const labels = { queued: "待处理", running: "进行中", completed: "已完成" };
  for (const [index, row] of received.entries()) {
    const task = result.body.tasks[index];
    assert.ok(row.text.includes(task.title), `任务 ${task.id} 的标题未正确显示`);
    assert.ok(row.text.includes(labels[task.status]) || row.text.includes(task.status),
      `任务 ${task.id} 的状态未正确显示`);
  }
  if (!ids.length) assert.ok((await emptyState.innerText()).trim(), "空列表提示必须有可见文案");
}

export async function probeBrowser(browser, { baseUrl, empty, artifactDir, trace, artifacts }) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 620 } });
  page.setDefaultTimeout(5000);
  page.on("pageerror", (error) => trace.push({ pageError: error.message }));
  const screenshot = empty ? "browser-empty.png" : "browser-filter.png";
  try {
    await checkSelection(page, baseUrl, "", empty ? ["T-104", "T-103", "T-101"] : expectedTaskIds(""),
      () => page.goto(baseUrl), trace);
    const filter = page.locator("select#status-filter");
    assert.equal(await filter.inputValue(), "");
    assert.deepEqual(await filter.locator("option").evaluateAll((options) => options.map((option) => option.value)),
      ["", "queued", "running", "completed"]);
    assert.ok(await page.locator('label[for="status-filter"]').isVisible(), "状态筛选应有关联的可见标签");
    if (empty) {
      await checkSelection(page, baseUrl, "completed", [], () => filter.selectOption("completed"), trace);
    } else {
      for (const status of ["queued", "running", "completed", ""]) {
        await checkSelection(page, baseUrl, status, expectedTaskIds(status), () => filter.selectOption(status), trace);
      }
      await checkSelection(page, baseUrl, "completed", expectedTaskIds("completed"),
        () => filter.selectOption("completed"), trace);
    }
  } finally {
    try {
      await page.screenshot({ path: join(artifactDir, screenshot), timeout: 5000 });
      artifacts.push({ file: screenshot, label: empty ? "空结果截图" : "状态筛选截图" });
    } catch (error) {
      trace.push({ screenshotError: error.message });
    }
    await page.close();
  }
}
