import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { allTaskIds, idsByStatus } from '../support/contract.mjs';
import { startBackend } from '../support/services.mjs';

let backend;
const requests = [];

before(async () => {
  backend = await startBackend();
});

after(async () => {
  await backend?.stop();
  await mkdir('.bench-results', { recursive: true });
  await writeFile('.bench-results/api-contract.json', JSON.stringify({ requests }, null, 2) + '\n', 'utf8');
});

async function readTasks(query, expected) {
  const path = query ? `/api/tasks?${query}` : '/api/tasks';
  const response = await fetch(backend.url + path, { signal: AbortSignal.timeout(5_000) });
  const body = await response.json();
  const observed = {
    status: response.status,
    ...(Array.isArray(body.items) ? {
      ids: body.items.map(({ id }) => id),
      statuses: body.items.map(({ status }) => status),
      total: body.total,
    } : {
      code: body.code,
    }),
  };
  requests.push({ method: 'GET', path, expected, observed });
  console.log(`GET ${path} → ${observed.status} ${JSON.stringify(observed.ids ?? observed.code)}`);
  assert.match(response.headers.get('content-type') ?? '', /^application\/json(?:;|$)/iu);
  assert.equal(observed.status, expected.status, `GET ${path} HTTP 状态`);
  if (expected.status === 400) {
    assert.equal(body.code, expected.code);
    assert.ok(typeof body.message === 'string' && body.message.trim(), '错误响应应包含可读的 message');
  } else {
    assert.deepEqual(observed.ids, expected.ids, `GET ${path} 结果编号和顺序`);
    assert.equal(body.total, expected.ids.length);
    for (const item of body.items) {
      assert.ok(item.title && item.owner && Number.isFinite(Date.parse(item.updatedAt)));
      assert.ok(idsByStatus[item.status]?.includes(item.id), `任务 ${item.id} 的状态应当正确`);
      if (expected.filter) assert.equal(item.status, expected.filter);
    }
  }
}

test('不传状态时保留完整列表、搜索和排序', async () => {
  await readTasks('', { status: 200, ids: allTaskIds });
  await readTasks('q=ops-10', { status: 200, ids: allTaskIds });
  await readTasks(`q=${encodeURIComponent('林嘉')}`, { status: 200, ids: ['OPS-109', 'OPS-107'] });
  await readTasks('q=no-matching-task', { status: 200, ids: [] });
});

for (const [filter, ids] of Object.entries(idsByStatus)) {
  test(`按 ${filter} 返回精确匹配并保留默认顺序`, async () => {
    await readTasks(`status=${filter}`, { status: 200, ids, filter });
  });
}

test('状态与已提交关键字同时生效', async () => {
  await readTasks(`status=completed&q=${encodeURIComponent('例行')}`, {
    status: 200, ids: ['OPS-103'], filter: 'completed',
  });
});

test('搜索与筛选没有交集时返回空列表', async () => {
  await readTasks('q=OPS-109&status=completed', { status: 200, ids: [], filter: 'completed' });
});

for (const query of ['status=unknown', 'status=', 'status=Pending', 'status=pending+', 'status=pending&status=pending']) {
  test(`拒绝无效状态参数 ${query}`, async () => {
    await readTasks(query, { status: 400, code: 'INVALID_STATUS' });
  });
}
