import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { launchBrowser } from './check-browser.mjs';
import { runNode } from './check-process.mjs';
import { redactLog } from './run-events.mjs';

const first = 'ORD-20261123-001';
const second = 'ORD-20261123-002';
const pageTwo = 'ORD-20261119-002';
const browserArtifact = { file: 'target-browser.json', label: '订单详情页浏览器验收' };
const buildArtifact = { file: 'target-build.json', label: '前端单测、类型检查和构建结果' };
const mutationArtifact = { file: 'target-mutation.json', label: '订单详情缺陷测试辨别力' };

function saveReport(artifactDir, file, body) {
  return writeFile(join(artifactDir, file), JSON.stringify(body, null, 2) + '\n');
}

function dependency(frontend, file) {
  return join(frontend, 'node_modules', file);
}

async function command(frontend, args, signal, timeoutMs = 90_000) {
  signal?.throwIfAborted();
  const handle = runNode(args, frontend, { FORCE_COLOR: '0', CI: '1' });
  const abort = () => void handle.close();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const result = await handle.wait(timeoutMs);
    signal?.throwIfAborted();
    return {
      ...result,
      stdout: redactLog(handle.state.stdout).slice(-40_000),
      stderr: redactLog(handle.state.stderr).slice(-40_000),
    };
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}

async function vitest(frontend, signal, tests = [], jsonPath) {
  return command(frontend, [dependency(frontend, 'vitest/vitest.mjs'), 'run',
    ...(jsonPath ? ['--reporter=json', '--outputFile=' + jsonPath] : []), ...tests], signal);
}

async function buildFrontend(frontend, artifactDir, report, signal) {
  await report('build', 'running', '运行项目 Vitest、类型检查和生产构建。', []);
  const result = {
    tests: await vitest(frontend, signal),
    types: await command(frontend, [dependency(frontend, 'vue-tsc/bin/vue-tsc.js'), '--build'], signal),
    bundle: await command(frontend, [dependency(frontend, 'vite/bin/vite.js'), 'build'], signal),
  };
  await saveReport(artifactDir, buildArtifact.file, result);
  const failed = [['单元测试', result.tests], ['类型检查', result.types], ['生产构建', result.bundle]]
    .filter(([, step]) => step.code !== 0).map(([name]) => name);
  await report('build', failed.length ? 'fail' : 'pass',
    failed.length ? '未通过 ' + failed.join('、') + '。' : '项目单元测试、类型检查和生产构建通过。', [buildArtifact]);
  return result.bundle.code === 0;
}

async function startVite(frontend, signal, preview) {
  signal?.throwIfAborted();
  const args = [dependency(frontend, 'vite/bin/vite.js'), ...(preview ? ['preview'] : []),
    '--host', '127.0.0.1', '--port', '0', '--strictPort'];
  const handle = runNode(args, frontend, { FORCE_COLOR: '0', CI: '1' });
  const abort = () => void handle.close();
  signal?.addEventListener('abort', abort, { once: true });
  const close = async () => {
    signal?.removeEventListener('abort', abort);
    await handle.close();
  };
  try {
    const deadline = Date.now() + 20_000;
    while (!handle.state.result && Date.now() < deadline) {
      signal?.throwIfAborted();
      const match = /http:\/\/127\.0\.0\.1:(\d+)\//u.exec(redactLog(handle.state.stdout));
      if (match) {
        const url = 'http://127.0.0.1:' + match[1];
        if ((await fetch(url, { signal: AbortSignal.timeout(1000) }).catch(() => null))?.ok) return { url, close };
      }
      await delay(120, undefined, { signal });
    }
    throw new Error('Vite 未能启动。 ' + redactLog(handle.state.stderr || handle.state.stdout).slice(-900));
  } catch (error) {
    await close();
    throw error;
  }
}

function orderUrl(url, id) {
  return url + '/orders/' + id;
}

const orderPath = (id) => (url) => url.pathname === '/orders/' + id;
const ordersPath = (url) => url.pathname === '/orders';

function field(page, label) {
  return page.getByRole('textbox', { name: label, exact: true });
}

function orderLink(page, id) {
  return page.getByRole('link', { name: new RegExp(id, 'u') });
}

