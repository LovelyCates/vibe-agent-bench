const filterLabels = new Map([
  ['', '全部'],
  ['pending', '待处理'],
  ['queued', '待处理'],
  ['running', '进行中'],
  ['completed', '已完成'],
]);

const mutationPhases = [
  ['healthy', '健康副本'],
  ['mutant', '缺陷副本'],
  ['restored', '恢复副本'],
];

const missing = '未记录';

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasText(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function httpStatus(status) {
  return Number.isInteger(status) ? `HTTP ${status}` : missing;
}

function taskIds(ids) {
  if (!Array.isArray(ids)) return missing;
  if (!ids.length) return '空列表';
  return ids.map((id) => hasText(id) ? id : '—').join('、');
}

function responseTaskIds(response) {
  const tasks = response?.body?.tasks;
  return Array.isArray(tasks) ? taskIds(tasks.map((task) => task?.id)) : '—';
}

function payload(response, ui) {
  if (response?.body === undefined) return null;
  const body = response.body;
  const isText = typeof body === 'string';
  return ui.section('响应正文', ui.code(isText ? body : JSON.stringify(body, null, 2), isText ? 'response.txt' : 'response.json'));
}

function errorDetails(label, message, ui) {
  return ui.details(label, ui.code(message, 'error.log'));
}

function apiEvidence(data, ui) {
  const trace = Array.isArray(data.trace) ? data.trace : null;
  const requests = trace?.filter((entry) => hasText(entry?.path)) ?? [];
  if ((!trace || (trace.length && !requests.length)) && !hasText(data.error)) return null;

  const errors = requests.filter((entry) => hasText(entry.error)).length;
  const failed = Number.isInteger(data.failed) && data.failed >= errors && data.failed <= trace?.length ? data.failed : errors;
  const completed = trace?.length === requests.length && data.failed === errors && !hasText(data.error);
  const observations = requests.map((entry) => {
    if (hasText(entry.error)) return [entry, 'fail', '失败'];
    const expected = entry.expected?.status ?? (Array.isArray(entry.expected?.taskIds) ? 200 : null);
    if (completed && Number.isInteger(expected) && entry.response?.status === expected) return [entry, 'pass', '通过'];
    return [entry, 'pending', Number.isInteger(entry.response?.status) ? '已收到响应' : '结果未记录'];
  });
  const passed = observations.filter(([, status]) => status === 'pass').length;
  const pending = observations.some(([, status]) => status === 'pending');
  const view = ui.element('div', 'evidence-validation');
  view.append(ui.metrics([
    ['请求记录', requests.length],
    ['通过', !passed && pending ? missing : passed, passed ? 'pass' : undefined],
    ['失败', failed, failed ? 'fail' : undefined],
  ]));
  if (hasText(data.error)) view.append(errorDetails('API 检查异常', data.error, ui));
  if (!requests.length) view.append(ui.note('没有记录到 API 请求。'));
  if (trace && trace.length > requests.length) view.append(ui.note('部分请求缺少路径，完整记录可在原始 JSON 中查看。'));

  const entries = observations.map(([{ path, method, expected, response, error }, status, label]) => {
    const request = `${hasText(method) ? method : 'GET'} ${path}`;
    const actual = httpStatus(response?.status);
    const facts = [['结果', ui.badge(status, label)], ['实际状态', actual]];
    if (Number.isInteger(expected?.status)) facts.push(['预期状态', httpStatus(expected.status)]);
    if (Array.isArray(expected?.taskIds)) facts.push(['预期任务', taskIds(expected.taskIds)]);
    if (Array.isArray(response?.body?.tasks)) facts.push(['返回任务', responseTaskIds(response)]);
    if (hasText(response?.contentType)) facts.push(['响应类型', response.contentType]);
    const children = [ui.facts(facts)];
    if (hasText(error)) children.push(ui.section('请求或断言错误', ui.code(error, 'error.log')));
    const body = payload(response, ui);
    if (body) children.push(body);
    return ui.details(`${request} · ${actual} · ${label}`, ...children);
  });
  if (entries.length) view.append(ui.section('请求与断言', ...entries));
  return view;
}

function filterName(status) {
  return filterLabels.get(status) ?? (hasText(status) ? status : missing);
}

function projectContractComparison(expected, observed) {
  const statusRecorded = Number.isInteger(expected?.status) && Number.isInteger(observed?.status);
  const rows = [['HTTP 状态', httpStatus(expected?.status), httpStatus(observed?.status),
    statusRecorded ? observed.status === expected.status : null]];

  if (Array.isArray(expected?.ids) || Array.isArray(observed?.ids)) {
    const idsRecorded = Array.isArray(expected?.ids) && Array.isArray(observed?.ids);
    const total = Number.isInteger(observed?.total) ? observed.total : null;
    const expectedTotal = Array.isArray(expected?.ids) ? expected.ids.length : null;
    rows.push(['任务编号和顺序', taskIds(expected?.ids), taskIds(observed?.ids), idsRecorded
      ? expected.ids.length === observed.ids.length && expected.ids.every((id, index) => id === observed.ids[index]) : null]);
    rows.push(['返回条数', expectedTotal ?? missing, total ?? missing,
      expectedTotal !== null && total !== null ? expectedTotal === total : null]);
  }
  if (hasText(expected?.filter) || Array.isArray(observed?.statuses)) {
    const statuses = Array.isArray(observed?.statuses) ? observed.statuses : null;
    const filter = hasText(expected?.filter) ? expected.filter : null;
    const matches = filter && statuses && Array.isArray(observed?.ids)
      ? statuses.length === observed.ids.length && statuses.every((status) => status === filter) : null;
    rows.push(['任务状态', filter ?? '—', statuses ? taskIds(statuses) : missing, filter ? matches : undefined]);
  }
  if (hasText(expected?.code) || hasText(observed?.code)) {
    rows.push(['错误代码', expected?.code ?? missing, observed?.code ?? missing,
      hasText(expected?.code) && hasText(observed?.code) ? expected.code === observed.code : null]);
  }

  const comparisons = rows.map(([, , , matches]) => matches);
  const state = comparisons.includes(false) ? 'fail' : comparisons.includes(null) ? 'pending' : 'pass';
  return { state, rows };
}

function projectApiEvidence(data, ui) {
  if (!Array.isArray(data.requests)) return null;
  const requests = data.requests.filter((entry) => hasText(entry?.path));
  if (!requests.length && data.requests.length) return null;

  const labels = { pass: '记录相符', fail: '记录有差异', pending: '记录不完整' };
  const counts = { pass: 0, fail: 0, pending: 0 };
  const entries = requests.map(({ method, path, expected, observed }) => {
    const request = hasText(method) ? `${method} ${path}` : path;
    const { state, rows } = projectContractComparison(expected, observed);
    counts[state] += 1;
    const matrix = rows.map(([field, target, actual, matches]) => [field, target, actual,
      matches === true ? ui.badge('pass', '相符') : matches === false ? ui.badge('fail', '有差异') : '—']);
    return ui.details(`${request} · ${httpStatus(observed?.status)} · ${labels[state]}`,
      ui.table(['响应字段', '预期', '实际', '对照'], matrix, `${request} 响应对照`));
  });

  const view = ui.element('div', 'evidence-validation');
  view.append(ui.metrics([
    ['请求记录', requests.length],
    [labels.pass, counts.pass, counts.pass ? 'pass' : undefined],
    [labels.fail, counts.fail, counts.fail ? 'fail' : undefined],
    ...(counts.pending ? [[labels.pending, counts.pending, 'pending']] : []),
  ]));
  if (entries.length) {
    view.append(ui.note('这里对照已记录的响应字段。完整测试结果见验收检查。'));
    view.append(ui.section('API 请求与响应对照', ...entries));
  } else {
    view.append(ui.note('没有记录到 API 请求。'));
  }
  return view;
}

function browserEvidence(data, ui, context) {
  const trace = Array.isArray(data.trace) ? data.trace : null;
  const steps = trace?.filter((entry) => hasText(entry?.request)) ?? [];
  const exceptions = [];
  if (hasText(data.error)) exceptions.push(['浏览器检查异常', data.error]);
  for (const entry of trace ?? []) {
    if (hasText(entry?.pageError)) exceptions.push(['页面脚本错误', entry.pageError]);
    if (hasText(entry?.screenshotError)) exceptions.push(['截图失败', entry.screenshotError]);
  }
  if ((!trace || (trace.length && !steps.length)) && !exceptions.length) return null;

  const view = ui.element('div', 'evidence-validation');
  view.append(ui.metrics([
    ['网络请求', steps.length],
    ['页面观测', steps.filter((entry) => Array.isArray(entry.rows)).length],
    ['异常记录', exceptions.length, exceptions.length ? 'error' : undefined],
  ]));
  if (exceptions.length) view.append(ui.section('异常详情', ...exceptions.map(([label, message]) => errorDetails(label, message, ui))));
  if (steps.length) {
    const rows = steps.map((step, index) => [
      `${index + 1}. ${filterName(step.status)}`,
      ui.element('code', '', step.request),
      httpStatus(step.response?.status),
      Array.isArray(step.rows) ? step.rows.length : missing,
      typeof step.emptyVisible === 'boolean' ? (step.emptyVisible ? '可见' : '隐藏') : missing,
    ]);
    view.append(ui.section('筛选记录', ui.table(['筛选选项', '请求路径', '响应状态', '页面行数', '空列表提示'], rows)));
  } else {
    view.append(ui.note('没有记录到浏览器筛选请求。'));
  }

  const screenshots = [
    ['browser-filter.png', '状态筛选截图'],
    ['browser-empty.png', '空结果截图'],
  ].map(([file, label]) => context?.artifactImage?.(file, label)).filter(Boolean);
  if (screenshots.length) view.append(ui.section('页面截图', ...screenshots));
  if (steps.length) view.append(ui.section('网络与页面详情', ...steps.map((step, index) => browserStep(step, index, ui))));
  const services = [
    ['browser-empty-backend.json', '空结果场景后端启动日志'],
    ['browser-empty-frontend.json', '空结果场景前端启动日志'],
  ].map(([file, label]) => context?.artifactLink?.(file, label)).filter(Boolean);
  if (services.length) view.append(ui.section('相关服务日志', ...services));
  return view;
}

function browserStep({ status, request, response, expectedTaskIds, rows }, index, ui) {
  const facts = [
    ['请求路径', request],
    ['预期页面任务', taskIds(expectedTaskIds)],
    ['返回任务', responseTaskIds(response)],
  ];
  if (hasText(response?.contentType)) facts.push(['响应类型', response.contentType]);
  const children = [ui.facts(facts)];
  if (Array.isArray(rows)) {
    const dom = rows.length
      ? ui.table(['任务编号', '页面文本'], rows.map((row) => [row?.id ?? '—', row?.text ?? '—']))
      : ui.note('页面未显示任务行。');
    children.push(ui.section('页面行', dom));
  }
  const body = payload(response, ui);
  if (body) children.push(body);
  return ui.details(`${index + 1}. ${filterName(status)} · ${httpStatus(response?.status)}`, ...children);
}

function outcomeStatus(outcome) {
  if (outcome.skip) return ['skipped', '跳过'];
  if (outcome.todo) return ['pending', '待完成'];
  if (outcome.result === 'pass') return ['pass', '通过'];
  if (outcome.assertion) return ['fail', '断言失败'];
  if (outcome.failureType === 'subtestsFailed') return ['fail', '子测试失败'];
  return ['fail', '失败'];
}

function trialStatus(phase, trial, outcomes, assertions) {
  if (!trial) return ['pending', missing];
  if (trial.timedOut) return ['error', '测试进程超时'];
  if (hasText(trial.error) || trial.code === null || hasText(trial.signal)) return ['error', '测试进程异常退出'];
  if (!Number.isInteger(trial.code)) return ['pending', '退出状态未记录'];
  if (phase === 'mutant') {
    if (trial.code === 0) return ['fail', '测试未捕获缺陷'];
    if (assertions.length) return ['pass', '触发对应断言失败'];
    if (outcomes.some((outcome) => !outcome.skip && !outcome.todo && outcome.result === 'fail' && outcome.assertion)) {
      return ['pending', '触发断言失败，归因未记录'];
    }
    return ['fail', '测试未通过，对应断言未记录'];
  }
  if (trial.code !== 0) return ['fail', '测试未通过'];
  if (!Array.isArray(trial.outcomes)) return ['pending', '进程正常退出'];
  if (outcomes.some((outcome) => !outcome.skip && !outcome.todo && outcome.result === 'fail')) return ['fail', '记录中有失败'];
  if (outcomes.some((outcome) => !outcome.skip && !outcome.todo && outcome.result === 'pass')) return ['pass', '测试通过'];
  return ['pending', '没有已执行测试的记录'];
}

function testFile(file) {
  if (!hasText(file)) return '—';
  const path = file.replaceAll('\\', '/');
  const start = path.lastIndexOf('/test/');
  return start < 0 ? path : path.slice(start + 1);
}

function trialDetails(label, trial, outcomes, ui) {
  const children = [];
  if (outcomes.length) {
    const rows = outcomes.map((outcome) => {
      const name = hasText(outcome.name) ? outcome.name : '未命名测试';
      return [
        hasText(outcome.message) ? errorDetails(name, outcome.message, ui) : name,
        ui.badge(...outcomeStatus(outcome)),
        ui.element('code', '', testFile(outcome.file)),
      ];
    });
    children.push(ui.table(['测试名称', '记录结果', '文件'], rows));
  }
  if (hasText(trial.error)) children.push(errorDetails('进程错误', trial.error, ui));
  if (hasText(trial.signal)) children.push(ui.facts([['退出信号', trial.signal]]));
  if (hasText(trial.stdout)) children.push(ui.details('标准输出', ui.code(trial.stdout, 'stdout.log')));
  if (hasText(trial.stderr)) children.push(ui.details('标准错误', ui.code(trial.stderr, 'stderr.log')));
  return children.length ? ui.details(`${label}测试记录`, ...children) : null;
}

function probeDetails(label, probe, passedLabel, ui) {
  if (!record(probe) || (![probe.status, probe.message, probe.stderr].some(hasText) && !record(probe.response))) return null;
  const outcome = probe.status === 'pass' ? passedLabel : probe.status === 'fail' ? '探针未通过' : '结果未记录';
  const children = [ui.facts([
    ['响应状态', httpStatus(probe.response?.status)],
    ['返回任务', responseTaskIds(probe.response)],
  ])];
  if (hasText(probe.message)) children.push(ui.section('探针错误', ui.code(probe.message, 'probe.log')));
  if (hasText(probe.stderr)) children.push(ui.details('标准错误', ui.code(probe.stderr, 'stderr.log')));
  const body = payload(probe.response, ui);
  if (body) children.push(body);
  return ui.details(`${label} · ${outcome}`, ...children);
}

function mutationEvidence(data, ui, { native = false } = {}) {
  const tests = Array.isArray(data.tests) ? data.tests.filter(hasText) : null;
  const assertions = Array.isArray(data.failedAssertions)
    ? data.failedAssertions.filter((entry) => hasText(entry?.name) || hasText(entry?.message)) : [];
  const phases = mutationPhases.map(([phase, label]) => {
    const entry = data[phase];
    const trial = record(entry) && (entry.code === null || Number.isInteger(entry.code) || entry.timedOut === true
      || Array.isArray(entry.outcomes) || [entry.error, entry.signal, entry.stdout, entry.stderr].some(hasText)) ? entry : null;
    const outcomes = Array.isArray(trial?.outcomes)
      ? trial.outcomes.filter((entry) => entry?.result === 'pass' || entry?.result === 'fail') : [];
    return { phase, label, trial, outcomes };
  });
  const probes = [
    probeDetails('健康副本', data.healthyProbe, '接口满足契约', ui),
    probeDetails('缺陷副本', data.mutantProbe, '已复现已知缺陷', ui),
  ].filter(Boolean);
  const hasTestFileRecord = tests && (tests.length > 0 || data.tests.length === 0);
  if (!hasTestFileRecord && !hasText(data.error) && !assertions.length && !probes.length
    && !phases.some(({ trial }) => trial)) return null;

  const view = ui.element('div', 'evidence-validation');
  if (tests?.length) view.append(ui.facts([['纳入评测的测试文件', tests.join('、')]]));
  if (Array.isArray(data.tests) && !data.tests.length) view.append(ui.note(native
    ? '未发现 Agent 新增的订单详情页测试。'
    : '未发现 Agent 新增或修改的 .test.mjs 文件。'));
  if (native && hasText(data.blocked)) view.append(ui.note(data.blocked));
  if (hasText(data.error)) view.append(errorDetails('变异评测执行异常', data.error, ui));

  const results = phases.map(({ phase, label, trial, outcomes }) => [
    label,
    ui.badge(...trialStatus(phase, trial, outcomes, assertions)),
    Number.isInteger(trial?.code) ? trial.code : '—',
    Array.isArray(trial?.outcomes) ? outcomes.length : '—',
  ]);
  view.append(ui.section('各副本运行结果', ui.table(['运行副本', '测试结果', '退出码', '测试记录数'], results)));

  if (assertions.length) {
    const failures = assertions.map(({ name, message }) => hasText(message)
      ? errorDetails(hasText(name) ? name : '未命名断言', message, ui)
      : ui.note(name));
    view.append(ui.section(`缺陷副本触发的对应断言（${assertions.length} 项）`, ...failures));
  }

  if (probes.length) view.append(ui.section(native ? '缺陷确认' : '已完成任务接口探针', ...probes));

  const logs = phases.filter(({ trial }) => trial)
    .map(({ label, trial, outcomes }) => trialDetails(label, trial, outcomes, ui)).filter(Boolean);
  if (logs.length) view.append(ui.section('测试与进程日志', ...logs));
  return view;
}

function targetBuildEvidence(data, ui) {
  const steps = [
    ['Vitest', data.tests], ['类型检查', data.types], ['生产构建', data.bundle],
  ].filter(([, result]) => record(result));
  if (!steps.length) return null;
  const status = (result) => result.timedOut ? ui.badge('error', '超时')
    : !Number.isInteger(result.code) ? ui.badge('pending')
      : ui.badge(result.code === 0 ? 'pass' : 'fail');
  const output = steps.map(([name, result]) => {
    const logs = [['标准输出', result.stdout], ['标准错误', result.stderr]].filter(([, log]) => hasText(log));
    return logs.length ? ui.details(`${name}日志`, ...logs.map(([label, log]) =>
      ui.details(label, ui.code(log, 'command.log')))) : null;
  });
  return ui.section('订单详情页构建与测试', ui.table(['检查', '结果', '退出码'], steps.map(([name, result]) =>
    [name, status(result), Number.isInteger(result.code) ? result.code : '—'])), ...output);
}

function targetBrowserEvidence(data, ui, context) {
  const checks = Array.isArray(data.checks) ? data.checks.filter((check) => hasText(check?.name)) : [];
  const state = (status) => ({ passed: 'pass', failed: 'fail' })[status] ?? status;
  const shots = [
    ['target-order-desktop.png', '订单详情 · 桌面'],
    ['target-order-mobile.png', '订单详情 · 移动端'],
    ['target-order-missing.png', '订单不存在'],
    ['target-order-failure.png', '失败现场'],
  ].map(([file, label]) => context?.artifactImage?.(file, label)).filter(Boolean);
  if (!checks.length && !shots.length && !hasText(data.error)) return null;
  const rows = checks.map(({ name, status, error }) => [
    name,
    ui.badge(state(status) ?? 'pending'),
    hasText(error) ? errorDetails('查看断言错误', error, ui) : '—',
  ]);
  const errors = Array.isArray(data.pageErrors) ? data.pageErrors.filter(hasText) : [];
  return ui.section('订单详情页浏览器验收',
    checks.length ? ui.metrics([
      ['检查数', checks.length], ['通过', checks.filter(({ status }) => state(status) === 'pass').length, 'pass'],
    ]) : null,
    rows.length ? ui.table(['验收项', '结果', '诊断'], rows) : null,
    hasText(data.error) ? errorDetails('浏览器异常', data.error, ui) : null,
    errors.length ? errorDetails('页面错误', errors.join('\n'), ui) : null,
    ...shots);
}

function targetApprovalEvidence(data, ui) {
  const entries = Array.isArray(data) ? data : data?.approvals;
  if (!Array.isArray(entries)) return null;
  const stages = { proposal: '提案', approval: '方案确认', implementation: '实施', apply: '实施',
    verification: '验收', verify: '验收', review: '审查' };
  const states = {
    approved: ['pass', '已确认'], granted: ['pass', '已确认'], confirmed: ['pass', '已确认'],
    withheld: ['blocked', '未确认'], declined: ['blocked', '未确认'], denied: ['blocked', '未确认'],
    rejected: ['blocked', '已拒绝'], blocked: ['fail', '门禁阻塞'], skipped: ['skipped', '无需确认'],
    pending: ['pending', '待确认'], waiting: ['pending', '待确认'],
  };
  return ui.section('审批记录', entries.length ? ui.table(['阶段', '状态', '决定', '时间'],
    entries.filter(record).map(({ stage, status, summary, at, sessionId, changeId, proposalHash }) => {
      const decision = ui.element('div');
      if (hasText(summary)) decision.append(ui.note(summary));
      const facts = [['会话 ID', sessionId], ['变更标识', changeId], ['提案 SHA-256', proposalHash]]
        .filter(([, value]) => hasText(value));
      if (facts.length) decision.append(ui.details('查看会话与提案凭证', ui.facts(facts)));
      return [stages[stage] ?? stage, ui.badge(...(states[status] ?? [status ?? 'pending'])), decision, at];
    })) : ui.note('没有审批事件。'));
}

function targetConversationEvidence(data, ui) {
  if (!Array.isArray(data.messages)) return null;
  const children = Array.isArray(data.children) ? data.children.filter(record) : [];
  function thread(entries) {
    return entries.filter(record).map(({ role, model, provider, sessionId, parts, error }) => {
      const texts = Array.isArray(parts) ? parts.filter((part) => part?.type === 'text' && hasText(part.text)) : [];
      const tools = Array.isArray(parts) ? parts.filter((part) => part?.type === 'tool' && hasText(part.tool)) : [];
      const modelLabel = [provider, model].filter(hasText).join('/');
      const roleLabel = role === 'user' ? '用户消息' : role === 'assistant' ? 'Agent 回复' : role ?? '原生消息';
      const label = [roleLabel, modelLabel, tools.length ? `${tools.length} 次工具调用` : ''].filter(Boolean).join(' · ');
      return ui.details(label,
        hasText(sessionId) ? ui.facts([['会话 ID', sessionId]]) : null,
        hasText(error) ? ui.note(`会话异常 ${error}`) : null,
        ...texts.map(({ text }) => ui.code(text, 'message.txt')),
        ...tools.map(({ tool, id, status, input, output }) =>
          ui.details([tool, ({ completed: '已完成', error: '异常', running: '进行中', pending: '等待中' })[status] ?? status].filter(Boolean).join(' · '),
            hasText(id) ? ui.facts([['调用 ID', id]]) : null,
            hasText(input) ? ui.details('输入', ui.code(input, 'tool-input.json')) : null,
            hasText(output) ? ui.details('输出证据', ui.code(output, 'tool-output.log')) : null)));
    });
  }
  const view = ui.element('div', 'evidence-validation');
  view.append(ui.metrics([['主会话消息', data.messages.length], ['子会话', children.length]]),
    ui.section('主会话与工具调用', ...thread(data.messages)));
  if (children.length) {
    view.append(ui.section('子会话', ...children.map(({ sessionId, parentId, title, messages }) =>
      ui.details(title || '子会话', ui.facts([['会话 ID', sessionId], ['父会话 ID', parentId]]),
        ...thread(Array.isArray(messages) ? messages : [])))));
  }
  return view;
}

function nativeCaseEvidence(data, ui) {
  const checks = Array.isArray(data.checks) ? data.checks.filter(record) : [];
  const changes = Array.isArray(data.changes) ? data.changes.filter(hasText) : [];
  const reads = Array.isArray(data.reads) ? data.reads.filter(record) : [];
  const writes = Array.isArray(data.writeAttempts) ? data.writeAttempts.filter(record) : [];
  const childSessions = Array.isArray(data.childSessions) ? data.childSessions.filter(record) : [];
  const first = record(data.firstWrite) ? data.firstWrite : null;
  if (!checks.length && !hasText(data.expected)) return null;

  const timeline = new Intl.DateTimeFormat('zh-CN', { hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  function time(value) {
    if (value == null) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : timeline.format(date);
  }

  const outcomes = checks.map(({ id, title, status, summary }) => [
    title ?? id, ui.badge(status ?? 'pending'), summary,
  ]);
  function activity(events, showStatus = false) {
    return ui.table(['文件或路径', '工具', ...(showStatus ? ['状态'] : []), '时间', '调用 ID'],
      events.map(({ path, tool, status, at, callId }) => [path, tool,
        ...(showStatus ? [status === 'completed' ? ui.badge('completed', '已完成') : ui.badge(status ?? 'pending')] : []),
        time(at), callId]));
  }
  const rules = data.expectation;
  const policies = { none: '工作区保持原样', 'proposal-only': '确认前只允许写入提案', allow: '允许实现变更' };
  const conditions = record(rules) ? [
    ['写入边界', policies[rules.writePolicy]],
    ...[['必须核验正文的 Skill', rules.expectedSkills], ['不得读取的 Skill', rules.forbiddenSkills],
      ['可写入的项目路径', rules.paths], ['确认前必须变更的提案文件', rules.approvalFiles],
      ['确认后可写入的路径', rules.postApprovalPaths], ['写入前必须读取的文件', rules.requiredReads]]
      .filter(([, values]) => Array.isArray(values) && values.length).map(([label, values]) => [label, values.join('、')]),
    ...(rules.requireChange ? [['文件改动', '必须产生变更']] : []),
    ...(rules.skillBeforeWrite ? [['阶段证据', '实现前必须核验 Skill 正文']] : []),
    ...(rules.minChildSessions > 0 ? [['原生子会话', `至少完成 ${rules.minChildSessions} 个`]] : []),
  ].filter(([, value]) => hasText(value)) : [];
  const view = ui.element('div', 'evidence-validation');
  if (hasText(data.expected) || conditions.length) view.append(ui.section('审核预期',
    hasText(data.expected) ? ui.note(data.expected) : null,
    conditions.length ? ui.details('查看已审核的判定条件', ui.facts(conditions)) : null));
  view.append(ui.section('独立判定', outcomes.length ? ui.table(['判定证据', '结果', '说明'], outcomes) : null),
    childSessions.length ? ui.section('已完成的原生子会话', ui.table(['子会话 ID', '父会话 ID', '完成时间'],
      childSessions.map(({ sessionId, parentId, completedAt }) => [sessionId, parentId, time(completedAt)]))) : null,
    ui.section('写入与代码差异',
      first ? ui.facts([['首项实现写入', first.path], ['工具', first.tool], ['时间', time(first.at)], ['调用 ID', first.callId]])
        : ui.note('未记录完成的实现写入。'),
      changes.length ? ui.details(`查看变更文件（${changes.length}）`, ui.table(['项目路径'], changes.map((file) => [file])))
        : ui.note('项目差异为空。'),
      writes.length ? ui.details(`查看写入事件（${writes.length}）`, activity(writes, true)) : null),
    reads.length ? ui.section('原生读取事件', ui.details(`查看读取记录（${reads.length}）`, activity(reads)))
      : ui.section('原生读取事件', ui.note('未记录文件读取。')));
  return view;
}

export function renderValidationEvidence(file, data, ui, context) {
  if (file === 'target-approvals.json') return targetApprovalEvidence(data, ui);
  if (!record(data)) return null;
  if (file === 'api.json') return apiEvidence(data, ui);
  if (file === 'api-contract.json') return projectApiEvidence(data, ui);
  if (file === 'browser.json') return browserEvidence(data, ui, context);
  if (file === 'mutation.json') return mutationEvidence(data, ui);
  if (file === 'target-build.json') return targetBuildEvidence(data, ui);
  if (file === 'target-browser.json') return targetBrowserEvidence(data, ui, context);
  if (file === 'target-mutation.json') return mutationEvidence(data, ui, { native: true });
  if (file === 'target-conversation.json') return targetConversationEvidence(data, ui);
  if (file === 'native-case-evidence.json') return nativeCaseEvidence(data, ui);
  return null;
}
