import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { allTaskIds, idsByStatus, labels } from '../support/contract.mjs';
import { startBackend } from '../support/services.mjs';

const viewport = { width: 1180, height: 800 };
const artifactDir = '.bench-results';
const boardScreenshot = `${artifactDir}/task-board.png`;
const emptyScreenshot = `${artifactDir}/task-board-empty.png`;
let backend;
let vite;
let browser;
let webUrl;
const originalApiUrl = process.env.TASK_BOARD_API_URL;

async function launchBrowser() {
  const failures = [];
  const channels = process.platform === 'win32' ? ['msedge', 'chrome', undefined] : [undefined, 'chrome'];
  for (const channel of channels) {
    try {
      return await chromium.launch({ channel, headless: true, timeout: 8_000 });
    } catch (error) {
      failures.push(error.message);
    }
  }
  throw new Error(`无法启动 Chromium。请安装 Edge、Chrome 或运行 npx playwright install chromium。\n${failures.join('\n')}`);
}

before(async () => {
  await mkdir(artifactDir, { recursive: true });
  await Promise.all([
    rm(boardScreenshot, { force: true }),
    rm(emptyScreenshot, { force: true }),
  ]);
  backend = await startBackend();
  process.env.TASK_BOARD_API_URL = backend.url;
  vite = await createServer({ server: { port: 0, strictPort: true } });
  await vite.listen();
  webUrl = `http://127.0.0.1:${vite.httpServer.address().port}`;
  console.log(`Vite 页面已启动于 ${webUrl}`);
  browser = await launchBrowser();
});

after(async () => {
  try {
    await browser?.close();
  } finally {
    try {
      await vite?.close();
    } finally {
      await backend?.stop();
      if (originalApiUrl === undefined) delete process.env.TASK_BOARD_API_URL;
      else process.env.TASK_BOARD_API_URL = originalApiUrl;
    }
  }
});

async function expectList(page, { status, keyword, ids }, action) {
  const [response] = await Promise.all([
    page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.origin === webUrl && url.pathname === '/api/tasks' && response.request().method() === 'GET';
    }),
    action(),
  ]);
  const url = new URL(response.url());
  assert.deepEqual(url.searchParams.getAll('status'), status ? [status] : []);
  assert.deepEqual(url.searchParams.getAll('q'), keyword ? [keyword] : []);
  assert.equal(response.status(), 200);
  const payload = await response.json();
  assert.deepEqual(payload.items.map(({ id }) => id), ids);
  assert.equal(payload.total, ids.length);
  console.log(`页面 GET ${url.pathname}${url.search} → ${response.status()} ${JSON.stringify(ids)}`);

  await page.waitForFunction((expected) =>
    JSON.stringify(Array.from(document.querySelectorAll('tbody tr[data-task-id]'), (row) => row.dataset.taskId))
      === JSON.stringify(expected), ids);
  const rows = page.locator('tbody tr[data-task-id]');
  for (const [index, item] of payload.items.entries()) {
    const row = rows.nth(index);
    assert.ok(await row.isVisible(), `任务行 ${item.id} 可见`);
    const text = await row.innerText();
    assert.ok(text.includes(item.title) && text.includes(labels[item.status]), `任务行 ${item.id} 显示真实任务`);
  }
  const empty = page.locator('#empty-state');
  await empty.waitFor({ state: ids.length ? 'hidden' : 'visible' });
  if (!ids.length) assert.ok((await empty.innerText()).trim(), '空态需要可见文案');
}

test('页面从真实服务加载列表并支持原有关键字搜索', async () => {
  const page = await browser.newPage({ viewport });
  page.setDefaultTimeout(5_000);
  try {
    await expectList(page, { ids: allTaskIds }, () => page.goto(webUrl));
    await page.getByRole('searchbox', { name: '关键字', exact: true }).fill('例行');
    await expectList(page, { keyword: '例行', ids: ['OPS-107', 'OPS-108', 'OPS-103'] },
      () => page.getByRole('button', { name: '搜索', exact: true }).click());
  } finally {
    await page.close();
  }
});

test('切换状态发送真实请求并联动搜索、空态和重置', async () => {
  const page = await browser.newPage({ viewport });
  page.setDefaultTimeout(5_000);
  let captured = false;
  try {
    await expectList(page, { ids: allTaskIds }, () => page.goto(webUrl));
    const filter = page.getByRole('combobox', { name: '状态', exact: true });
    assert.ok(await filter.isVisible(), '状态筛选需要可见的原生下拉框');
    assert.equal(await filter.inputValue(), '');
    assert.deepEqual(await filter.locator('option').evaluateAll((options) =>
      options.map(({ value, label }) => [value, label])), [['', '全部状态'], ...Object.entries(labels)]);

    for (const [status, ids] of Object.entries(idsByStatus)) {
      await expectList(page, { status, ids }, () => filter.selectOption(status));
    }
    await page.screenshot({ path: boardScreenshot, fullPage: true });
    captured = true;

    const input = page.getByRole('searchbox', { name: '关键字', exact: true });
    const search = page.getByRole('button', { name: '搜索', exact: true });
    await input.fill('OPS-109');
    await expectList(page, { status: 'completed', keyword: 'OPS-109', ids: [] }, () => search.click());
    await page.screenshot({ path: emptyScreenshot, fullPage: true });
    await expectList(page, { status: 'pending', keyword: 'OPS-109', ids: ['OPS-109'] },
      () => filter.selectOption('pending'));
    await expectList(page, { keyword: 'OPS-109', ids: ['OPS-109'] }, () => filter.selectOption(''));
    assert.equal(await input.inputValue(), 'OPS-109');
    await input.fill('');
    await expectList(page, { ids: allTaskIds }, () => search.click());
  } finally {
    if (!captured) {
      await page.screenshot({ path: boardScreenshot, fullPage: true }).catch((error) => console.error(error.message));
    }
    await page.close();
  }
});