async function detail(page, id, name, amount, { product, channel, date, status } = {}) {
  await page.waitForURL(orderPath(id));
  await page.getByText(name, { exact: true }).first().waitFor();
  const content = await page.locator('main').innerText();
  for (const value of [name, product, channel, date, status].filter(Boolean)) {
    assert.ok(content.includes(value), '详情区缺少 ' + value);
  }
  assert.match(content, new RegExp(id, 'u'));
  assert.match(content.replace(/[,，\u00a0]/gu, ''), new RegExp('(?<!\\d)' + amount + '(?!\\d)', 'u'));
}

async function backToOrders(page) {
  await page.getByRole('link', { name: /返回.*订单|返回列表/u })
    .or(page.getByRole('button', { name: /返回.*订单|返回列表/u })).first().click();
  await page.waitForURL(ordersPath);
  await page.getByRole('heading', { name: '订单管理' }).waitFor();
}

async function browserEvidence(frontend, artifactDir, report, signal) {
  await report('browser', 'running', '在独立浏览器验证详情、导航、筛选和移动端。', []);
  const trace = { checks: [], pageErrors: [] };
  const artifacts = [browserArtifact];
  let server, browser;
  try {
    server = await startVite(frontend, signal, true);
    browser = await launchBrowser();
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(5000);
    page.on('pageerror', (error) => trace.pageErrors.push(redactLog(error.message)));
    const { url } = server;
    async function check(name, fn) {
      signal?.throwIfAborted();
      try {
        await fn();
        trace.checks.push({ name, status: 'pass' });
      } catch (error) {
        trace.checks.push({ name, status: 'fail', error: redactLog(error.message).slice(0, 1600) });
      }
    }
    async function screen(file, label) {
      await page.screenshot({ path: join(artifactDir, file), timeout: 5000 });
      artifacts.push({ file, label });
    }
    const fields = { product: '专业协作年包', channel: '在线商城', date: '2026-11-23', status: '已完成' };
    await check('已知订单可直达并刷新，详情字段正确', async () => {
      assert.equal((await page.goto(orderUrl(url, first)))?.status(), 200);
      await detail(page, first, '元气设计', 7280, fields);
      assert.equal((await page.reload())?.status(), 200);
      await detail(page, first, '元气设计', 7280, fields);
      await screen('target-order-desktop.png', '订单详情桌面截图');
    });
    await check('查询第二笔订单返回对应客户和 3,640 元', async () => {
      await page.goto(orderUrl(url, second));
      await detail(page, second, '松野科技', 3640);
    });
    await check('未知编号显示错误并能返回订单管理', async () => {
      await page.goto(orderUrl(url, 'ORD-20261123-999'));
      await page.getByText('订单不存在', { exact: false }).first().waitFor();
      await screen('target-order-missing.png', '未知订单截图');
      await backToOrders(page);
    });
    await check('从运营总览用键盘打开近期订单', async () => {
      await page.goto(url);
      const link = orderLink(page, first).first();
      await link.focus();
      assert.equal(await link.evaluate((node) => node === document.activeElement), true);
      await link.press('Enter');
      await detail(page, first, '元气设计', 7280);
    });
    await check('从订单第 2 页打开后返回，仍显示第 9–16 条', async () => {
      await page.goto(url + '/orders');
      await page.locator('.el-pager').getByText('2', { exact: true }).click();
      await orderLink(page, pageTwo).click();
      await page.waitForURL(orderPath(pageTwo));
      await backToOrders(page);
      await page.getByRole('status').filter({ hasText: /9\s*[–—-]\s*16.*50/u }).waitFor();
      await orderLink(page, pageTwo).waitFor();
    });
    await check('返回后恢复松野科技搜索与处理中筛选', async () => {
      await page.goto(url + '/orders');
      await field(page, '搜索订单').fill('松野科技');
      await page.getByRole('combobox', { name: '订单状态' }).press('Enter');
      await page.getByRole('option', { name: '处理中', exact: true }).click();
      await orderLink(page, second).click();
      await detail(page, second, '松野科技', 3640);
      await backToOrders(page);
      assert.equal(await field(page, '搜索订单').inputValue(), '松野科技');
      await page.locator('.status-field').getByText('处理中', { exact: true }).waitFor();
      await page.getByRole('status').filter({ hasText: /共\s*1\s*条/u }).waitFor();
      await orderLink(page, second).waitFor();
    });
    await check('390px 可阅读和返回且整页无横向溢出', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(orderUrl(url, first));
      await detail(page, first, '元气设计', 7280);
      const viewport = await page.evaluate(() => ({
        width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth,
      }));
      assert.ok(viewport.scrollWidth <= viewport.width + 1, '页面宽度超过 390px 视口');
      await screen('target-order-mobile.png', '订单详情手机截图');
      await backToOrders(page);
    });
    if (trace.checks.some(({ status }) => status === 'fail') && !artifacts.some(({ file }) => file === 'target-order-desktop.png')) {
      await screen('target-order-failure.png', '浏览器验收现场截图').catch(() => {});
    }
  } catch (error) {
    trace.error = redactLog(error.message).slice(0, 1800);
  } finally {
    await browser?.close();
    await server?.close();
  }
  await saveReport(artifactDir, browserArtifact.file, trace);
  const failures = trace.checks.filter(({ status }) => status === 'fail');
  const status = trace.error ? 'error' : failures.length || trace.pageErrors.length ? 'fail' : 'pass';
  await report('browser', status, trace.error || (status === 'pass'
    ? '真实浏览器 ' + trace.checks.length + ' 项通过，已保存桌面和手机截图。'
    : failures.length + ' 个流程断言失败、' + trace.pageErrors.length + ' 个脚本错误。'), artifacts);
  return trace.checks.some(({ name, status }) => name.startsWith('查询第二笔订单') && status === 'pass');
}

export async function verifyTestTarget({ workspace, artifactDir, report, signal, newTests = [] }) {
  const frontend = join(workspace, 'workspace/frontend');
  const built = await buildFrontend(frontend, artifactDir, report, signal);
  if (!built) {
    await report('browser', 'blocked', '生产构建没有产物，浏览器验收无法开始。', []);
    await report('mutation', 'blocked', '生产构建没有产物，无法独立核验缺陷行为。', []);
    return;
  }
  const healthyLookup = await browserEvidence(frontend, artifactDir, report, signal);
  await scoreMutation(frontend, artifactDir, report, signal, newTests, healthyLookup);
}

async function firstOrderMutation(frontend, source) {
  const packageUrl = pathToFileURL(dependency(frontend, 'typescript/lib/typescript.js')).href;
  const { default: ts } = await import(packageUrl);
  const syntax = ts.createSourceFile('order-details.ts', source, ts.ScriptTarget.Latest, true);
  const bodies = [];
  for (const statement of syntax.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === 'getOrderById' && statement.body) {
      bodies.push(statement.body);
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const { name, initializer } of statement.declarationList.declarations) {
      if (ts.isIdentifier(name) && name.text === 'getOrderById' && initializer
        && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) bodies.push(initializer.body);
    }
  }
  if (bodies.length !== 1 || source.includes('__benchFirstOrder')) return null;
  const [body] = bodies;
  const replacement = ts.isBlock(body) ? '{ return __benchFirstOrder[0] }' : '__benchFirstOrder[0]';
  return "import { orders as __benchFirstOrder } from './operations'\n"
    + source.slice(0, body.getStart(syntax)) + replacement + source.slice(body.getEnd());
}

async function mutationProbe(frontend, signal) {
  let server, browser;
  try {
    server = await startVite(frontend, signal, false);
    browser = await launchBrowser();
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    await page.goto(orderUrl(server.url, second));
    await page.getByText('元气设计', { exact: true }).first().waitFor();
    const text = (await page.locator('main').innerText()).replace(/[,，\u00a0]/gu, '');
    assert.match(text, /(?<!\d)7280(?!\d)/u);
    assert.ok(!text.includes('松野科技'));
    return { status: 'pass', requestId: second, observedCustomer: '元气设计', observedAmount: 7280 };
  } catch (error) {
    signal?.throwIfAborted();
    return { status: 'fail', message: redactLog(error.message).slice(0, 1600) };
  } finally {
    await browser?.close();
    await server?.close();
  }
}

function selectedTests(newTests) {
  return newTests.map((file) => file.replaceAll('\\', '/')).filter((file) =>
    /^workspace\/frontend\/src\/[^*?<>:"|]+\.(?:spec|test)\.[cm]?[jt]sx?$/u.test(file)
    && !file.split('/').includes('..')).map((file) => file.slice('workspace/frontend/'.length));
}

async function focusedTests(frontend, root, label, tests, signal) {
  const jsonPath = join(root, label + '.json');
  const result = await vitest(frontend, signal, tests, jsonPath);
  let raw;
  try {
    raw = JSON.parse(await readFile(jsonPath, 'utf8'));
  } catch {
    return { ...result, outcomes: [] };
  }
  const outcomes = (raw.testResults ?? []).flatMap((suite) => {
    if (typeof suite.name !== 'string') return [];
    const file = relative(frontend, suite.name).split(sep).join('/');
    if (!tests.includes(file)) return [];
    return (suite.assertionResults ?? []).map((test) => ({
      file,
      name: redactLog(test.fullName ?? test.title ?? ''),
      result: test.status === 'passed' ? 'pass' : test.status === 'failed' ? 'fail' : test.status,
      message: redactLog((test.failureMessages ?? []).join('\n')).slice(0, 1800),
    }));
  });
  return { ...result, outcomes };
}

async function mutationTrial(frontend, root, trace, signal) {
  const candidate = join(root, 'frontend');
  await cp(frontend, candidate, {
    recursive: true,
    filter: (source) => !['node_modules', 'dist', '.git'].includes(basename(source)),
  });
  await symlink(dependency(frontend, ''), dependency(candidate, ''), process.platform === 'win32' ? 'junction' : 'dir');
  const module = join(candidate, 'src/data/order-details.ts');
  const source = await readFile(module, 'utf8');
  const mutant = await firstOrderMutation(candidate, source);
  if (!mutant) return ['blocked', '无法唯一定位约定的 getOrderById 实现。'];

  trace.healthy = await focusedTests(candidate, root, 'healthy', trace.tests, signal);
  const identity = ({ file, name }) => JSON.stringify([file, name]);
  const successful = ({ outcomes }) => new Set(outcomes.filter(({ result }) => result === 'pass').map(identity));
  const healthy = successful(trace.healthy);
  if (trace.healthy.code !== 0 || !healthy.size) return ['fail', '新增测试在健康副本未通过，或未记录执行结果。'];

  await writeFile(module, mutant);
  trace.mutantProbe = await mutationProbe(candidate, signal);
  if (trace.mutantProbe.status !== 'pass') return ['blocked', '独立浏览器未复现查询第二笔订单却得到第一笔订单数据的缺陷。'];

  trace.mutant = await focusedTests(candidate, root, 'mutant', trace.tests, signal);
  if (trace.mutant.code === 0) return ['fail', '新增测试仍通过，未抓住已复现的错误订单。'];
  if (trace.mutant.code === null) return ['error', '缺陷副本的测试未正常返回退出码。'];
  const failures = trace.mutant.outcomes.filter(({ result }) => result === 'fail');
  if (!failures.length || !failures.every((test) => healthy.has(identity(test)) && /AssertionError/u.test(test.message))) {
    return ['fail', '缺陷副本没有产生与健康版对应的测试断言失败。'];
  }
  trace.failedAssertions = failures.map(({ name, message }) => ({ name, message }));

  await writeFile(module, source);
  trace.restored = await focusedTests(candidate, root, 'restored', trace.tests, signal);
  const restored = successful(trace.restored);
  if (trace.restored.code !== 0 || !failures.every((test) => restored.has(identity(test)))) {
    return ['blocked', '恢复模块后未复现健康版通过结果。'];
  }
  return ['pass', '已独立复现缺陷，健康和恢复副本通过，缺陷副本触发 ' + failures.length + ' 条对应断言。'];
}

async function scoreMutation(frontend, artifactDir, report, signal, newTests, healthyLookup) {
  const trace = { tests: selectedTests(newTests), mutation: 'getOrderById 总返回第一笔订单' };
  let result;
  if (!trace.tests.length) result = ['fail', '未发现 Agent 新增的前端测试。'];
  else if (!healthyLookup) result = ['blocked', '健康页面未验证通过第二笔订单，无法区分已知缺陷。'];
  else {
    await report('mutation', 'running', '对比新增测试在健康、缺陷和恢复副本中的断言。', []);
    const parent = await realpath(tmpdir());
    const root = await mkdtemp(join(parent, 'vibe-target-mutation-'));
    try {
      result = await mutationTrial(frontend, root, trace, signal);
    } catch (error) {
      signal?.throwIfAborted();
      trace.error = redactLog(error.message).slice(0, 1600);
      result = ['blocked', '无法完成独立缺陷试验。'];
    } finally {
      if (dirname(root) === parent && basename(root).startsWith('vibe-target-mutation-')) {
        await rm(root, { recursive: true, force: true, maxRetries: 5 });
      }
    }
  }
  trace.status = result[0];
  trace.summary = result[1];
  await saveReport(artifactDir, mutationArtifact.file, trace);
  await report('mutation', ...result, [mutationArtifact]);
}
