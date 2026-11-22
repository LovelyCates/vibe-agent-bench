import { createBenchmarkComparison, experimentRun, experimentStatus } from './benchmark-comparison.js';
import { buildEvidencePreview } from './evidence-preview.js';
import { highlightedPreview } from './workbench-highlight.js';
import { createRunOutcome, createRunVisualization, displayRunStepStatus, isRunTerminalEvent, runEventPhase } from './run-visualization.js';

const byId = (id) => document.getElementById(id);
const labels = {
  draft: '待审核', approved: '已审核', queued: '排队中', pending: '等待中', running: '进行中',
  preparing: '准备中', completed: '已结束', pass: '通过', fail: '失败', failed: '失败',
  blocked: '阻塞', error: '异常', interrupted: '已中断', skipped: '已跳过',
};
const phases = { run: '调度', workspace: '准备工作副本', setup: '准备命令', agent: '实现', verify: '验收', advice: '修复建议' };
const agentNames = { codex: 'Codex', opencode: 'OpenCode', dsh: 'DeepSeek Harness', demo: '参考演示' };
const agentLabel = (agent) => agentNames[agent] ?? 'OpenCode';
const skillLabels = { with: '有 Skill', without: '无 Skill' };
const fixtureTitle = '后台任务列表增加状态筛选';
const approvalStates = {
  approved: ['pass', '已确认'], granted: ['pass', '已确认'], confirmed: ['pass', '已确认'],
  withheld: ['blocked', '未确认'], declined: ['blocked', '未确认'], denied: ['blocked', '未确认'],
  rejected: ['blocked', '已拒绝'], blocked: ['fail', '门禁阻塞'], skipped: ['skipped', '无需确认'], not_requested: ['skipped', '无需确认'],
  waiting: ['pending', '待确认'], pending: ['pending', '待确认'], requested: ['pending', '待确认'],
};
const targetStages = { proposal: '提案', implementation: '实施', apply: '实施', approval: '方案确认',
  verify: '验收', verification: '验收', review: '审查', preflight: '准备' };
const eventKinds = {
  run: ['运行', 'history'], phase: ['阶段', 'layers'], check: ['检查', 'list'],
  command: ['命令', 'terminal'], 'command-output': ['命令输出', 'terminal'], tool: ['工具', 'code'],
  skill: ['Skill', 'layers'], step: ['步骤', 'activity'], message: ['消息', 'file'],
  notice: ['提示', 'activity'], error: ['错误', 'cross'],
};
const sampleChecks = ['代码规范', '后端启动', '前端启动', 'API 行为', '页面联调', '测试辨别力'];
const editTools = new Set(['apply_patch', 'edit', 'multiedit', 'write']);
const active = new Set(['queued', 'running', 'preparing']);
const pending = new Set(['pending', ...active]);
const dateStyle = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });
const timeStyle = new Intl.DateTimeFormat('zh-CN', { hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const tabs = ['spec', 'commands', 'skills', 'files'];
const editors = ['title', 'requirement', 'prompt'];
const nativeScenarios = {
  'auto-trigger': 'Skill 自动触发', 'analysis-only': '只分析、不改代码',
  'approval-gate': '审批门禁', 'code-standards': '代码规范落地',
};
const nativeLists = {
  expectedSkills: 'required-skills', forbiddenSkills: 'forbidden-skills', paths: 'paths',
  requiredReads: 'required-reads', approvalFiles: 'approval-files', postApprovalPaths: 'post-approval',
};
const suiteGapLabels = { project: '项目缺条件', platform: '平台还缺检查', both: '两边都缺' };
const draftEdits = new Map();
const runs = new Map();
const skillSuites = new Map();
const skillSuiteRequests = new Map();
const suiteProposalRequests = new Set();
const suiteProposalNotices = new Map();
const expandedSingleReviews = new Set();
const timelineFilters = new Map();
const caseList = byId('case-list');
const eventsList = byId('events');
const eventFilter = byId('event-filter');
const eventSearch = byId('event-search');
const eventSearchText = new WeakMap();
const runVisualization = createRunVisualization(byId('run-visualization'), { onPhaseSelect: showPhaseEvents });
const runOutcome = createRunOutcome(byId('run-outcome'), { onCheckSelect: focusCheck });
const dialog = byId('artifact-dialog');
const proposalDialog = byId('skill-proposal-dialog');
const route = new URL(location.href);
const viewHeadings = { workspace: 'page-title', benchmark: 'benchmark-title', history: 'history-title' };
const historyFilters = new Set(['all', 'project', 'builtin']);
const renderComparison = createBenchmarkComparison({
  element, badge, formatTime, runLabel, runHref, onSelect: (run) => openRun(run),
});
let cases = [];
let defaultProject = '';
let scenario;
let skillProfiles = [];
let caseId = route.searchParams.get('case');
let runId = null;
let projectRunId = null;
let benchmarkRunId = null;
let benchmarkExperimentId = null;
let benchmarkGroup = false;
let benchmarkLaunch = false;
let currentTab = 'spec';
let editingCase = false;
let view = viewFromRoute(route);
let historyFilter = filterFromRoute(route);
let creating = false;
let discoveryPath = '';
let loaded = false;
let routeReady = false;
let reportFirst = route.searchParams.has('run');
let busy = '';
let notice = '';
let pollError = '';
let pollTimer;
let pollController;
let missingRun = false;
let cursor = 0;
let finalSignature = '';
let historySignature;
let recentSignature;
let targetSignature;
let skillSuiteSignature;
let proposalContext;
let reviewOverviewSignature;
let targetTrials;
let targetSuiteId;
let recordPollError = '';
let seenActive = false;
let seenEnd = false;
let finalReads = 0;
let deferredEvents = [];
let evidenceEvents = [];
let previewController;
let previewTrigger;
let preview;
const previewHistory = [];
let navigationVersion = 0;

function element(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value != null) node.textContent = value;
  return node;
}

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

function button(label, className, handler) {
  const node = element('button', className, label);
  node.type = 'button';
  node.addEventListener('click', handler);
  return node;
}

function badge(status, label = labels[status] ?? status) {
  const node = element('span', 'badge');
  node.dataset.state = status;
  if (active.has(status)) node.append(element('i'));
  node.append(label);
  return node;
}

function runBadge(run) {
  if (run.status !== 'completed') return badge(run.status);
  const verdict = run.testTarget?.verdict ?? run.nativeCase?.verdict;
  if (verdict) return targetVerdict(verdict);
  const checks = run.checks.filter(({ id, status }) =>
    !(run.mode === 'demo' && displayRunStepStatus(run, id, status) === 'skipped' && ['agent', 'skill'].includes(id)));
  if (checks.some(({ status }) => ['fail', 'error'].includes(status))) return badge('fail', '有检查未通过');
  if (checks.some(({ status }) => ['blocked', 'interrupted'].includes(status))) return badge('blocked', '有检查阻塞');
  if (checks.some(({ status }) => status === 'skipped')) return badge('skipped', '有检查跳过');
  if (!checks.length || checks.some(({ status }) => status !== 'pass')) return badge('pending', '检查结果不完整');
  return badge('pass', '验收通过');
}

function runLabel(run) {
  if (run.testTarget) return ['OpenCode 原生', run.testTarget.condition, run.testTarget.model].filter(Boolean).join(' · ');
  if (run.nativeCase) return ['OpenCode 原生', nativeScenarios[run.nativeCase.scenario], run.nativeCase.model].filter(Boolean).join(' · ');
  return [agentLabel(run.mode), skillLabels[run.skillMode]].filter(Boolean).join(' · ');
}

function targetVerdict(verdict) {
  const states = {
    pass: '符合预期', passed: '符合预期', fail: '未达预期', failed: '未达预期', blocked: '评测阻塞', error: '评测异常',
    inconclusive: '证据不足', unknown: '证据不足',
  };
  return badge(verdict === 'passed' ? 'pass' : verdict === 'failed' ? 'fail' : verdict, states[verdict] ?? labels[verdict] ?? verdict);
}

function formatTime(value, formatter = dateStyle) {
  const date = new Date(value);
  return value && !Number.isNaN(date.getTime()) ? formatter.format(date) : '';
}

function duration(value) {
  if (!Number.isFinite(value) || value < 0) return '';
  if (value < 1000) return `${value} ms`;
  if (value < 60000) return `${(value / 1000).toFixed(1)} s`;
  return `${Math.floor(value / 60000)}m ${Math.floor((value % 60000) / 1000)}s`;
}

async function api(path, { method = 'GET', body, signal } = {}) {
  const response = await fetch(path, {
    method,
    cache: 'no-store',
    signal,
    ...(body !== undefined && { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `请求返回 HTTP ${response.status}。`);
    error.status = response.status;
    throw error;
  }
  return data;
}

const caseRoute = (id) => `/api/cases/${encodeURIComponent(id)}`;
const skillSuiteRoute = (id) => `${caseRoute(id)}/skill-suite`;
const runRoute = (id) => `/api/runs/${encodeURIComponent(id)}`;
const selectedCase = () => cases.find(({ id }) => id === caseId);
const selectedRun = () => runs.get(runId);
const isCaseList = (record) => Boolean(record && (record.skillSuiteRoot || record.hasSkillSuite
  || skillSuites.get(record.id)?.parentCaseId === record.id));

function caseData(testCase) {
  const { title, requirement, prompt, commands = [], skillProfile = 'none', agent = 'opencode', native } = testCase;
  return { title, requirement, prompt, commands, skillProfile, agent, ...(native && { native: nativeReviewData(native) }) };
}

function nativeReviewData({ scenario, expected = '', expectation = {}, confirmationPrompt = '', gateCommandIds = [] }) {
  return { scenario, expected, expectation: {
    ...Object.fromEntries(Object.keys(nativeLists).map((key) => [key, expectation[key] ?? []])),
    writePolicy: expectation.writePolicy ?? 'none', skillBeforeWrite: Boolean(expectation.skillBeforeWrite),
    requireChange: Boolean(expectation.requireChange),
  }, confirmationPrompt, gateCommandIds };
}

function newestRuns() {
  return [...runs.values()].sort((a, b) => String(b.createdAt || b.startedAt).localeCompare(String(a.createdAt || a.startedAt)));
}

function latestRun(id) {
  return id ? newestRuns().find((run) => run.caseId === id) : undefined;
}

function builtinRuns() {
  return newestRuns().filter((run) => !run.caseId);
}

function anyRunActive() {
  return [...runs.values()].some(({ status }) => active.has(status));
}

function updateNotice() {
  const text = notice || (view !== 'history' && pollError) || recordPollError;
  byId('notice').hidden = !text;
  if (byId('notice').textContent !== text) byId('notice').textContent = text;
}

function setNotice(value) {
  notice = value;
  updateNotice();
}

function connection(state, text) {
  byId('connection').dataset.state = state;
  byId('connection-text').textContent = text;
}

function filterFromRoute(url) {
  const filter = url.searchParams.get('type');
  if (historyFilters.has(filter)) return filter;
  return url.pathname === '/benchmark' && url.hash === '#history-title' ? 'builtin' : 'all';
}

function viewFromRoute(url, run) {
  const requested = url.searchParams.get('view');
  if (requested === 'history' || ['#history', '#history-title'].includes(url.hash)) return 'history';
  if (run) return run.caseId ? 'workspace' : 'benchmark';
  if (requested === 'benchmark' || url.pathname === '/benchmark' || url.searchParams.has('experiment')) return 'benchmark';
  return 'workspace';
}

function viewHref(page, { project, run, experiment, filter, create, edit } = {}) {
  const query = new URLSearchParams();
  if (page !== 'workspace') query.set('view', page);
  if (project) query.set('case', project);
  if (run) query.set('run', run);
  if (experiment) query.set('experiment', experiment);
  if (filter && filter !== 'all') query.set('type', filter);
  if (create) query.set('create', '1');
  if (edit) query.set('edit', '1');
  return query.size ? `/?${query}` : '/';
}

function runHref(run) {
  return viewHref(run.caseId ? 'workspace' : 'benchmark', { project: run.caseId, run: run.id, experiment: run.experimentId });
}

function updateLocation(mode = 'replaceState') {
  navigationVersion += 1;
  if (!mode) return;
  const next = view === 'history' ? viewHref(view, { filter: historyFilter })
    : view === 'benchmark' ? viewHref(view, {
      run: benchmarkLaunch || benchmarkGroup ? null : benchmarkRunId,
      experiment: benchmarkLaunch ? null : benchmarkExperimentId,
    })
      : viewHref(view, { project: caseId, run: reportFirst ? projectRunId : null, create: creating,
        edit: editingCase && !reportFirst && !creating });
  if (new URL(next, location.href).href !== location.href) history[mode](null, '', next);
}

function positionExecution() {
  const report = byId('execution');
  if (view === 'benchmark') {
    if (report.parentElement !== byId('benchmark-main')) byId('benchmark-main').append(report);
    report.hidden = !runId;
  } else if (view === 'workspace') {
    const review = byId('case-panel');
    if (reportFirst && runId) {
      if (report.nextElementSibling !== review) review.before(report);
    } else if (review.nextElementSibling !== report) {
      review.after(report);
    }
    report.hidden = creating || !runId;
  }
}

function renderNavigation() {
  const workspace = view === 'workspace';
  byId('workspace-intro').hidden = !workspace;
  byId('workspace').hidden = !workspace;
  byId('benchmark-view').hidden = view !== 'benchmark';
  byId('history-view').hidden = view !== 'history';
  for (const name of Object.keys(viewHeadings)) {
    const link = byId(`${name}-link`);
    if (view === name) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  positionExecution();
  renderRunLists();
  updateNotice();
}

function handleLink(link, handler) {
  link.addEventListener('click', (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    handler();
  });
}

function renderCases() {
  const entries = cases.filter((record) => !record.skillSuite || record.id === caseId);
  byId('case-count').textContent = String(entries.length);
  if (!entries.length) {
    caseList.replaceChildren(element('p', 'empty-small', '还没有项目用例。'));
    return;
  }
  const list = document.createDocumentFragment();
  for (const record of entries) {
    const entry = button(null, 'case-item', () => chooseCase(record.id));
    if (record.id === caseId && !creating) entry.setAttribute('aria-current', 'true');
    const file = element('span', 'shelf-icon');
    file.append(icon('file'));
    const copy = element('span');
    const description = isCaseList(record) ? '用例清单' : record.status === 'approved' ? '单条 · 已确认' : '单条 · 待确认';
    copy.append(element('span', 'case-title', record.title), element('span', 'case-subtitle', `${record.projectName} · ${description}`));
    entry.append(file, copy, icon('chevron'));
    list.append(entry);
  }
  caseList.replaceChildren(list);
  fitSelectedCase();
}

function fitSelectedCase() {
  const overflow = caseList.scrollWidth > caseList.clientWidth + 1;
  byId('case-scroll-hint').hidden = !overflow;
  if (!overflow) return;
  const selected = caseList.querySelector('[aria-current="true"]');
  if (!selected) return;
  const strip = caseList.getBoundingClientRect();
  const button = selected.getBoundingClientRect();
  if (button.right > strip.right - 8) caseList.scrollLeft += Math.ceil(button.right - strip.right + 8);
  else if (button.left < strip.left + 8) caseList.scrollLeft -= Math.ceil(strip.left + 8 - button.left);
}

const benchmarkScrollHints = [
  ['benchmark-recent-list', 'benchmark-recent-scroll-hint'],
  ['comparison-scroll', 'comparison-scroll-hint'],
];

function updateBenchmarkScrollHints() {
  for (const [containerId, hintId] of benchmarkScrollHints) {
    const list = byId(containerId);
    byId(hintId).hidden = !list.clientWidth || list.scrollWidth <= list.clientWidth + 1;
  }
}

function renderFlow() {
  byId('flow').hidden = !creating && (!selectedCase() || isCaseList(selectedCase()) || reportFirst);
  const current = creating || !selectedCase() ? 0 : selectedCase().status === 'approved' ? 2 : 1;
  for (const [index, stage] of ['create', 'review', 'run'].entries()) {
    const item = byId(`flow-${stage}`);
    const state = index < current ? 'done' : index === current ? 'current' : 'pending';
    item.dataset.state = state;
    if (state === 'current') item.setAttribute('aria-current', 'step');
    else item.removeAttribute('aria-current');
    item.firstElementChild.replaceChildren(state === 'done' ? icon('check') : String(index + 1));
  }
}

function field(labelText, control) {
  const label = element('label', 'field');
  label.append(element('span', null, labelText), control);
  return label;
}

function commandRow(command) {
  const row = element('div', 'command');
  row.dataset.command = command.id;
  const name = element('input');
  name.name = 'command-label';
  name.maxLength = 100;
  name.value = command.label;
  name.placeholder = '运行项目测试';
  const phase = element('select');
  phase.name = 'command-phase';
  for (const [value, text] of [['setup', '运行前准备'], ['verify', '运行后验证']]) {
    const option = element('option', null, text);
    option.value = value;
    phase.append(option);
  }
  phase.value = command.phase;
  const program = element('input', 'mono');
  program.name = 'command-program';
  program.value = command.program;
  program.placeholder = 'npm';
  program.spellcheck = false;
  const timeout = element('input');
  timeout.name = 'command-timeout';
  timeout.type = 'number';
  timeout.min = '1';
  timeout.max = '900000';
  timeout.step = '1';
  timeout.value = command.timeoutMs;
  const args = element('textarea', 'mono');
  args.name = 'command-args';
  args.rows = 2;
  args.spellcheck = false;
  args.value = command.args.join('\n');
  args.placeholder = 'test';
  const argsField = field('参数', args);
  argsField.classList.add('command-args');
  const remove = button(null, 'icon-button', () => {
    row.remove();
    storeEdits();
    byId('add-command').focus();
  });
  remove.setAttribute('aria-label', '移除此命令');
  remove.append(icon('cross'));
  row.append(field('命令名', name), field('执行阶段', phase), field('程序', program), field('超时（毫秒）', timeout), remove, argsField);
  return row;
}

function storeEdits() {
  const testCase = selectedCase();
  if (!testCase || creating) return;
  const commands = [...byId('commands').children].map((row) => {
    const input = (name) => row.querySelector(`[name="command-${name}"]`).value;
    return {
      id: row.dataset.command, label: input('label'), phase: input('phase'), program: input('program').trim(),
      args: input('args') ? input('args').split(/\r?\n/u) : [], timeoutMs: Number(input('timeout')),
    };
  });
  const edit = Object.fromEntries(editors.map((name) => [name, byId(`review-${name}`).value]));
  edit.commands = commands;
  edit.skillProfile = byId('review-skill-profile').value || 'none';
  edit.agent = byId('review-agent').value;
  if (testCase.native) {
    const writePolicy = byId('review-native-write-policy').value;
    const writes = writePolicy !== 'none';
    const approval = writePolicy === 'proposal-only';
    const gateCommandIds = [...byId('native-gate-commands').querySelectorAll('input:checked')].map(({ value }) => value);
    const lists = Object.fromEntries(Object.entries(nativeLists).map(([name, id]) => [name,
      byId(`review-native-${id}`).value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean)]));
    if (!writes) Object.assign(lists, { paths: [], requiredReads: [] });
    if (!approval) Object.assign(lists, { approvalFiles: [], postApprovalPaths: [] });
    const usefulGateIds = commands.filter(({ id, phase }) => phase === 'verify' && gateCommandIds.includes(id)).map(({ id }) => id);
    edit.native = nativeReviewData({
      scenario: testCase.native.scenario, expected: byId('review-native-expected').value,
      expectation: { ...lists, writePolicy, skillBeforeWrite: writes && byId('review-native-before-write').checked,
        requireChange: writes && byId('review-native-require-change').checked },
      confirmationPrompt: approval ? byId('review-native-confirmation').value : '',
      gateCommandIds: approval ? usefulGateIds : [],
    });
    renderNativePolicy(writePolicy);
    renderNativeGateCommands(commands, usefulGateIds);
  } else {
    renderSkillProfile(edit.skillProfile, testCase.profile === 'sample');
  }
  if (JSON.stringify(caseData(testCase)) === JSON.stringify(edit)) draftEdits.delete(caseId);
  else draftEdits.set(caseId, edit);
  renderReviewActions();
}

function renderNativeDiscovery(target, discovery) {
  target.replaceChildren();
  for (const [title, rows, empty] of [
    ['配置文件', discovery?.configs ?? [], '未发现项目级配置文件。'],
    ['项目 Skill', discovery?.skills ?? [], '未发现项目 Skill。'],
  ]) {
    const list = element('ul', 'native-inventory');
    for (const { name, path, description, sha256 } of rows) {
      const item = element('li');
      if (name) item.append(element('strong', null, name));
      const source = element('code', null, path);
      if (sha256) source.title = `SHA-256 ${sha256}`;
      item.append(source);
      if (description) item.append(element('p', null, description));
      list.append(item);
    }
    target.append(element('h4', null, `${title}（${rows.length}）`), rows.length ? list : element('p', 'field-help', empty));
  }
}

function renderNativeGateCommands(commands, selected) {
  const container = byId('native-gate-commands');
  const available = commands.filter(({ phase }) => phase === 'verify');
  const signature = JSON.stringify(available.map(({ id, label }) => [id, label]));
  if (container.dataset.commands !== signature) {
    const fields = available.map(({ id, label }) => {
      const input = element('input');
      input.type = 'checkbox';
      input.value = id;
      const control = element('label', 'native-check');
      control.append(input, element('span', null, label.trim() || '未命名验证命令'));
      return control;
    });
    container.replaceChildren(...fields);
    container.dataset.commands = signature;
  }
  for (const input of container.querySelectorAll('input')) input.checked = selected.includes(input.value);
  byId('native-gate-empty').hidden = available.length > 0;
}

function renderNativePolicy(policy) {
  const approval = policy === 'proposal-only';
  byId('review-native-confirmation-fields').hidden = !approval;
  byId('native-write-fields').hidden = policy === 'none';
  byId('native-gate-fields').hidden = !approval;
  byId('native-path-label').textContent = approval ? '确认前可写入的路径' : '允许写入的路径';
  byId('native-path-summary').textContent = approval ? '文件和审批证据' : '文件证据';
}

function renderNativeReview(testCase, data) {
  const native = data.native;
  for (const id of ['review-native-scenario', 'native-inputs', 'review-native-evidence']) byId(id).hidden = !native;
  for (const id of ['review-agent-field', 'review-pack-profile']) byId(id).hidden = Boolean(native);
  byId('review-prompt-label').textContent = `发给 ${native ? 'OpenCode' : agentLabel(data.agent)} 的消息`;
  byId('review-prompt-help').textContent = native?.scenario === 'auto-trigger'
    ? '像平时那样提需求。要观察自动触发时，把目标 Skill 留在判定条件里。'
    : '点击运行后，这段文字会作为会话的第一条用户消息。';
  byId('tab-skills').textContent = native ? 'Skill 与判定证据' : 'Skill 配置';
  if (!native) return;
  const { scenario, expected, expectation, confirmationPrompt, gateCommandIds } = native;
  byId('review-native-scenario').textContent = `原生 OpenCode · ${nativeScenarios[scenario]}`;
  byId('review-native-expected').value = expected;
  byId('review-native-confirmation').value = confirmationPrompt;
  for (const [name, id] of Object.entries(nativeLists)) byId(`review-native-${id}`).value = expectation[name].join('\n');
  byId('review-native-write-policy').value = expectation.writePolicy;
  renderNativePolicy(expectation.writePolicy);
  byId('review-native-before-write').checked = expectation.skillBeforeWrite;
  byId('review-native-require-change').checked = expectation.requireChange;
  byId('native-path-evidence').open = scenario === 'approval-gate' || scenario === 'code-standards';
  byId('review-native-discovery').open = false;
  renderNativeGateCommands(data.commands, gateCommandIds);
  renderNativeDiscovery(byId('review-native-discovery-content'), testCase.native.discovery);
}

function renderSkillProfile(profileId, sample) {
  const profile = skillProfiles.find(({ id }) => id === profileId);
  const hint = sample ? '内置样例沿用固定对照条件。Java + Vue 场景支持工作流和工程规范。'
    : profile?.description ?? (profileId === 'none' ? '仅使用原项目文件及任务提示词。' : '本机缺少该版本的 Skill 包。');
  const record = selectedCase();
  const stale = record?.status === 'approved' && record.skillProfile === profileId && skillLockChanged(record);
  byId('skill-profile-help').textContent = stale
    ? `已审核版本为 ${(record.skillLocks ?? []).map(({ id, version }) => `${id} ${version}`).join('、')}。下方显示本机版本，请重新审核。`
    : hint;
  const rows = (profile?.packs ?? []).map((pack) => {
    const item = element('li', 'skill-pack');
    const heading = element('div', 'skill-pack-meta');
    const source = element('a', null, '上游来源');
    source.href = pack.source;
    source.target = '_blank';
    source.rel = 'noopener noreferrer';
    heading.append(element('strong', null, pack.title), element('small', null, `${pack.role === 'workflow' ? '工作流' : '工程规范'} · ${pack.version}`), source);
    item.append(heading, element('p', null, `${pack.skills.length} 项原生 Skill`));
    return item;
  });
  byId('skill-profile-packs').replaceChildren(...rows);
}

function skillLockChanged(record) {
  const id = record.skillProfile ?? 'none';
  if (id === 'none') return false;
  const profile = skillProfiles.find((entry) => entry.id === id);
  const locks = record.skillLocks;
  return !profile || (Array.isArray(locks) && (locks.length !== profile.packs.length || locks.some((lock) =>
    !profile.packs.some((pack) => lock.id === pack.id && lock.version === pack.version && lock.revision === pack.revision))));
}

function changeTab(name, shouldFocus = false) {
  currentTab = name;
  for (const tab of tabs) {
    const control = byId(`tab-${tab}`);
    control.setAttribute('aria-selected', String(name === tab));
    control.tabIndex = name === tab ? 0 : -1;
    byId(`content-${tab}`).hidden = name !== tab;
  }
  if (shouldFocus) byId(`tab-${name}`).focus();
}

function skillSuiteState(row) {
  const record = row.caseId && cases.find(({ id }) => id === row.caseId);
  const current = record?.version >= (row.caseVersion ?? 0) ? record : null;
  return { id: row.caseId, version: current?.version ?? row.caseVersion,
    status: current?.status ?? row.caseStatus ?? 'draft', dirty: draftEdits.has(row.caseId) };
}

function approvedSuiteCases(suite) {
  return suite.rows.map(skillSuiteState).filter(({ id, version, status, dirty }) =>
    id && Number.isInteger(version) && status === 'approved' && !dirty);
}

function unrunSuiteCases(suite) {
  return approvedSuiteCases(suite).filter(({ id, version }) => latestRun(id)?.caseVersion !== version);
}

function rememberSkillSuite(id, suite) {
  skillSuites.set(id, suite);
  if (suite) {
    skillSuites.set(suite.parentCaseId, suite);
    for (const row of suite.rows) if (row.caseId) skillSuites.set(row.caseId, suite);
  }
}

async function loadSkillSuite(testCase, { refresh = false } = {}) {
  if (!testCase || testCase.profile === 'sample' || skillSuiteRequests.has(testCase.id)
    || (!refresh && skillSuites.has(testCase.id))) return;
  const request = api(skillSuiteRoute(testCase.id));
  skillSuiteRequests.set(testCase.id, request);
  renderSkillSuite();
  try {
    const { suite } = await request;
    rememberSkillSuite(testCase.id, suite ?? null);
  } catch (error) {
    if (error.status === 404) rememberSkillSuite(testCase.id, null);
    else if (caseId === testCase.id) setNotice(`读取测试用例清单失败。${error.message}`);
  } finally {
    skillSuiteRequests.delete(testCase.id);
    renderSkillSuite();
  }
}

async function openSuiteCase(id, run) {
  const navigation = navigationVersion;
  try {
    if (!cases.some((record) => record.id === id)) {
      const { case: record } = await api(caseRoute(id));
      rememberCase(record);
    }
    if (navigation !== navigationVersion) return;
    if (run) openRun(run);
    else {
      chooseCase(id, undefined, { edit: true });
      focusReportHeading('case-title', 'case-panel');
    }
  } catch (error) {
    if (navigation === navigationVersion) setNotice(error.message);
  }
}

function suiteCell(label, ...content) {
  const cell = element('div', 'skill-suite-cell');
  cell.append(element('strong', 'skill-suite-cell-label', label), ...content);
  return cell;
}

function skillExpectations(row) {
  const required = row.expectedSkills ?? [];
  const forbidden = row.forbiddenSkills ?? [];
  const contents = [];
  if (required.length) {
    const list = element('ul', 'skill-suite-tags');
    for (const skill of required) list.append(element('li', null, skill));
    contents.push(list);
  } else contents.push(element('p', null, '未指定必读 Skill'));
  if (forbidden.length) contents.push(element('p', 'skill-suite-forbidden', `不应读取 ${forbidden.join('、')}`));
  return contents;
}

function writeCriteria({ writePolicy, paths, approvalFiles, postApprovalPaths, requireChange, skillBeforeWrite, requiredReads, minChildSessions }, confirmation) {
  const criteria = [];
  if (writePolicy === 'none') criteria.push('保持项目文件不变，没有写入尝试。');
  if (writePolicy === 'proposal-only') {
    criteria.push(paths.length ? `确认前只允许改动 ${paths.join('、')}。` : '请在编辑区指定确认前可改动的文件。');
    if (approvalFiles.length) criteria.push(`确认前需生成或修改 ${approvalFiles.join('、')}。`);
    criteria.push(confirmation ? '门禁通过后在同一会话发送确认。' : '停在首轮，等待确认。');
    if (confirmation && postApprovalPaths.length) criteria.push(`确认后允许修改 ${postApprovalPaths.join('、')}。`);
  }
  if (writePolicy === 'allow' && paths.length) criteria.push(`只允许改动 ${paths.join('、')}。`);
  if (requireChange) criteria.push('产生符合允许范围的文件改动。');
  if (skillBeforeWrite) criteria.push('首次写入前核验必读 Skill 正文。');
  if (requiredReads.length) criteria.push(`首次写入前读到 ${requiredReads.join('、')}。`);
  if (minChildSessions) criteria.push(`OpenCode 记录至少 ${minChildSessions} 个子会话。`);
  return criteria;
}

function renderReviewOverview(testCase, data) {
  const target = byId('review-overview-fields');
  const profile = skillProfiles.find(({ id }) => id === data.skillProfile);
  const signature = JSON.stringify([testCase.id, testCase.profile, data, profile?.title]);
  if (signature === reviewOverviewSignature) return;
  reviewOverviewSignature = signature;
  const expanded = target.dataset.caseId === testCase.id && target.querySelector('.review-complete-message')?.open;
  target.dataset.caseId = testCase.id;
  const native = data.native;
  const input = suiteCell(`发给 ${agentLabel(data.agent)} 的消息`);
  const message = data.prompt.trim();
  const excerpt = message.split(/\r?\n/u).slice(0, 6).join('\n').slice(0, 360).trimEnd();
  if (excerpt.length < message.length) {
    const details = element('details', 'skill-suite-confirmation review-complete-message');
    details.open = Boolean(expanded);
    details.append(element('summary', null, '查看完整消息'), element('p', 'skill-suite-message', data.prompt));
    input.append(element('p', 'skill-suite-message review-message-excerpt', excerpt + '…'), details);
  } else input.append(element('p', 'skill-suite-message', message || '请在编辑区填写要发送的消息。'));
  if (native?.confirmationPrompt) {
    const next = element('details', 'skill-suite-confirmation');
    next.append(element('summary', null, '门禁通过后发送的消息'), element('p', 'skill-suite-message', native.confirmationPrompt));
    input.append(next);
  }

  const expectation = (native ? native.expected : data.requirement).trim();
  const expected = suiteCell('预期结果', element('p', 'skill-suite-message', expectation || '请在编辑区补充预期。'));
  if (native && (native.expectation.expectedSkills.length || native.expectation.forbiddenSkills.length)) {
    expected.append(...skillExpectations(native.expectation));
  } else if (!native && data.skillProfile !== 'none') {
    expected.append(element('p', null, `使用 ${profile?.title ?? data.skillProfile}`));
  }

  const criteria = native ? writeCriteria({ ...native.expectation,
    minChildSessions: testCase.native.expectation?.minChildSessions }, native.confirmationPrompt) : [];
  if (testCase.profile === 'sample') criteria.push(...sampleChecks);
  for (const command of data.commands) {
    const label = command.label.trim() || [command.program, ...command.args].filter(Boolean).join(' ') || '未填写命令';
    const stage = command.phase === 'setup' ? '运行前准备' : native?.gateCommandIds.includes(command.id) ? '审批门禁' : '独立验收';
    criteria.push(`${stage}通过：${label}。`);
  }
  const list = element('ul', 'skill-suite-criteria');
  for (const condition of criteria) list.append(element('li', null, condition));
  const judgment = suiteCell('怎么判通过', list.children.length ? list : element('p', null, '请在编辑区添加可验证的通过条件。'));
  const fixtures = suiteFixtureDetails(testCase.native?.fixtureFiles);
  if (fixtures) judgment.append(fixtures);
  target.replaceChildren(input, expected, judgment);
}

function renderReviewEditor() {
  const toggle = byId('review-editor-toggle');
  byId('review-editor').hidden = !editingCase;
  toggle.textContent = editingCase ? '收起编辑' : '编辑用例';
  toggle.setAttribute('aria-expanded', String(editingCase));
  toggle.disabled = busy === 'review';
}

function focusReviewField(id) {
  editingCase = true;
  renderReviewActions();
  changeTab('spec');
  byId(id).focus();
}

function suiteSteps(steps) {
  const list = element('ol', 'skill-suite-criteria');
  for (const step of steps) list.append(element('li', null, step));
  return list;
}

function suiteDetail(label, key, openDetails) {
  const detail = element('details', 'skill-suite-detail');
  if (key) {
    detail.dataset.suiteDetail = key;
    detail.open = openDetails?.has(key) ?? false;
  }
  detail.append(element('summary', null, label));
  return detail;
}

function suiteFixtureDetails(files, rowKey, openDetails) {
  if (!files?.length) return null;
  const detail = suiteDetail(`AI 准备的测试文件（${files.length}）`, rowKey && `${rowKey}:fixtures`, openDetails);
  detail.append(element('p', null, '这些文件会写入评测副本。'));
  for (const { name, content } of files) {
    const file = suiteDetail(`.vibe-bench-fixtures/${name}`, rowKey && `${rowKey}:fixture:${name}`, openDetails);
    file.append(element('pre', null, content));
    detail.append(file);
  }
  return detail;
}

function showSuiteRow(key) {
  const row = [...byId('skill-suite-groups').querySelectorAll('[data-suite-row]')].find(({ dataset }) => dataset.suiteRow === key);
  if (!row) return;
  for (let parent = row.parentElement; parent && parent.id !== 'skill-suite-groups'; parent = parent.parentElement) {
    if (parent instanceof HTMLDetailsElement) parent.open = true;
  }
  row.querySelector('h5').focus({ preventScroll: true });
  row.scrollIntoView({ block: 'center' });
}

function suiteGap(row, actions, openDetails, proposing) {
  const { gap, repair } = row;
  if (suiteGapLabels[gap?.kind]) actions.append(element('strong', 'skill-suite-gap-kind', suiteGapLabels[gap.kind]));
  if (gap?.missing || row.reason) actions.append(element('p', 'skill-suite-prerequisite', gap?.missing ?? row.reason));
  const splitSteps = [['项目要补', gap?.projectSteps], ['平台要补', gap?.platformSteps]].filter(([, steps]) => steps?.length);
  if (splitSteps.length || gap?.steps?.length) {
    const detail = suiteDetail('怎么补', `${row.key}:gap`, openDetails);
    for (const [label, steps] of splitSteps) detail.append(element('strong', null, label), suiteSteps(steps));
    if (!splitSteps.length) detail.append(suiteSteps(gap.steps));
    actions.append(detail);
  }
  if (repair) {
    const detail = suiteDetail('查看 AI 补充建议', `${row.key}:repair`, openDetails);
    if (repair.summary) detail.append(element('p', null, repair.summary));
    if (repair.analysis && repair.analysis !== repair.summary) detail.append(element('p', null, repair.analysis));
    if (repair.steps?.length) detail.append(suiteSteps(repair.steps));
    if (repair.proposalKeys?.length) {
      detail.append(button('查看补充用例', 'text-button', () => showSuiteRow(repair.proposalKeys[0])));
    }
    actions.append(detail);
  }
  const helper = button('AI 帮我补', 'button secondary compact', () => openSuiteProposal(helper, row));
  helper.disabled = Boolean(busy) || proposing;
  helper.dataset.suiteFocus = `${row.key}:propose`;
  actions.append(helper);
}

function suiteRow(row, state, run, openDetails, proposing) {
  const item = element('li', 'skill-suite-row');
  item.dataset.suiteRow = row.key;
  const heading = element('h5', null, row.title);
  heading.tabIndex = -1;
  if (row.generatedByAi) heading.append(element('span', 'skill-suite-ai-label', 'AI 补充'));
  item.append(heading);
  const columns = element('div', 'skill-suite-columns');
  const input = suiteCell('发给 OpenCode 的消息', element('p', 'skill-suite-message', row.prompt));
  if (row.confirmationPrompt) {
    const continuation = element('details', 'skill-suite-confirmation');
    continuation.append(element('summary', null, '通过门禁后发送的确认'), element('p', 'skill-suite-message', row.confirmationPrompt));
    input.append(continuation);
  }
  const criteria = element('ul', 'skill-suite-criteria');
  for (const condition of row.criteria ?? []) criteria.append(element('li', null, condition));
  const judgment = suiteCell('怎么判通过', element('p', null, row.expected));
  if (criteria.children.length) judgment.append(criteria);
  const fixtures = suiteFixtureDetails(row.fixtureFiles, row.key, openDetails);
  if (fixtures) judgment.append(fixtures);
  const actions = suiteCell('审核与运行');
  if (state.id) {
    actions.append(badge(state.dirty ? 'draft' : state.status,
      state.dirty ? '修改待确认' : state.status === 'approved' ? '已确认' : '待确认'));
    if (state.status === 'draft' && !state.dirty) {
      const accept = button('确认用例', 'button secondary compact', () => { void approveSuiteCase(state); });
      accept.disabled = Boolean(busy);
      accept.dataset.suiteFocus = `${row.key}:approve`;
      actions.append(accept);
    }
    if (state.status === 'approved' && !state.dirty && !active.has(run?.status)) {
      const launch = button(run?.caseVersion === state.version ? '再跑一次' : '运行这条', 'button secondary compact',
        () => { void startSkillSuite(state.id); });
      launch.disabled = Boolean(busy) || anyRunActive();
      launch.dataset.suiteFocus = `${row.key}:launch`;
      actions.append(launch);
    }
    const review = element('a', 'text-button', '打开编辑');
    review.href = viewHref('workspace', { project: state.id, edit: true });
    review.dataset.suiteFocus = `${row.key}:review`;
    handleLink(review, () => { void openSuiteCase(state.id); });
    actions.append(review);
  } else {
    actions.append(badge('blocked', '暂时不能运行'));
    suiteGap(row, actions, openDetails, proposing);
  }
  if (run) {
    const old = run.caseVersion !== state.version;
    actions.append(runBadge(run));
    if (old) actions.append(element('p', null, `记录来自 v${run.caseVersion}`));
    const current = run.checks.find(({ status }) => status === 'running');
    if (active.has(run.status) && current) actions.append(element('p', null, current.title));
    const report = element('a', 'text-button', active.has(run.status) ? '查看进度' : '查看结果');
    report.href = runHref(run);
    report.dataset.suiteFocus = `${row.key}:run`;
    handleLink(report, () => { void openSuiteCase(state.id, run); });
    actions.append(report);
  }
  columns.append(input, suiteCell('预期 Skill', ...skillExpectations(row)), judgment, actions);
  item.append(columns);
  return item;
}

function renderSkillSuite() {
  const testCase = selectedCase();
  const suite = skillSuites.get(caseId);
  const parentId = testCase?.skillSuite?.parentCaseId ?? suite?.parentCaseId;
  const child = Boolean(parentId && parentId !== caseId);
  const available = testCase && !creating && !child && isCaseList(testCase);
  byId('skill-suite-review').hidden = !available;
  byId('skill-suite-propose').hidden = !available || !suite;
  byId('skill-suite-parent').hidden = !testCase || creating || !child;
  if (child) byId('skill-suite-back').href = viewHref('workspace', { project: parentId });
  const grouped = Boolean(available && suite);
  const canShowOriginal = grouped && !testCase.skillSuiteRoot;
  const individualOpen = !testCase?.skillSuiteRoot && (!available || expandedSingleReviews.has(caseId));
  const individual = byId('case-individual-review');
  const suitePanel = byId('skill-suite-review');
  const settings = byId('skill-suite-settings');
  individual.hidden = !individualOpen;
  settings.hidden = !canShowOriginal;
  if (grouped && suitePanel.nextElementSibling !== settings) settings.before(suitePanel);
  if (!grouped && individual.nextElementSibling !== suitePanel) individual.after(suitePanel);
  byId('skill-suite-settings-toggle').textContent = individualOpen ? '收起原单条用例' : '查看原单条用例';
  byId('skill-suite-settings-toggle').setAttribute('aria-expanded', String(individualOpen));
  if (!available) return;

  const loading = skillSuiteRequests.has(caseId);
  byId('skill-suite-status').hidden = !loading;
  byId('skill-suite-status').textContent = loading ? '正在读取测试用例清单…' : '';
  byId('skill-suite-body').hidden = !grouped;
  if (!grouped) return;

  const proposing = suiteProposalRequests.has(parentId);
  const proposalNotice = suiteProposalNotices.get(parentId);
  byId('skill-suite-propose').disabled = Boolean(busy) || proposing;
  byId('skill-suite-proposal-result').hidden = !proposalNotice;
  byId('skill-suite-proposal-result').classList.toggle('proposal-error', Boolean(proposalNotice?.error));
  const noticeText = byId('skill-suite-proposal-notice');
  if (noticeText.textContent !== (proposalNotice?.summary ?? '')) noticeText.textContent = proposalNotice?.summary ?? '';
  byId('skill-suite-proposal-jump').hidden = !proposalNotice?.key;
  const approved = approvedSuiteCases(suite);
  const unrun = unrunSuiteCases(suite);
  const newest = new Map();
  for (const run of newestRuns()) if (!newest.has(run.caseId)) newest.set(run.caseId, run);
  const rows = suite.rows.map((row) => ({ row, state: skillSuiteState(row), run: row.caseId && newest.get(row.caseId) }));
  const total = rows.filter(({ state }) => state.id).length;
  const queued = rows.filter(({ run }) => run?.status === 'queued').length;
  const running = rows.filter(({ run }) => ['running', 'preparing'].includes(run?.status)).length;
  const summary = [];
  if (total > approved.length) summary.push(`${total - approved.length} 条待确认`);
  if (unrun.length) summary.push(`${unrun.length} 条已确认待运行`);
  if (approved.length > unrun.length) summary.push(`${approved.length - unrun.length} 条已有运行记录`);
  if (!total) summary.push('当前没有可确认的用例');
  if (queued) summary.push(`${queued} 条排队中`);
  if (running) summary.push(`${running} 条运行中`);
  byId('skill-suite-summary').textContent = summary.join(' · ');
  const launch = byId('skill-suite-run');
  launch.hidden = !unrun.length;
  launch.disabled = Boolean(busy) || anyRunActive() || !unrun.length;
  launch.textContent = busy === 'skill-suite-run' ? '正在加入队列…' : `运行待测的 ${unrun.length} 条`;
  const signature = JSON.stringify([suite.id, suite.groups, suite.coverage, Boolean(busy), anyRunActive(), proposing, rows.map(({ row, state, run }) =>
    [row, state, run?.id, run?.status, run?.nativeCase?.verdict, run?.checks.map(({ status, title }) => [status, title])])]);
  if (signature === skillSuiteSignature) return;
  skillSuiteSignature = signature;

  const groups = byId('skill-suite-groups');
  const previousOpen = new Map([...groups.querySelectorAll('details[data-group]')].filter((item) => item.dataset.suiteId === suite.id)
    .map((item) => [item.dataset.group, item.open]));
  const openDetails = new Set([...groups.querySelectorAll('details[data-suite-detail][open]')]
    .filter((detail) => detail.closest('.skill-suite-group')?.dataset.suiteId === suite.id)
    .map(({ dataset }) => dataset.suiteDetail));
  const focus = groups.contains(document.activeElement) && document.activeElement.dataset.suiteFocus;
  function renderGroups(items, prefix, openFirst) {
    return suite.groups.flatMap(({ id, title }) => {
      const members = items.filter(({ row }) => row.group === id);
      if (!members.length) return [];
      const group = element('details', 'skill-suite-group');
      group.dataset.suiteId = suite.id;
      group.dataset.group = prefix + id;
      group.open = previousOpen.get(group.dataset.group) ?? (openFirst && id === items[0]?.row.group);
      const heading = element('summary');
      heading.append(element('strong', null, title), element('small', null, `${members.length} 条用例`));
      const list = element('ul', 'skill-suite-list');
      for (const member of members) list.append(suiteRow(member.row, member.state, member.run, openDetails, proposing));
      group.append(heading, list);
      return [group];
    });
  }
  const ready = rows.filter(({ state }) => state.id);
  const blocked = rows.filter(({ state }) => !state.id);
  const sections = renderGroups(ready, 'ready:', true);
  if (blocked.length) {
    const more = element('details', 'skill-suite-group skill-suite-unavailable');
    more.dataset.suiteId = suite.id;
    more.dataset.group = 'unavailable';
    more.open = previousOpen.get('unavailable') ?? !ready.length;
    more.append(element('summary', null, `查看暂时不能运行的 ${blocked.length} 条及原因`), ...renderGroups(blocked, 'blocked:', !ready.length));
    sections.push(more);
  }
  groups.replaceChildren(...sections);
  if (focus) {
    const controls = [...groups.querySelectorAll('[data-suite-focus]')];
    const next = controls.find((node) => node.dataset.suiteFocus === focus)
      ?? controls.find((node) => node.dataset.suiteFocus === focus.replace(/:approve$/u, ':review'));
    next?.focus({ preventScroll: true });
  }
  const coverage = suite.coverage ?? [];
  byId('skill-suite-coverage').hidden = !coverage.length;
  byId('skill-suite-coverage-title').textContent = `查看 ${coverage.length} 项 Skill 的用例覆盖`;
  byId('skill-suite-coverage-list').replaceChildren(...coverage.map(({ name, path, sceneKeys, runnableSceneKeys, negativeSceneKeys }) => {
    const item = element('li');
    const count = runnableSceneKeys?.length ?? 0;
    const planned = sceneKeys?.length ?? 0;
    const negative = negativeSceneKeys?.length ?? 0;
    const description = [count ? `${count} 条可审核` : planned ? '暂时不能运行' : '暂无用例'];
    if (negative) description.push(`${negative} 条误触发检查`);
    const label = element('code', null, name);
    label.title = path;
    item.append(label, element('span', null, description.join(' · ')));
    return item;
  }));
}

function renderReview() {
  const testCase = selectedCase();
  const review = byId('case-panel');
  review.hidden = !testCase || creating || (reportFirst && Boolean(runId));
  byId('create-panel').hidden = !creating;
  positionExecution();
  renderFlow();
  renderSkillSuite();
  if (!testCase || creating) return;
  void loadSkillSuite(testCase);
  byId('case-title').textContent = testCase.title;
  byId('case-path').textContent = testCase.projectDir;
  byId('case-state').replaceWith(Object.assign(badge(testCase.status,
    testCase.status === 'approved' ? '已确认' : '待确认'), { id: 'case-state', hidden: isCaseList(testCase) }));
  byId('case-version').hidden = isCaseList(testCase);
  byId('case-version').textContent = `v${testCase.version}`;
  if (testCase.skillSuiteRoot) {
    byId('case-agent-name').textContent = 'OpenCode 原生';
    return;
  }
  const data = draftEdits.get(caseId) ?? caseData(testCase);
  for (const name of editors) byId(`review-${name}`).value = data[name];
  byId('review-agent').value = data.agent;
  byId('case-agent-name').textContent = data.native ? 'OpenCode 原生' : agentLabel(data.agent);
  const sample = testCase.profile === 'sample';
  const skillSelect = byId('review-skill-profile');
  const available = skillProfiles.length ? skillProfiles : [{ id: 'none', title: '无配置 Skill' }];
  const options = sample ? available.filter(({ id }) => id === 'none') : [...available];
  if (!options.some(({ id }) => id === data.skillProfile)) options.push({ id: data.skillProfile, title: `${data.skillProfile}（本机缺少）` });
  skillSelect.replaceChildren(...options.map(({ id, title }) => Object.assign(element('option', null, title), { value: id })));
  skillSelect.value = data.skillProfile;
  if (!data.native) renderSkillProfile(data.skillProfile, sample);
  byId('command-help').hidden = sample;
  byId('sample-checks').hidden = !sample;
  byId('add-command').hidden = sample;
  if (sample) {
    const list = element('ul', 'sample-list');
    for (const check of sampleChecks) {
      const entry = element('li');
      entry.append(icon('check'), check);
      list.append(entry);
    }
    byId('sample-checks').replaceChildren(element('p', 'field-help', '内置样例执行以下六项固定验收。'), list);
  }
  byId('commands').replaceChildren(...data.commands.map(commandRow));
  renderNativeReview(testCase, data);
  const files = [];
  for (const name of testCase.sourceFiles ?? []) {
    const row = element('li');
    const trigger = button(null, 'source-button', () => showSource(testCase, name, trigger));
    trigger.prepend(icon('file'));
    trigger.append(name);
    row.append(trigger);
    files.push(row);
  }
  byId('source-files').replaceChildren(...(files.length ? files : [element('li', 'empty-small', '未识别出可预览的项目文件。')]));
  changeTab(currentTab);
  renderReviewActions();
}

function renderReviewActions() {
  renderSkillSuite();
  const testCase = selectedCase();
  if (!testCase || creating || testCase.skillSuiteRoot) return;
  const dirty = draftEdits.has(caseId);
  const approval = testCase.status === 'approved';
  const stale = approval && skillLockChanged(testCase);
  const run = runs.get(projectRunId);
  const runningHere = run?.caseId === caseId && active.has(run.status);
  const data = draftEdits.get(caseId) ?? caseData(testCase);
  renderReviewOverview(testCase, data);
  renderReviewEditor();
  byId('case-agent-name').textContent = data.native ? 'OpenCode 原生' : agentLabel(data.agent);
  byId('command-count').textContent = String(testCase.profile === 'sample' ? sampleChecks.length : data.commands.length);
  byId('save-case').hidden = !dirty || !editingCase;
  byId('save-case').disabled = Boolean(busy) || !dirty;
  byId('approve-case').hidden = approval && !dirty && !stale;
  byId('approve-case').disabled = Boolean(busy);
  byId('approve-case').classList.toggle('primary', !byId('approve-case').hidden);
  byId('approve-case').classList.toggle('secondary', byId('approve-case').hidden);
  byId('run-case').hidden = !byId('approve-case').hidden;
  byId('run-case').disabled = Boolean(busy) || dirty || !approval || anyRunActive() || stale;
  byId('run-case').classList.toggle('primary', byId('approve-case').hidden);
  byId('run-case').classList.toggle('secondary', !byId('approve-case').hidden);
  byId('run-case').lastElementChild.textContent = runningHere ? '用例执行中' : run?.caseVersion === testCase.version ? '再次运行' : '运行用例';
  byId('add-command').disabled = Boolean(busy) || data.commands.length >= 20;
  for (const control of byId('review-form').querySelectorAll('input, select, textarea, .command .icon-button')) {
    control.disabled = busy === 'review';
  }
  byId('review-skill-profile').disabled ||= testCase.profile === 'sample';
  let hint = '看完要发送的消息和通过条件后，确认这条用例。';
  if (dirty) hint = '确认修改后，按新内容运行。';
  else if (runningHere) hint = `正在执行 v${run.caseVersion}。`;
  else if (stale) hint = 'Skill 包版本已变更，请重新审查配置。';
  else if (approval && anyRunActive()) hint = '已有评测正在运行，完成后可以开始下一轮。';
  else if (approval) hint = '已确认，可以运行。';
  byId('review-hint').textContent = hint;
}

function groupRuns(records) {
  const groups = new Map();
  for (const run of records) {
    const id = run.experimentId ?? run.id;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(run);
  }
  return [...groups.values()];
}

function runListSignature(groups) {
  return groups.map((members) => members.map((run) => [
    run.id, run.caseTitle, run.status, run.testTarget?.verdict ?? run.nativeCase?.verdict, run.checks.map(({ status }) => status),
  ]));
}

function renderRunRows(container, groups, { recent = false } = {}) {
  const focused = container.contains(document.activeElement) ? document.activeElement.dataset.runGroup : undefined;
  const list = document.createDocumentFragment();
  for (const members of groups) {
    const latest = members[0];
    const experiment = latest.experimentId;
    const run = experiment ? experimentRun(members) : latest;
    const id = experiment ?? run.id;
    const profile = skillProfiles.find(({ id }) => id === run.skillProfile);
    const title = run.testTarget?.title ?? (run.caseId ? run.caseTitle : experiment ? '四组对照'
      : recent || run.mode === 'demo' ? runLabel(run) : fixtureTitle);
    const details = [
      run.caseId ? `v${run.caseVersion}` : null,
      experiment ? 'Codex · OpenCode' : !run.testTarget && (recent || run.mode === 'demo') ? null : runLabel(run),
      run.scenario || run.skillProfile !== 'none' ? profile?.title : null,
      formatTime(latest.createdAt || latest.startedAt),
    ].filter(Boolean).join(' · ');
    const link = element('a', 'history-run');
    link.dataset.runGroup = id;
    link.href = experiment ? viewHref('benchmark', { experiment }) : runHref(run);
    if (recent && (experiment ? experiment === benchmarkExperimentId : run.id === benchmarkRunId)) {
      link.setAttribute('aria-current', 'true');
    }
    handleLink(link, () => openRun(run, { group: Boolean(experiment) }));
    const copy = element('span', 'history-run-meta');
    copy.append(element('strong', null, title), element('small', null, details));
    link.append(copy, experiment ? badge(experimentStatus(members)) : runBadge(run));
    list.append(link);
  }
  if (!groups.length) list.append(element('p', 'empty-small', '暂无评测记录。'));
  container.replaceChildren(list);
  if (focused) [...container.children].find((node) => node.dataset.runGroup === focused)?.focus({ preventScroll: true });
}

function renderHistory() {
  const filtered = newestRuns().filter((run) => historyFilter === 'all' || Boolean(run.caseId) === (historyFilter === 'project'));
  const groups = groupRuns(filtered);
  const signature = JSON.stringify([historyFilter, skillProfiles.length, runListSignature(groups)]);
  if (signature === historySignature) return;
  historySignature = signature;
  byId('history-filter').value = historyFilter;
  byId('history-count').textContent = `共 ${groups.length} 条记录`;
  renderRunRows(byId('history-list'), groups);
}

function renderRunLists() {
  if (view === 'history') renderHistory();
  if (view === 'benchmark') {
    const native = Boolean(selectedRun()?.testTarget);
    byId('benchmark-title').textContent = native ? 'TestTarget 工作流评测' : fixtureTitle;
    byId('benchmark-description').textContent = native
      ? '核对 DeepSeek 实跑的项目审批、Skill 取证和独立验收。'
      : '用同一份样例验证 Skill 加载、状态筛选和测试辨别力。';
    const records = builtinRuns();
    const groups = groupRuns(records).slice(0, 8);
    const signature = JSON.stringify([benchmarkRunId, benchmarkExperimentId, runListSignature(groups)]);
    if (recentSignature !== signature) {
      recentSignature = signature;
      byId('benchmark-recent-count').textContent = String(groups.length);
      renderRunRows(byId('benchmark-recent-list'), groups, { recent: true });
    }
    renderComparison(records.filter((run) => benchmarkExperimentId && run.experimentId === benchmarkExperimentId), benchmarkRunId);
    renderTestTargetSuite();
    updateBenchmarkScrollHints();
  }
}

function testTargetVerification(run) {
  const locked = run?.checks.find(({ id }) => id === 'verification');
  if (locked) return badge(locked.status, labels[locked.status]);
  const checks = run?.checks.filter(({ id }) => ['build', 'browser', 'mutation'].includes(id)) ?? [];
  if (checks.length && checks.every(({ status }) => status === 'pass')) return badge('pass');
  if (checks.some(({ status }) => status === 'fail' || status === 'error')) return badge('fail');
  if (checks.some(({ status }) => status === 'blocked' || status === 'interrupted')) return badge('blocked');
  if (checks.some(({ status }) => active.has(status))) return badge('running');
  if (checks.length && checks.every(({ status }) => status === 'skipped')) return badge('skipped');
  if (run && !active.has(run.status) && !checks.length) return badge('skipped', '未执行');
  return badge('pending');
}

function approvalBadge(status) {
  const [tone, text] = Object.hasOwn(approvalStates, status)
    ? approvalStates[status] : [status || 'pending', Object.hasOwn(labels, status) ? labels[status] : status];
  return badge(tone, text);
}

function targetApprovalBadge(run) {
  const approval = run?.testTarget?.approvals?.at(-1);
  if (approval) return approvalBadge(approval.status);
  const check = run?.checks.find(({ id }) => id === 'approval');
  return badge(check?.status ?? 'pending', check ? labels[check.status] : '未记录');
}

function renderTestTargetSuite() {
  if (!targetTrials) return;
  const suite = byId('testtarget-suite');
  suite.hidden = false;
  const visibleSuite = selectedRun()?.testTarget?.suiteId ?? targetSuiteId;
  const attempts = newestRuns().filter((run) => visibleSuite && run.testTarget?.suiteId === visibleSuite);
  const cases = targetTrials.map(({ id }) => attempts.find(({ testTarget }) => testTarget.trialId === id)).filter(Boolean);
  const list = byId('testtarget-trials');
  const signature = JSON.stringify([visibleSuite, runId, targetTrials, cases.map((run) =>
    [run.id, run.status, run.testTarget.verdict, run.testTarget.approvals, run.checks.map(({ status }) => status)])]);
  if (signature === targetSignature) return;
  targetSignature = signature;

  const finished = cases.filter(({ status }) => !active.has(status)).length;
  byId('testtarget-summary').textContent = visibleSuite
    ? `已结束 ${finished} / ${targetTrials.length} 轮${visibleSuite !== targetSuiteId ? ' · 历史批次' : ''}`
    : '等待首次运行。';
  const focused = list.contains(document.activeElement) ? document.activeElement.dataset.runId : undefined;
  const rows = document.createDocumentFragment();
  for (const trial of targetTrials) {
    const run = cases.find(({ testTarget }) => testTarget.trialId === trial.id);
    const row = element('li', 'target-suite-trial');
    if (run?.id === runId) row.dataset.selected = '';
    const copy = element('div', 'target-trial-title');
    copy.append(element('strong', null, trial.title), element('span', null, trial.condition));
    const indicators = element('div', 'target-trial-indicators');
    const skill = run?.checks.find(({ id }) => id === 'skill');
    const skillRead = skill?.status === 'pass' && run?.testTarget.trialId === 'order-masked'
      ? badge('pass', '屏蔽已核对') : badge(skill?.status ?? 'pending', skill?.status === 'pass' ? '已核对' : labels[skill?.status]);
    for (const [label, indicator] of [
      ['审批', targetApprovalBadge(run)],
      ['Skill 证据', skillRead],
      ['验收', testTargetVerification(run)],
      ['场景结果', run ? runBadge(run) : badge('pending', '待运行')],
    ]) {
      const cell = element('div', 'target-trial-indicator');
      cell.append(element('span', null, label), indicator);
      indicators.append(cell);
    }
    row.append(copy, indicators);
    if (run) {
      const link = element('a', 'button secondary compact', '查看报告');
      link.href = runHref(run);
      link.dataset.runId = run.id;
      link.setAttribute('aria-label', `查看 ${trial.title} ${trial.condition} 的报告`.trim());
      handleLink(link, () => openRun(run));
      row.append(link);
    }
    rows.append(row);
  }
  list.replaceChildren(rows);
  if (focused) [...list.querySelectorAll('a')].find(({ dataset }) => dataset.runId === focused)?.focus({ preventScroll: true });
}

function renderLaunchActions() {
  const running = anyRunActive();
  for (const id of ['run-single', 'run-experiment', 'run-demo', 'run-retest', 'demo-link']) byId(id).disabled = !loaded || Boolean(busy) || running;
  byId('run-testtarget').disabled = !loaded || !targetTrials || Boolean(busy) || running;
  byId('run-testtarget').textContent = busy === 'testtarget' ? '正在发起…' : '运行四轮';
  byId('benchmark-run-hint').textContent = running
    ? '已有评测正在运行，完成后可以开始下一轮。'
    : '四组对照使用 Codex 和 OpenCode，各运行有 Skill 与无 Skill 两组。';
}

function setBusy(action) {
  busy = action;
  const busyCreating = ['create', 'discovery'].includes(action);
  byId('generate').disabled = Boolean(action);
  renderCreateChoice();
  for (const control of byId('create-form').querySelectorAll('input, textarea, select')) control.disabled = busyCreating;
  byId('discover-project').disabled = Boolean(action);
  byId('use-sample').disabled = busyCreating;
  byId('use-java-vue').disabled = busyCreating;
  byId('cancel-create').disabled = busyCreating;
  renderReviewActions();
  renderLaunchActions();
}

function rememberCase(record) {
  cases = [record, ...cases.filter(({ id }) => id !== record.id)];
  draftEdits.delete(record.id);
}

function chooseCase(id, requestedRun, { create = false, edit = false, focus = true, focusExecution = false, update = 'pushState' } = {}) {
  const changed = caseId !== id || creating !== create;
  caseId = id;
  creating = create;
  view = 'workspace';
  reportFirst = Boolean(requestedRun);
  editingCase = edit && !reportFirst;
  if (changed) currentTab = 'spec';
  setNotice('');
  projectRunId = requestedRun ?? latestRun(id)?.id ?? null;
  selectRun(projectRunId);
  renderNavigation();
  renderCases();
  renderReview();
  updateLocation(update);
  if (focusExecution && runId && !creating) focusRun();
  else if (focus && changed && !creating && selectedCase()) byId('case-title').focus({ preventScroll: true });
}

function showBenchmark(id, experiment, { focusExecution = false, group = false, launch = false, update = 'pushState' } = {}) {
  const changed = view !== 'benchmark' || benchmarkGroup !== group || benchmarkLaunch !== launch
    || benchmarkRunId !== id || benchmarkExperimentId !== experiment;
  view = 'benchmark';
  benchmarkRunId = id;
  benchmarkExperimentId = experiment;
  benchmarkGroup = group;
  benchmarkLaunch = launch;
  if (changed && !launch) byId('benchmark-setup').open = false;
  if (changed) byId('testtarget-suite').open = Boolean(runs.get(id)?.testTarget);
  setNotice('');
  selectRun(benchmarkRunId);
  renderExecution();
  renderNavigation();
  updateLocation(update);
  if (focusExecution && group && !byId('comparison').hidden) focusReportHeading('comparison-title', 'comparison');
  else if (focusExecution && runId) focusRun();
}

function openRun(run, { group = false } = {}) {
  if (run.caseId) {
    chooseCase(run.caseId, run.id, { focusExecution: true });
    if (!selectedCase()) setNotice('找不到关联的项目用例。');
  } else {
    showBenchmark(run.id, run.experimentId, { focusExecution: true, group });
  }
}

async function startBenchmark(body, experiment = false) {
  if (!loaded || busy || anyRunActive()) return;
  const navigation = navigationVersion;
  setBusy('benchmark');
  setNotice('');
  try {
    const response = await api(experiment ? '/api/experiments' : '/api/runs', { method: 'POST', body });
    const admitted = experiment ? response.runs : [response.run];
    for (const run of admitted) runs.set(run.id, run);
    const run = experiment ? experimentRun(admitted) : admitted[0];
    if (navigation === navigationVersion) {
      showBenchmark(run.id, run.experimentId, { focusExecution: true, group: experiment });
    } else {
      renderRunLists();
    }
  } catch (error) {
    setNotice(error.message);
    if (navigation === navigationVersion) byId('notice').scrollIntoView({ block: 'nearest' });
  } finally {
    setBusy('');
  }
}

async function startTestTarget() {
  if (!loaded || !targetTrials || busy || anyRunActive()) return;
  const navigation = navigationVersion;
  setBusy('testtarget');
  setNotice('');
  try {
    const { suiteId, runs: admitted } = await api('/api/testtarget', { method: 'POST', body: {} });
    targetSuiteId = suiteId;
    for (const run of admitted) runs.set(run.id, run);
    if (navigation === navigationVersion) {
      showBenchmark(admitted[0]?.id ?? null, null);
      focusReportHeading('testtarget-title', 'testtarget-suite');
    } else {
      renderRunLists();
    }
  } catch (error) {
    setNotice(error.message);
    if (navigation === navigationVersion) byId('notice').scrollIntoView({ block: 'nearest' });
  } finally {
    setBusy('');
  }
}

function openCreate() {
  creating = true;
  setNotice('');
  renderCreateChoice();
  renderNavigation();
  renderCases();
  renderReview();
  updateLocation('pushState');
  byId('create-kind').querySelector(':checked').focus();
}

function projectPath(value) {
  return value.trim().replace(/^"(.*)"$/u, '$1');
}

function clearDiscovery() {
  discoveryPath = '';
  byId('discovery-status').textContent = '';
  byId('discovery-preview').hidden = true;
  byId('discovery-preview').open = false;
  byId('discovery-preview-content').replaceChildren();
  byId('create-native-skill-field').hidden = true;
  byId('create-native-skill').replaceChildren();
}

function changeCreatePurpose(value) {
  byId('create-purpose').value = value;
  byId('create-native-skill').value = '';
  renderCreateChoice();
}

function renderCreateChoice() {
  const multi = byId('create-kind').querySelector(':checked')?.value === 'suite';
  const purpose = byId('create-purpose').value;
  const needsSkill = !multi && purpose === 'auto-trigger';
  const slot = byId(needsSkill ? 'create-target-slot' : 'create-discovery-slot');
  const discovery = byId('native-create');
  if (discovery.parentElement !== slot) slot.append(discovery);
  byId('create-target-slot').hidden = !needsSkill;
  byId('create-discovery-slot').hidden = needsSkill || !multi && purpose === 'project-tests';
  byId('create-purpose-field').hidden = multi;
  byId('create-project-shortcuts').hidden = multi;
  byId('create-requirement-field').hidden = multi;
  byId('create-title-label').textContent = multi ? '清单名称' : '用例名称';
  byId('create-title-input').placeholder = multi ? '例如，订单项目 Skill 测试' : '例如，订单筛选分析';
  byId('create-requirement').placeholder = purpose === 'analysis-only'
    ? '例如，说明订单列表的数据从哪来。'
    : '例如，给订单列表增加状态筛选。';
  byId('create-requirement-hint').textContent = purpose === 'auto-trigger'
    ? '按平常的方式描述任务。直接点名 Skill 会影响对自动触发的判断。'
    : purpose === 'project-tests' ? '使用内置样例时可留空。' : '留空会使用示例任务，可以在审核时调整。';
  const skills = byId('create-native-skill');
  const canSelectSkill = !multi && ['analysis-only', 'auto-trigger', 'code-standards'].includes(purpose);
  byId('create-native-skill-field').hidden = !canSelectSkill || skills.options.length < 2;
  byId('create-native-skill-label').textContent = purpose === 'analysis-only'
    ? '不应读取的 Skill（可选）' : needsSkill ? '预期读取的 Skill' : '预期读取的 Skill（可选）';
  if (skills.options[0]) skills.options[0].textContent = needsSkill ? '请选择要验证的 Skill'
    : purpose === 'analysis-only' ? '不限制 Skill' : '按项目建议';
  byId('generate').firstChild.data = busy === 'create' ? '正在生成…' : multi ? '生成多条测试用例' : '生成审核草稿';
}

async function discoverProject() {
  const input = byId('project-dir');
  if (busy || !input.reportValidity()) return;
  const path = projectPath(input.value);
  if (!path) {
    setNotice('请填写本地项目目录。');
    input.focus();
    return;
  }
  setNotice('');
  clearDiscovery();
  setBusy('discovery');
  byId('discovery-status').textContent = '正在扫描项目…';
  try {
    const { discovery } = await api('/api/cases/discover', { method: 'POST', body: { projectDir: path } });
    discoveryPath = path;
    byId('discovery-status').textContent = discovery.skills.length ? `找到 ${discovery.skills.length} 个 Skill。` : '这个项目没有可选的 Skill。';
    byId('discovery-preview').hidden = false;
    renderNativeDiscovery(byId('discovery-preview-content'), discovery);
    byId('create-native-skill').replaceChildren(...['', ...discovery.skills.map(({ name }) => name)].map((name) =>
      Object.assign(element('option', null, name), { value: name })));
    return true;
  } catch (error) {
    byId('discovery-status').textContent = '';
    setNotice(error.message);
    byId('notice').scrollIntoView({ block: 'nearest' });
    return false;
  } finally {
    setBusy('');
  }
}

async function createCase(event) {
  event.preventDefault();
  if (busy) return;
  const navigation = navigationVersion;
  const { createKind, ...requestBody } = Object.fromEntries(new FormData(event.currentTarget));
  const multi = createKind === 'suite';
  const purpose = byId('create-purpose').value;
  requestBody.projectDir = projectPath(requestBody.projectDir);
  if (!multi && purpose !== 'project-tests') {
    const skills = byId('create-native-skill');
    const targetSkill = byId('create-native-skill-field').hidden ? '' : skills.value;
    if (purpose === 'auto-trigger' && (!targetSkill || discoveryPath !== requestBody.projectDir)) {
      if (discoveryPath !== requestBody.projectDir && !await discoverProject()) return;
      if (navigation !== navigationVersion) return;
      if (skills.options.length > 1) {
        setNotice('请先选择预期读取的 Skill，再生成草稿。');
        skills.focus();
      } else {
        setNotice('这个项目没有可用的 Skill。可以换个项目，或选择其他检查。');
      }
      return;
    }
    requestBody.native = { scenario: purpose,
      ...(targetSkill && discoveryPath === requestBody.projectDir ? { targetSkill } : {}) };
  }
  setNotice('');
  setBusy('create');
  try {
    const path = multi ? '/api/cases/skill-suite' : '/api/cases';
    const body = multi ? { projectDir: requestBody.projectDir, title: requestBody.title } : requestBody;
    const { case: record, suite } = await api(path, { method: 'POST', body });
    byId('create-form').reset();
    byId('create-options').open = false;
    clearDiscovery();
    renderCreateChoice();
    rememberCase(record);
    if (suite) rememberSkillSuite(record.id, suite);
    if (navigation === navigationVersion) {
      chooseCase(record.id);
      if (suite) focusReportHeading('skill-suite-title', 'skill-suite-review');
    } else renderCases();
  } catch (error) {
    setNotice(error.message);
    if (navigation === navigationVersion) byId('notice').scrollIntoView({ block: 'nearest' });
  } finally {
    setBusy('');
  }
}

async function approveSuiteCase({ id, version }) {
  const parent = selectedCase();
  if (!parent || busy || draftEdits.has(id)) return;
  setNotice('');
  setBusy('skill-suite-approve');
  try {
    const { case: record } = await api(caseRoute(id), { method: 'PUT', body: { action: 'approve', version } });
    rememberCase(record);
    renderCases();
    await loadSkillSuite(parent, { refresh: true });
  } catch (error) {
    setNotice(error.message);
    if (error.status === 409) await loadSkillSuite(parent, { refresh: true });
  } finally {
    setBusy('');
  }
}

function renderSuiteProposalDialog() {
  const proposing = suiteProposalRequests.has(proposalContext?.parentId);
  byId('skill-proposal-message').readOnly = proposing;
  byId('skill-proposal-submit').disabled = proposing;
  byId('skill-proposal-submit').textContent = proposing ? 'AI 生成中…' : '生成用例草稿';
  byId('skill-proposal-cancel').textContent = proposing ? '返回清单' : '取消';
}

function openSuiteProposal(trigger, row) {
  const suite = skillSuites.get(caseId);
  if (!suite || busy || proposalDialog.open || suiteProposalRequests.has(suite.parentCaseId)) return;
  proposalContext = { parentId: suite.parentCaseId, rowKey: row?.key, trigger };
  byId('skill-proposal-title').textContent = row ? 'AI 帮我补' : '补充测试场景';
  byId('skill-proposal-context').hidden = !row;
  byId('skill-proposal-context').textContent = row?.title ?? '';
  byId('skill-proposal-label').textContent = row ? '希望 AI 怎么补？' : '还想测什么？';
  const input = byId('skill-proposal-message');
  input.value = row?.gap?.aiPrompt || (row ? `帮我把「${row.title}」补成可以审核并运行的用例。` : '');
  input.setCustomValidity('');
  byId('skill-proposal-error').hidden = true;
  renderSuiteProposalDialog();
  proposalDialog.showModal();
  input.focus();
}

async function submitSuiteProposal(event) {
  event.preventDefault();
  const context = proposalContext;
  if (!context || suiteProposalRequests.has(context.parentId)) return;
  const input = byId('skill-proposal-message');
  const message = input.value.trim();
  if (!message) {
    input.setCustomValidity('请写一句你想测试或补充的内容。');
    input.reportValidity();
    return;
  }
  const { parentId, rowKey } = context;
  const knownKeys = new Set((skillSuites.get(parentId)?.rows ?? []).map(({ key }) => key));
  const errorText = byId('skill-proposal-error');
  errorText.hidden = true;
  suiteProposalRequests.add(parentId);
  suiteProposalNotices.set(parentId, { summary: 'AI 正在准备测试用例…' });
  renderSuiteProposalDialog();
  renderSkillSuite();
  try {
    const { suite, summary } = await api(`${skillSuiteRoute(parentId)}/proposals`, {
      method: 'POST', body: { message, ...(rowKey && { rowKey }) },
    });
    rememberSkillSuite(parentId, suite);
    const added = suite.rows.find(({ key }) => !knownKeys.has(key));
    suiteProposalNotices.set(parentId, { summary: summary || '补充内容已加入用例清单。', key: added?.key ?? rowKey });
    if (proposalContext === context && proposalDialog.open) proposalDialog.close();
  } catch (error) {
    const summary = `生成没有完成。${error.message}`;
    if (proposalContext === context && proposalDialog.open) {
      suiteProposalNotices.delete(parentId);
      errorText.textContent = summary;
      errorText.hidden = false;
    } else suiteProposalNotices.set(parentId, { summary, error: true });
  } finally {
    suiteProposalRequests.delete(parentId);
    renderSuiteProposalDialog();
    renderSkillSuite();
  }
}

async function startSkillSuite(selectedId) {
  const suite = skillSuites.get(caseId);
  if (!suite || busy || anyRunActive()) return;
  const selection = selectedId ? approvedSuiteCases(suite).filter(({ id }) => id === selectedId) : unrunSuiteCases(suite);
  const versions = selection.map(({ id, version }) => ({ id, version }));
  if (!versions.length) return;
  setNotice('');
  setBusy('skill-suite-run');
  try {
    const { runs: admitted } = await api(`${skillSuiteRoute(suite.parentCaseId)}/run`, { method: 'POST', body: { cases: versions } });
    for (const run of admitted) runs.set(run.id, run);
    renderRunLists();
  } catch (error) {
    setNotice(error.message);
    if (error.status === 409) await loadSkillSuite(selectedCase(), { refresh: true });
  } finally {
    setBusy('');
  }
}

async function updateCase(event) {
  event.preventDefault();
  if (busy) return;
  const testCase = selectedCase();
  if (!testCase) return;
  const action = event.submitter?.value === 'approve' ? 'approve' : 'save';
  let missing = '';
  const data = draftEdits.get(caseId) ?? caseData(testCase);
  if (!data.title.trim()) missing = 'title';
  else if (action === 'approve') missing = editors.find((name) => !data[name].trim());
  if (missing) {
    focusReviewField(`review-${missing}`);
    setNotice('请填写用例标题、场景说明和发给 Agent 的消息，再审核通过。');
    return;
  }
  if (action === 'approve' && data.native && !data.native.expected.trim()) {
    focusReviewField('review-native-expected');
    setNotice('请填写预期结果，再审核通过。');
    return;
  }
  if (action === 'save' && !draftEdits.has(caseId)) return;
  setNotice('');
  setBusy('review');
  try {
    const { case: record } = await api(caseRoute(testCase.id), {
      method: 'PUT', body: { ...data, action, version: testCase.version },
    });
    rememberCase(record);
    renderCases();
    if (caseId === record.id) renderReview();
    if (record.skillSuite) await loadSkillSuite(record, { refresh: true });
  } catch (error) {
    if (error.status === 400 && caseId === testCase.id) editingCase = true;
    setNotice(error.message);
    byId('notice').scrollIntoView({ block: 'nearest' });
  } finally {
    setBusy('');
  }
}

function focusReportHeading(headingId, panelId) {
  byId(headingId).focus({ preventScroll: true });
  const panel = byId(panelId);
  const { top } = panel.getBoundingClientRect();
  const headerBottom = document.querySelector('.bar')?.getBoundingClientRect().bottom ?? 0;
  if (top > innerHeight * .52 || top < headerBottom + 8) {
    panel.scrollIntoView({ block: 'start', behavior: 'instant' });
  }
}

function focusRun() {
  focusReportHeading('execution-title', 'execution');
}

async function startRun() {
  const testCase = selectedCase();
  if (!testCase || byId('run-case').disabled) return;
  const navigation = navigationVersion;
  setNotice('');
  setBusy('run');
  try {
    const { run } = await api(`${caseRoute(testCase.id)}/run`, { method: 'POST', body: { version: testCase.version } });
    runs.set(run.id, run);
    if (navigation === navigationVersion) chooseCase(testCase.id, run.id, { focusExecution: true });
    else renderRunLists();
  } catch (error) {
    setNotice(error.message);
    if (navigation === navigationVersion) byId('notice').scrollIntoView({ block: 'nearest' });
  } finally {
    setBusy('');
  }
}

function openPreview(label, file, trigger, href) {
  const nested = dialog.open && dialog.contains(trigger) && Boolean(preview);
  if (nested) {
    previewHistory.push({ preview, trigger, scroll: byId('artifact-content').scrollTop });
  } else {
    previewTrigger = trigger;
    previewHistory.length = 0;
  }
  previewController?.abort();
  previewController = new AbortController();
  preview = { label, file, href };
  renderPreviewHeader();
  byId('artifact-content').replaceChildren(element('p', 'empty-small', '正在读取证据…'));
  if (!dialog.open) dialog.showModal();
  else if (nested) byId('artifact-back').focus({ preventScroll: true });
  return previewController.signal;
}

function renderPreviewHeader() {
  byId('artifact-title').textContent = preview.label;
  byId('artifact-file').textContent = preview.file;
  const raw = byId('artifact-raw');
  raw.hidden = !preview.href;
  if (preview.href) raw.href = preview.href;
  else raw.removeAttribute('href');
  byId('artifact-toolbar').hidden = !preview.summary && !previewHistory.length;
  byId('artifact-views').hidden = !preview.summary;
  byId('artifact-back').hidden = !previewHistory.length;
  const content = byId('artifact-content');
  if (preview.summary) content.setAttribute('role', 'tabpanel');
  else {
    content.removeAttribute('role');
    content.removeAttribute('aria-labelledby');
  }
}

function renderPreviewView(mode, { focus = false, scroll = 0 } = {}) {
  preview.mode = mode;
  if (mode === 'source' && !preview.source) {
    const container = element('div');
    if (preview.text) container.append(highlightedPreview(preview.text, preview.file));
    else container.append(element('p', 'empty-small', '此文件为空。'));
    preview.source = container;
  }
  const content = byId('artifact-content');
  if (preview.summary) {
    for (const tab of byId('artifact-views').children) {
      const current = tab.dataset.artifactView === mode;
      tab.setAttribute('aria-selected', String(current));
      tab.tabIndex = current ? 0 : -1;
      if (current) {
        content.setAttribute('aria-labelledby', tab.id);
        if (focus) tab.focus({ preventScroll: true });
      }
    }
  }
  content.replaceChildren(mode === 'summary' ? preview.summary : preview.source);
  content.scrollTop = scroll;
}

function previewText(text, file, signal, summary = null) {
  if (signal.aborted) return;
  Object.assign(preview, { text, file, summary });
  renderPreviewHeader();
  renderPreviewView(summary ? 'summary' : 'source');
}

function previewError(error, signal) {
  if (signal.aborted) return;
  preview.source = element('p', 'notice', error.message);
  renderPreviewView('source');
}

async function showSource(testCase, file, trigger) {
  const signal = openPreview('项目文件', file, trigger);
  try {
    const data = await api(`${caseRoute(testCase.id)}/source?${new URLSearchParams({ file })}`, { signal });
    previewText(data.content, data.file ?? file, signal);
  } catch (error) {
    previewError(error, signal);
  }
}

async function showArtifact(run, artifact, trigger) {
  const context = evidenceContext(run, artifact.file);
  const url = context.href(artifact.file);
  const signal = openPreview(artifact.label, artifact.file, trigger, url);
  try {
    if (/\.(png|webp|jpe?g|gif)$/i.test(artifact.file)) {
      const image = element('img');
      image.alt = artifact.label;
      image.src = url;
      await image.decode();
      if (!signal.aborted) {
        preview.source = image;
        renderPreviewView('source');
      }
      return;
    }
    const response = await fetch(url, { cache: 'no-store', signal });
    if (!response.ok) throw new Error(`无法读取证据。HTTP ${response.status}`);
    const text = await response.text();
    if (signal.aborted) return;
    const summary = buildEvidencePreview(artifact.file, text, context);
    previewText(text, artifact.file, signal, summary);
  } catch (error) {
    previewError(error, signal);
  }
}

function evidenceContext(run, currentFile) {
  const checks = [...run.checks, run.advice].filter(Boolean);
  const all = new Map(checks.flatMap((check) => check.artifacts ?? []).map((artifact) => [artifact.file, artifact]));
  const href = (file) => `${runRoute(run.id)}/artifacts/${encodeURIComponent(file)}`;
  const hasRelated = (file) => file !== currentFile && all.has(file);
  return {
    run, href, check: checks.find(({ artifacts }) => artifacts?.some(({ file }) => file === currentFile)),
    artifactImage(file, label) {
      if (!hasRelated(file) || !/\.(?:png|webp|jpe?g|gif)$/iu.test(file)) return null;
      const figure = element('figure', 'evidence-snapshot');
      const image = element('img');
      image.alt = label ?? all.get(file).label;
      image.loading = 'lazy';
      image.src = href(file);
      figure.append(image, element('figcaption', null, image.alt));
      return figure;
    },
    artifactLink(file, label) {
      if (!hasRelated(file)) return null;
      const artifact = { ...all.get(file), label: label ?? all.get(file).label };
      const trigger = button(artifact.label, 'artifact-link', () => showArtifact(run, artifact, trigger));
      return trigger;
    },
  };
}

function artifactActions(run, artifacts = []) {
  const nodes = element('div', 'artifact-links');
  for (const artifact of artifacts) {
    const file = artifact?.file;
    if (!file) continue;
    const label = run.mode === 'demo' && file === 'candidate.diff' ? '参考实现差异' : artifact.label || file;
    const trigger = button(null, 'artifact-link', () => showArtifact(run, { file, label }, trigger));
    trigger.dataset.artifact = file;
    trigger.append(icon('file'), element('span', null, label));
    nodes.append(trigger);
  }
  return nodes;
}

const featuredChecks = new Set([
  'api.json', 'api-contract.json', 'browser.json', 'mutation.json', 'regression.json',
  'target-browser.json', 'target-build.json', 'target-mutation.json', 'target-verification.json', 'native-case-evidence.json',
]);
const featuredArtifacts = new Set([
  ...featuredChecks, 'candidate.diff', 'skill-proof.json', 'code.json', 'backend.json', 'frontend.json', 'verification-assets.json',
  'case-input.json', 'browser-filter.png', 'task-board.png', 'target-approvals.json', 'target-order-desktop.png',
  'target-conversation.json',
]);

function checkArtifactActions(run, check, expanded) {
  const files = check.artifacts;
  if (files.length < 3) return artifactActions(run, files);
  const priority = files.filter(({ file }) => featuredArtifacts.has(file)).slice(0, 2);
  const shown = priority.length ? priority : files.slice(0, 1);
  const remaining = files.filter((file) => !shown.includes(file));
  const details = element('details', 'additional-artifacts');
  details.dataset.extraArtifacts = check.id;
  details.open = expanded;
  details.append(element('summary', null, `更多证据（${remaining.length}）`), artifactActions(run, remaining));
  const content = document.createDocumentFragment();
  content.append(artifactActions(run, shown), details);
  return content;
}

function focusCheck(id) {
  focusReportSection(`check-${id}`);
}

function focusEvidenceEvent(seq) {
  eventFilter.value = 'all';
  eventSearch.value = '';
  applyEventFilter();
  const row = eventsList.querySelector(`[data-seq="${seq}"]`);
  if (!row) return;
  row.tabIndex = -1;
  row.focus({ preventScroll: true });
  row.scrollIntoView({ block: 'nearest' });
}

function evidenceButton(label, key, action) {
  const control = button(label, 'artifact-link', action);
  control.dataset.evidenceAction = key;
  return control;
}

function evidenceCard(title, symbol) {
  const card = element('div', 'output-evidence-card');
  const heading = element('h4');
  heading.append(icon(symbol), title);
  card.append(heading);
  return card;
}

function isEvidenceEvent(entry) {
  return (entry.kind === 'phase' && entry.checkId === 'skill')
    || (entry.kind === 'tool' && entry.status === 'completed'
      && (entry.tool === 'skill' || entry.checkId === 'skill' || editTools.has(entry.tool)));
}

function showsVerifiedRead(entry) {
  return /^(?:已验证读取 · |DSH 已验证读取 )/u.test(entry.summary ?? '');
}

function editPaths(entry) {
  const paths = entry.summary?.split(' · ')[1] ?? '';
  return paths.replace(/ 等 \d+ 个文件$/u, '').split('、').filter(Boolean);
}

function renderEvidenceSequence(reads, edits) {
  const section = byId('output-evidence-sequence');
  const first = reads[0];
  const subsequent = first && edits.find(({ seq }) => seq > first.seq);
  section.hidden = !subsequent;
  if (!subsequent) {
    section.replaceChildren();
    return;
  }
  const order = element('ul', 'output-evidence-order');
  const add = (label, read, edit, paths) => {
    const item = element('li');
    item.append(element('strong', null, label));
    for (const [caption, entry] of [['读取', read], ['编辑', edit]]) {
      if (caption === '编辑') item.append(element('span', null, '先于'));
      const control = evidenceButton(`${caption} #${entry.seq}`, `event-${label}-${entry.seq}`, () => focusEvidenceEvent(entry.seq));
      control.setAttribute('aria-label', `${caption}事件 ${entry.seq}，${entry.summary}`);
      control.title = entry.summary;
      item.append(control);
    }
    if (paths.length) item.append(element('span', 'output-evidence-file', paths.map((path) => path.split('/').at(-1)).join('、')));
    order.append(item);
  };
  for (const [label, name, extension] of [['Java', 'java-development', '.java'], ['Vue', 'vue-best-practices', '.vue']]) {
    const read = reads.find(({ summary }) => summary === `已验证读取 · ${name}`);
    const edit = read && edits.find((entry) => entry.seq > read.seq && editPaths(entry).some((path) => path.endsWith(extension)));
    if (edit) add(label, read, edit, editPaths(edit).filter((path) => path.endsWith(extension)));
  }
  if (!order.childElementCount) add('本轮', first, subsequent, editPaths(subsequent));
  section.replaceChildren(element('p', null, '观察到的顺序，仅说明事件先后。'), order);
}

function renderOutputEvidence(run) {
  const container = byId('output-evidence-cards');
  const section = container.parentElement;
  const focused = section.contains(document.activeElement) ? document.activeElement.dataset : {};
  const checks = run.checks ?? [];
  const skillCheck = checks.find(({ id }) => id === 'skill');
  const agentIndex = checks.findIndex(({ id }) => id === 'agent');
  const agentCheck = checks[agentIndex];
  const acceptance = run.testTarget
    ? checks.filter(({ id }) => ['build', 'browser', 'mutation', 'verification', 'honesty'].includes(id))
    : run.nativeCase ? checks.filter(({ id }) => !['workspace', 'agent', 'skill'].includes(id))
    : agentIndex < 0 ? [] : checks.slice(agentIndex + 1).filter(({ id }) => id !== 'skill');
  const proof = skillCheck?.artifacts?.find(({ file }) => file === 'skill-proof.json');
  const diff = agentCheck?.artifacts?.find(({ file }) => file === 'candidate.diff');
  const inventory = evidenceEvents.find(({ kind, checkId }) => kind === 'phase' && checkId === 'skill');
  const calls = evidenceEvents.filter(({ kind, tool, checkId }) => kind === 'tool' && (tool === 'skill' || checkId === 'skill'));
  const reads = calls.filter(showsVerifiedRead);
  const edits = evidenceEvents.filter(({ tool }) => editTools.has(tool));
  const packages = run.skillEvidence?.packs ?? [];
  const running = active.has(run.status);

  const skill = evidenceCard('规范加载', 'layers');
  if (packages.some(({ skills }) => skills.length)) {
    const packs = element('ul', 'output-evidence-packs');
    for (const pack of packages) {
      const loaded = pack.skills.filter(({ loaded }) => loaded).length;
      const verified = pack.skills.filter(({ verified }) => verified).length;
      const discovered = pack.skills.filter(({ discovered }) => discovered).length;
      const count = pack.skills.length ? `发现 ${discovered}/${pack.skills.length} · 加载 ${loaded} · 验证 ${verified}` : '发现未记录';
      packs.append(element('li', null, `${pack.title} · ${count}`));
    }
    skill.append(packs);
  } else if (run.skillEvidence?.read === 'verified') {
    skill.append(element('p', null, 'Skill 正文读取已验证。'));
  } else if (calls.length || inventory) {
    if (inventory) skill.append(element('p', null, inventory.summary));
    skill.append(element('p', null, `Skill 事件 ${calls.length} 条 · 正文验证 ${reads.length} 条`));
  } else if (run.mode === 'demo') {
    skill.append(element('p', null, '参考演示跳过 Skill 读取验证。'));
  } else if (run.nativeCase) {
    skill.append(element('p', null, running ? '等待采集项目原生 Skill 的读取证据。' : '本轮没有已核验的读取证据。'));
  } else if (run.skillProfile === 'none' || run.skillMode === 'without') {
    skill.append(element('p', null, '本轮未配置 Skill。'));
  } else {
    const profile = skillProfiles.find(({ id }) => id === run.skillProfile);
    skill.append(element('p', null, [profile?.title ?? skillLabels[run.skillMode],
      running ? '等待发现与加载' : '未记录发现与加载'].filter(Boolean).join(' · ')));
  }
  if (proof) skill.append(artifactActions(run, [proof]));
  else if (calls.length || inventory) {
    skill.append(evidenceButton('查看 Skill 事件', 'skill-events', () => focusEvidenceEvent((reads[0] ?? calls[0] ?? inventory).seq)));
  }

  const changes = evidenceCard('代码改动', 'code');
  const changeSummary = run.mode === 'demo' ? '演示使用固定参考实现。'
    : edits.length ? `观察到 ${edits.length} 次已完成的编辑调用`
    : diff ? '已保存本轮候选差异。'
    : running ? '等待编辑事件' : '未记录编辑工具完成事件';
  changes.append(element('p', null, changeSummary));
  if (diff) changes.append(artifactActions(run, [diff]));
  else if (edits.length) changes.append(evidenceButton('查看首个编辑事件', 'first-edit', () => focusEvidenceEvent(edits[0].seq)));

  const verification = evidenceCard('独立验收', 'check');
  const totals = { pass: 0, fail: 0, blocked: 0, skipped: 0, running: 0, pending: 0 };
  for (const { status } of acceptance) {
    const outcome = status === 'error' ? 'fail' : status === 'interrupted' ? 'blocked' : status;
    totals[Object.hasOwn(totals, outcome) ? outcome : 'pending']++;
  }
  if (acceptance.length) {
    const outcomes = element('div', 'output-evidence-counts');
    for (const [outcome, label] of [['pass', '通过'], ['fail', '未通过'], ['blocked', '阻塞'], ['skipped', '跳过'], ['running', '进行中'], ['pending', '待验收']]) {
      if (totals[outcome]) outcomes.append(badge(outcome, `${label} ${totals[outcome]}`));
    }
    const attention = acceptance.find(({ status }) => ['fail', 'error', 'blocked', 'interrupted'].includes(status));
    const attachments = acceptance.flatMap((check) => check.artifacts ?? []);
    const nativeEvidence = run.nativeCase && checks.flatMap(({ artifacts }) => artifacts ?? [])
      .find(({ file }) => file === 'native-case-evidence.json');
    const reports = [...new Map([...attachments.filter(({ file }) => featuredChecks.has(file)),
      ...(nativeEvidence ? [nativeEvidence] : [])].map((artifact) => [artifact.file, artifact])).values()];
    const screenshot = attachments.find(({ file }) => ['browser-filter.png', 'task-board.png', 'target-order-desktop.png',
      'target-order-failure.png'].includes(file));
    const actions = artifactActions(run, [...reports, ...(screenshot ? [screenshot] : [])]);
    actions.prepend(evidenceButton('查看验收检查', 'verification', () => focusCheck((attention ?? acceptance[0]).id)));
    verification.append(outcomes, actions);
  } else {
    verification.append(element('p', null, '无独立验收记录。'));
  }

  container.replaceChildren(skill, changes, verification);
  renderEvidenceSequence(reads, edits);
  if (focused.artifact || focused.evidenceAction) {
    [...section.querySelectorAll('button')].find(({ dataset }) =>
      (focused.artifact && dataset.artifact === focused.artifact)
      || (focused.evidenceAction && dataset.evidenceAction === focused.evidenceAction))?.focus({ preventScroll: true });
  }
}

function renderChecks(run) {
  const list = byId('checks');
  const focused = list.contains(document.activeElement) ? document.activeElement : null;
  const file = focused?.dataset.artifact;
  const focusedGroup = focused?.closest('[data-extra-artifacts]')?.dataset.extraArtifacts;
  const opened = list.dataset.runId === run.id
    ? new Set([...list.querySelectorAll('[data-extra-artifacts][open]')].map(({ dataset }) => dataset.extraArtifacts)) : new Set();
  list.dataset.runId = run.id;
  const rows = document.createDocumentFragment();
  for (const check of run.checks) {
    const status = displayRunStepStatus(run, check.id, check.status);
    const demoCheck = run.mode === 'demo' && status === 'skipped';
    const title = demoCheck && check.id === 'agent' ? 'Agent 产出'
      : demoCheck && check.id === 'skill' ? 'Skill 读取证据' : check.title;
    const summary = demoCheck && check.id === 'agent' ? '演示使用固定参考实现，跳过 Agent 生成。'
      : demoCheck && check.id === 'skill' ? '演示跳过 Skill 读取验证。' : check.summary;
    const row = element('li', 'check');
    row.id = `check-${check.id}`;
    row.tabIndex = -1;
    row.dataset.state = status;
    const mark = element('span', 'check-icon');
    const marker = status === 'pass' ? 'check' : ['fail', 'error'].includes(status) ? 'cross' : pending.has(status) ? 'clock' : 'terminal';
    mark.append(icon(marker));
    const copy = element('div', 'check-copy');
    copy.append(element('strong', null, title));
    if (summary) copy.append(element('p', null, summary));
    if (check.id === 'skill' && run.skillEvidence?.packs) {
      const group = element('ul', 'skill-evidence skill-pack-list');
      for (const pack of run.skillEvidence.packs) {
        const item = element('li', 'skill-pack');
        const heading = element('div', 'skill-pack-meta');
        heading.append(element('strong', null, pack.title), element('small', null, pack.version));
        const discovered = pack.skills.filter(({ discovered }) => discovered).length;
        const observed = pack.skills.filter(({ loaded }) => loaded);
        const verified = observed.filter(({ verified }) => verified).length;
        const count = pack.skills.length ? `发现 ${discovered}/${pack.skills.length} · 加载 ${observed.length} · 正文验证 ${verified}` : '发现未记录';
        item.append(heading, element('p', 'skill-pack-evidence', count));
        const seals = element('div', 'skill-run-seals');
        for (const skill of observed) {
          const seal = element('span', 'skill-run-seal', skill.name);
          seal.dataset.state = skill.verified ? 'pass' : 'pending';
          seal.title = skill.verified ? '正文读取已验证' : '已加载，正文证据未通过';
          seal.append(element('span', 'sr-only', `，${seal.title}`));
          seals.append(seal);
        }
        if (seals.childElementCount) item.append(seals);
        group.append(item);
      }
      copy.append(group);
    } else if (check.id === 'skill' && run.skillEvidence) {
      const signal = { observed: '已观察', verified: '已验证', 'not-observed': '未观察到', unknown: '未知' };
      const activation = signal[run.skillEvidence.activation] ?? '未知';
      const read = signal[run.skillEvidence.read] ?? '未知';
      copy.append(element('p', null, `激活 ${activation} · 读取 ${read}`));
    }
    if (check.artifacts?.length) copy.append(checkArtifactActions(run, check, opened.has(check.id)));
    const aside = element('div', 'check-aside');
    aside.append(badge(status));
    if (duration(check.durationMs)) aside.append(element('span', 'duration', duration(check.durationMs)));
    row.append(mark, copy, aside);
    rows.append(row);
  }
  list.replaceChildren(rows);
  if (file) [...list.querySelectorAll('[data-artifact]')].find((control) => control.dataset.artifact === file)?.focus({ preventScroll: true });
  else if (focusedGroup) [...list.querySelectorAll('[data-extra-artifacts]')].find(({ dataset }) => dataset.extraArtifacts === focusedGroup)
    ?.querySelector('summary').focus({ preventScroll: true });
}

function addEvents(run, entries, live) {
  const fragment = document.createDocumentFragment();
  const following = followingTimeline();
  const filter = eventFilter.value;
  const query = eventSearch.value.trim().toLowerCase();
  for (const entry of entries) {
    const step = entry.checkId ?? (entry.phase === 'advice' ? 'advice' : undefined);
    const displayStatus = displayRunStepStatus(run, step, entry.status);
    const row = element('li', 'event');
    row.dataset.seq = String(entry.seq);
    row.dataset.state = displayStatus ?? '';
    row.dataset.stream = entry.stream ?? '';
    const isSkill = entry.tool === 'skill' || entry.checkId === 'skill';
    const kind = isSkill ? 'skill' : entry.kind;
    const [kindLabel, marker] = Object.hasOwn(eventKinds, kind) ? eventKinds[kind] : ['事件', 'activity'];
    row.dataset.kind = kind ?? '';
    const groups = [];
    if (entry.kind === 'tool' && entry.phase === 'agent') groups.push('agent');
    const phase = runEventPhase(entry);
    if (phase) groups.push(`phase-${phase}`);
    if (isSkill) groups.push('skill');
    if (entry.kind === 'command-output' || (entry.tool === 'bash' && entry.detail)) groups.push('output');
    row.dataset.groups = groups.join(' ');
    const time = element('time', null, formatTime(entry.at, timeStyle));
    if (entry.at) time.dateTime = entry.at;
    const copy = element('div', 'event-copy');
    const tag = phases[entry.phase];
    const length = duration(entry.durationMs);
    const status = labels[displayStatus];
    const summary = entry.summary || status || tag || '执行事件';
    const context = [tag, entry.stream, length].filter(Boolean);
    const metadata = element('div', 'event-meta');
    const type = element('span', 'event-kind');
    type.append(icon(marker), element('span', null, kindLabel));
    metadata.append(type);
    if (context.length) metadata.append(element('span', 'event-context', context.join(' · ')));
    if (status) metadata.append(element('span', 'event-status', status));
    copy.append(metadata, element('strong', 'event-summary', summary));
    const detailText = typeof entry.detail === 'string' ? entry.detail : JSON.stringify(entry.detail, null, 2);
    if (entry.detail != null && detailText) {
      const detail = element('details');
      detail.append(element('summary', null, entry.stream ? '查看输出' : '查看详情'));
      detail.addEventListener('toggle', () => {
        if (detail.open && detail.childElementCount === 1) {
          const filename = typeof entry.detail === 'string' ? 'terminal' : 'detail.json';
          detail.append(highlightedPreview(detailText, filename, { maxLines: 120, maxChars: 18_000 }));
        }
        updateTimelineLatest();
      });
      copy.append(detail);
    }
    const artifacts = entry.artifacts ?? [];
    if (artifacts.length) copy.append(artifactActions(run, artifacts));
    eventSearchText.set(row, [
      time.textContent, kindLabel, kind, summary, ...context, status, displayStatus, entry.tool, detailText,
      ...artifacts.flatMap((artifact) => [artifact?.file, artifact?.label]),
    ].filter(Boolean).join(' ').toLowerCase());
    row.hidden = !matchesEvent(row, filter, query);
    row.append(time, copy);
    fragment.append(row);
  }
  eventsList.append(fragment);
  renderEventEmpty();
  if (following && live) eventsList.scrollTop = eventsList.scrollHeight;
  updateTimelineLatest();
}

function matchesEvent(row, filter, query) {
  return (filter === 'all' || row.dataset.groups.split(' ').includes(filter))
    && (!query || eventSearchText.get(row).includes(query));
}

function followingTimeline() {
  return eventsList.scrollHeight - eventsList.scrollTop - eventsList.clientHeight < 35;
}

function updateTimelineLatest() {
  byId('timeline-latest').hidden = followingTimeline();
}

function applyEventFilter() {
  const filter = eventFilter.value;
  const query = eventSearch.value.trim().toLowerCase();
  for (const row of eventsList.children) row.hidden = !matchesEvent(row, filter, query);
  renderEventEmpty();
  eventsList.scrollTop = 0;
  updateTimelineLatest();
}

function focusTimeline() {
  focusReportSection('events-title');
}

function focusReportSection(id) {
  const target = byId(id);
  if (!target || target.closest('[hidden]')) return;
  const details = target.closest('#report-details');
  if (details) details.open = true;
  target.focus({ preventScroll: true });
  target.scrollIntoView({ block: 'start' });
}

function showPhaseEvents(phase) {
  eventFilter.value = `phase-${phase}`;
  eventSearch.value = '';
  applyEventFilter();
  focusTimeline();
}

function renderEventEmpty() {
  const empty = byId('events-empty');
  const total = eventsList.childElementCount;
  const visible = total - eventsList.querySelectorAll(':scope > [hidden]').length;
  const count = byId('event-count');
  const countText = visible === total ? `${total} 条事件` : `${visible} / ${total} 条事件`;
  if (count.textContent !== countText) count.textContent = countText;
  empty.hidden = visible > 0;
  eventsList.hidden = !empty.hidden;
  if (empty.hidden) return;
  empty.textContent = eventSearch.value.trim() ? '没有匹配的事件。'
    : eventFilter.value !== 'all' ? '此分类暂时没有事件。'
    : active.has(selectedRun()?.status) ? '等待执行事件…' : '暂无时间线事件。已保存的检查与证据仍可查看。';
}

function renderAdvice(run) {
  const advice = run.advice;
  byId('advice').hidden = !advice || (advice.status === 'pending' && !advice.summary);
  if (!advice || byId('advice').hidden) return;
  const status = displayRunStepStatus(run, 'advice', advice.status);
  byId('advice-state').replaceChildren(badge(status, status === 'pass' ? '已生成' : undefined));
  const body = document.createDocumentFragment();
  const summary = run.mode === 'demo' && status === 'skipped' ? '演示只运行确定性检查，跳过模型审阅。' : advice.summary;
  if (summary) body.append(element('p', null, summary));
  if (advice.artifacts?.length) body.append(artifactActions(run, advice.artifacts));
  for (const item of advice.items ?? []) {
    const finding = element('article', 'finding');
    finding.append(element('h4', null, item.finding), element('p', null, item.fix));
    if (item.retest?.length) {
      const steps = element('ol');
      for (const step of item.retest) steps.append(element('li', null, step));
      finding.append(element('h5', null, '复测步骤'), steps);
    }
    const references = element('div', 'artifact-links');
    for (const id of item.evidenceIds ?? []) {
      const check = run.checks.find((entry) => entry.id === id);
      if (!check) continue;
      references.append(button(check.title, 'artifact-link', () => focusCheck(check.id)));
    }
    if (references.children.length) finding.append(references);
    body.append(finding);
  }
  byId('advice-content').replaceChildren(body);
}

function renderExecution(entries = []) {
  const run = selectedRun();
  runOutcome.update(run);
  const back = byId('return-to-case');
  back.hidden = !run?.caseId;
  if (run?.caseId) {
    const parent = run.skillSuite?.caseId ?? cases.find(({ id }) => id === run.caseId)?.skillSuite?.parentCaseId;
    back.href = viewHref('workspace', { project: parent ?? run.caseId });
    back.textContent = parent ? '返回用例清单' : '返回用例';
  }
  byId('run-retest').hidden = !run || Boolean(run.caseId || run.testTarget) || active.has(run.status);
  runVisualization.update(run, entries, { disconnected: Boolean(pollError) });
  byId('execution-empty').hidden = Boolean(run);
  byId('execution-empty').lastElementChild.textContent = missingRun ? '找不到这次运行。'
    : runId ? '正在读取这次运行…' : view === 'benchmark' ? '开始评测后，可以在这里查看进度、验收和证据。'
      : '运行已审核的用例后，检查结果会出现在这里。';
  byId('execution-body').hidden = !run;
  if (!run) {
    byId('execution-meta').textContent = '执行后会逐项显示状态、耗时和证据。';
    byId('execution-meta').removeAttribute('title');
    byId('execution-state').replaceChildren();
    return;
  }
  byId('event-live').hidden = !active.has(run.status) || Boolean(pollError);
  const newEvidence = entries.filter(isEvidenceEvent);
  evidenceEvents.push(...newEvidence);
  const key = JSON.stringify(run);
  if (key !== finalSignature || newEvidence.length) renderOutputEvidence(run);
  if (key === finalSignature) return;
  finalSignature = key;
  const checks = run.checks ?? [];
  const done = checks.filter((check) => !pending.has(check.status)).length;
  byId('execution-state').replaceChildren(runBadge(run));
  const profile = run.nativeCase || run.testTarget ? null : skillProfiles.find(({ id }) => id === run.skillProfile);
  byId('execution-meta').textContent = [run.testTarget?.title ?? run.caseTitle ?? fixtureTitle, run.caseVersion && `v${run.caseVersion}`, runLabel(run),
    profile?.title, formatTime(run.startedAt || run.createdAt)].filter(Boolean).join(' · ');
  byId('execution-meta').title = run.id;
  const live = `${labels[run.status]}。${done} 项检查已完成。`;
  if (byId('execution-live').textContent !== live) byId('execution-live').textContent = live;
  renderEventEmpty();
  byId('native-run-expectation').hidden = !run.nativeCase?.expected;
  byId('native-run-expected').textContent = run.nativeCase?.expected ?? '';
  renderTargetApproval(run);
  renderChecks(run);
  renderAdvice(run);
  byId('report-advice-link').hidden = byId('advice').hidden;
}

function renderTargetApproval(run) {
  const records = run.testTarget?.approvals ?? run.nativeCase?.approvals ?? [];
  const show = Boolean(run.testTarget || run.nativeCase?.scenario === 'approval-gate' || records.length);
  byId('target-approval').hidden = !show;
  byId('report-approval-link').hidden = !show;
  if (!show) return;
  const list = byId('target-approval-list');
  const rows = records.map(({ stage, status, summary, at }) => {
    const item = element('li', 'target-approval-item');
    const first = element('div', 'target-approval-heading');
    first.append(element('strong', null, targetStages[stage] ?? stage), approvalBadge(status));
    const label = formatTime(at);
    if (label) {
      const time = element('time', null, formatTime(at, timeStyle));
      time.dateTime = at;
      time.title = label;
      first.append(time);
    }
    item.append(first);
    if (summary) item.append(element('p', null, summary));
    return item;
  });
  list.replaceChildren(...(rows.length ? rows : [element('li', 'target-approval-empty', '本轮暂无审批事件。')]));
  const artifacts = run.checks.flatMap(({ artifacts }) => artifacts ?? [])
    .filter(({ file }) => file === 'target-approvals.json');
  byId('target-approval-assets').replaceChildren(artifactActions(run, [...new Map(artifacts.map((artifact) => [artifact.file, artifact])).values()]));
}

function selectRun(next) {
  if (runId === next && pollController) return;
  if (runId) timelineFilters.set(runId, { filter: eventFilter.value, search: eventSearch.value });
  runId = next;
  byId('report-details').open = false;
  clearTimeout(pollTimer);
  pollController?.abort();
  pollController = undefined;
  pollError = '';
  missingRun = false;
  cursor = 0;
  finalSignature = '';
  seenActive = active.has(selectedRun()?.status);
  seenEnd = false;
  finalReads = 0;
  deferredEvents = [];
  evidenceEvents = [];
  eventsList.replaceChildren();
  const savedTimeline = timelineFilters.get(runId);
  eventFilter.value = savedTimeline?.filter ?? 'all';
  eventSearch.value = savedTimeline?.search ?? '';
  renderEventEmpty();
  updateTimelineLatest();
  updateNotice();
  renderExecution();
  if (!runId) return;
  pollController = new AbortController();
  refreshRun(runId, pollController.signal);
}

async function refreshRun(id, signal) {
  const path = runRoute(id);
  const [report, journal] = await Promise.allSettled([
    api(path, { signal }), api(`${path}/events?after=${cursor}`, { signal }),
  ]);
  if (signal.aborted) return;
  const wasActive = seenActive || active.has(runs.get(id)?.status);
  if (report.status === 'fulfilled') runs.set(id, report.value.run);
  missingRun = report.status === 'rejected' && report.reason.status === 404;
  if (missingRun) runs.delete(id);
  const run = runs.get(id);
  const running = active.has(run?.status) || active.has(journal.value?.status);
  const holdTerminal = active.has(run?.status);
  const unseen = run && !holdTerminal ? deferredEvents : [];
  if (!holdTerminal) deferredEvents = [];
  if (journal.status === 'fulfilled' && run) {
    const entries = (journal.value.events ?? []).filter((entry) => Number.isSafeInteger(entry.seq)).sort((a, b) => a.seq - b.seq);
    for (const entry of entries) {
      if (entry.seq <= cursor) continue;
      cursor = entry.seq;
      if (isRunTerminalEvent(entry)) seenEnd = true;
      (holdTerminal && seenEnd ? deferredEvents : unseen).push(entry);
    }
  }
  const failures = [report, journal].filter((result) => result.status === 'rejected');
  const retryable = failures.some(({ reason: { status } }) => !status || status === 408 || status === 429 || status >= 500);
  pollError = missingRun ? report.reason.message
    : failures.length ? `暂时无法更新执行记录。${failures[0].reason.message}` : '';
  renderExecution(unseen);
  if (unseen.length) addEvents(run, unseen, wasActive || running);
  updateNotice();
  renderReviewActions();
  renderRunLists();
  renderLaunchActions();
  if (running) seenActive = true;
  // The final event can be appended after the state snapshot changes to completed.
  const draining = seenActive && !seenEnd && (!run?.finishedAt || finalReads < 3);
  if (!running && draining && run?.finishedAt) finalReads += 1;
  if (!missingRun && (running || draining || retryable)) {
    pollTimer = setTimeout(() => refreshRun(id, signal), failures.length ? 1200 : 500);
  }
}

async function loadRecords() {
  const { runs: entries } = await api('/api/runs');
  for (const run of entries) {
    // The selected run's detail poll also reconciles snapshots with its event journal.
    if (run.id !== runId || !pollController || !runs.has(run.id)) runs.set(run.id, run);
  }
  const latest = newestRuns().find(({ testTarget }) => testTarget?.suiteId);
  if (latest) targetSuiteId = latest.testTarget.suiteId;
}

async function loadTestTarget() {
  try {
    const data = await api('/api/testtarget');
    if (!Array.isArray(data.trials)) return;
    targetTrials = data.trials;
    targetSuiteId = data.suiteId;
    for (const run of data.runs ?? []) if (!runs.has(run.id)) runs.set(run.id, run);
  } catch (error) {
    if (error.status !== 404) console.warn('读取 TestTarget 用例失败', error.message);
  }
  renderRunLists();
  renderLaunchActions();
}

async function pollRecords() {
  try {
    await loadRecords();
    recordPollError = '';
  } catch (error) {
    recordPollError = `暂时无法更新运行记录。 ${error.message}`;
  }
  renderRunLists();
  renderReviewActions();
  renderLaunchActions();
  updateNotice();
  setTimeout(pollRecords, anyRunActive() ? 900 : 3800);
}

function showHistory(filter = historyFilter, { update = 'pushState', focus = true } = {}) {
  view = 'history';
  historyFilter = filter;
  setNotice('');
  renderNavigation();
  updateLocation(update);
  if (focus) focusViewHeading();
}

function focusViewHeading() {
  byId(viewHeadings[view]).focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

function openBenchmark() {
  showBenchmark(null, null, { launch: true });
  byId('benchmark-setup').open = false;
  focusViewHeading();
}

function openWorkspace() {
  chooseCase(null, undefined, { focus: false });
  focusViewHeading();
}

function applyRoute(url, { initial = false, update = 'replaceState' } = {}) {
  const requestedId = url.searchParams.get('run');
  const run = runs.get(requestedId);
  const target = viewFromRoute(url, run);
  if (target === 'history') {
    showHistory(filterFromRoute(url), { update, focus: false });
    return;
  }
  if (target === 'benchmark') {
    const requestedExperiment = url.searchParams.get('experiment');
    const groupOnly = Boolean(requestedExperiment && !requestedId);
    const group = requestedExperiment ? builtinRuns().filter(({ experimentId }) => experimentId === requestedExperiment) : [];
    const record = run ?? (requestedExperiment ? experimentRun(group) : null);
    showBenchmark(requestedId ?? record?.id ?? null, record?.experimentId ?? requestedExperiment, {
      update, group: groupOnly, launch: !requestedId && !requestedExperiment,
      focusExecution: initial && Boolean(record && (requestedId || groupOnly)),
    });
    if (requestedExperiment && !record && !requestedId) setNotice('找不到这次四组对照。');
    return;
  }
  const requestedProject = run?.caseId ?? url.searchParams.get('case');
  const missingProject = Boolean(requestedProject && !cases.some(({ id }) => id === requestedProject));
  const project = requestedProject && (!missingProject || requestedId) ? requestedProject : null;
  const nextRun = requestedId ?? latestRun(project)?.id ?? null;
  const create = url.searchParams.get('create') === '1';
  const edit = !create && !requestedId && url.searchParams.get('edit') === '1';
  if (!initial && project === caseId && nextRun === projectRunId && creating === create
    && reportFirst === Boolean(requestedId) && editingCase === edit) {
    view = 'workspace';
    setNotice('');
    selectRun(projectRunId);
    renderExecution();
    renderNavigation();
    renderReviewActions();
    updateLocation(update);
  } else {
    chooseCase(project, requestedId ?? undefined, { create, edit, update, focus: false, focusExecution: initial && Boolean(requestedId && run) });
  }
  if (missingProject) setNotice(requestedId ? '找不到关联的项目用例。' : '找不到该项目用例。');
}

async function boot() {
  renderNavigation();
  renderLaunchActions();
  const [projects, records] = await Promise.allSettled([api('/api/cases'), loadRecords(), loadTestTarget()]);
  loaded = projects.status === 'fulfilled' || records.status === 'fulfilled';
  connection(loaded ? 'ready' : 'error', loaded ? '本地服务已连接' : '连接失败');
  if (projects.status === 'fulfilled') {
    cases = projects.value.cases;
    defaultProject = projects.value.defaultProject;
    scenario = projects.value.scenarios?.[0];
    skillProfiles = projects.value.skillProfiles ?? [];
  }
  byId('use-sample').hidden = !defaultProject;
  byId('use-java-vue').hidden = !scenario;
  const requested = new URL(location.href).searchParams.get('run');
  if (requested && !runs.has(requested) && records.status === 'rejected') {
    try {
      const { run } = await api(runRoute(requested));
      runs.set(run.id, run);
    } catch { /* The selected run loader reports unavailable records. */ }
  }
  renderCases();
  const current = new URL(location.href);
  applyRoute(current, { initial: true });
  routeReady = true;
  if (view === 'benchmark' && current.hash === '#run-demo') {
    renderLaunchActions();
    byId('run-demo').focus();
  }
  if (projects.status === 'rejected' && view === 'workspace') setNotice(projects.reason.message);
  if (records.status === 'rejected') recordPollError = records.reason.message;
  renderLaunchActions();
  updateNotice();
  setTimeout(pollRecords, anyRunActive() ? 900 : 3800);
}

byId('new-case').addEventListener('click', () => openCreate());
byId('cancel-create').addEventListener('click', () => chooseCase(caseId));
byId('skill-suite-run').addEventListener('click', () => void startSkillSuite());
byId('skill-suite-propose').addEventListener('click', ({ currentTarget }) => openSuiteProposal(currentTarget));
byId('skill-suite-proposal-jump').addEventListener('click', () => {
  const key = suiteProposalNotices.get(skillSuites.get(caseId)?.parentCaseId)?.key;
  if (key) showSuiteRow(key);
});
byId('skill-proposal-form').addEventListener('submit', submitSuiteProposal);
byId('skill-proposal-message').addEventListener('input', ({ target }) => target.setCustomValidity(''));
for (const id of ['skill-proposal-close', 'skill-proposal-cancel']) {
  byId(id).addEventListener('click', () => proposalDialog.close());
}
proposalDialog.addEventListener('close', () => {
  const context = proposalContext;
  if (!context || proposalDialog.open) return;
  proposalContext = undefined;
  const { trigger } = context;
  const key = trigger.dataset.suiteFocus;
  const visibleTrigger = trigger.isConnected && !trigger.disabled ? trigger
    : [...byId('skill-suite-groups').querySelectorAll('[data-suite-focus]')]
      .find((button) => button.dataset.suiteFocus === key && !button.disabled);
  (visibleTrigger ?? byId('skill-suite-title')).focus({ preventScroll: true });
});
byId('skill-suite-settings-toggle').addEventListener('click', () => {
  if (expandedSingleReviews.has(caseId)) expandedSingleReviews.delete(caseId);
  else expandedSingleReviews.add(caseId);
  renderSkillSuite();
});
handleLink(byId('skill-suite-back'), () => {
  const parent = selectedCase()?.skillSuite?.parentCaseId ?? skillSuites.get(caseId)?.parentCaseId;
  if (!parent) return;
  chooseCase(parent);
  focusReportHeading('skill-suite-title', 'skill-suite-review');
});
byId('discover-project').addEventListener('click', discoverProject);
byId('create-kind').addEventListener('change', renderCreateChoice);
byId('create-purpose').addEventListener('change', ({ target }) => changeCreatePurpose(target.value));
byId('project-dir').addEventListener('input', ({ target }) => {
  if (discoveryPath && discoveryPath !== projectPath(target.value)) clearDiscovery();
});
byId('use-sample').addEventListener('click', () => {
  byId('project-dir').value = defaultProject;
  clearDiscovery();
  changeCreatePurpose('project-tests');
  byId('project-dir').focus();
});
byId('use-java-vue').addEventListener('click', () => {
  if (!scenario) return;
  byId('project-dir').value = scenario.projectDir;
  byId('create-title-input').value = scenario.title;
  byId('create-requirement').value = scenario.requirement;
  clearDiscovery();
  changeCreatePurpose('project-tests');
  byId('create-requirement').focus();
});
eventFilter.addEventListener('change', applyEventFilter);
eventSearch.addEventListener('input', applyEventFilter);
eventsList.addEventListener('scroll', updateTimelineLatest, { passive: true });
byId('timeline-latest').addEventListener('click', () => {
  eventsList.focus({ preventScroll: true });
  eventsList.scrollTop = eventsList.scrollHeight;
  updateTimelineLatest();
});
new ResizeObserver(fitSelectedCase).observe(caseList);
const benchmarkResize = new ResizeObserver(updateBenchmarkScrollHints);
for (const [containerId] of benchmarkScrollHints) benchmarkResize.observe(byId(containerId));
new ResizeObserver(updateTimelineLatest).observe(eventsList);
byId('create-form').addEventListener('submit', createCase);
byId('review-form').addEventListener('input', storeEdits);
byId('review-form').addEventListener('submit', updateCase);
byId('review-editor-toggle').addEventListener('click', () => {
  editingCase = !editingCase;
  renderReviewActions();
  updateLocation();
});
byId('run-case').addEventListener('click', startRun);
byId('execution-nav').addEventListener('click', (event) => {
  const target = event.target.closest('[data-report-target]');
  if (target) focusReportSection(target.dataset.reportTarget);
});
byId('add-command').addEventListener('click', () => {
  const row = commandRow({ id: `command-${crypto.randomUUID()}`, label: '', program: '', phase: 'verify', args: [], timeoutMs: 120000 });
  byId('commands').append(row);
  storeEdits();
  row.querySelector('input').focus();
});
for (const [index, name] of tabs.entries()) {
  byId(`tab-${name}`).addEventListener('click', () => changeTab(name));
  byId(`tab-${name}`).addEventListener('keydown', (event) => {
    const destinations = { ArrowLeft: tabs[(index + tabs.length - 1) % tabs.length], ArrowRight: tabs[(index + 1) % tabs.length], Home: tabs[0], End: tabs.at(-1) };
    if (!destinations[event.key]) return;
    event.preventDefault();
    changeTab(destinations[event.key], true);
  });
}
byId('close-artifact').addEventListener('click', () => dialog.close());
byId('artifact-back').addEventListener('click', () => {
  const previous = previewHistory.pop();
  if (!previous) return;
  previewController?.abort();
  preview = previous.preview;
  renderPreviewHeader();
  renderPreviewView(preview.mode, { scroll: previous.scroll });
  previous.trigger.focus({ preventScroll: true });
});
byId('artifact-views').addEventListener('click', (event) => {
  const tab = event.target.closest('[data-artifact-view]');
  if (tab) renderPreviewView(tab.dataset.artifactView);
});
byId('artifact-views').addEventListener('keydown', (event) => {
  const keys = { ArrowLeft: 'toggle', ArrowRight: 'toggle', Home: 'summary', End: 'source' };
  const action = keys[event.key];
  if (!action) return;
  event.preventDefault();
  const next = action === 'toggle' ? (preview.mode === 'summary' ? 'source' : 'summary') : action;
  renderPreviewView(next, { focus: true });
});
dialog.addEventListener('close', () => {
  previewController?.abort();
  preview = undefined;
  previewHistory.length = 0;
  const file = previewTrigger?.dataset.artifact;
  if (previewTrigger?.isConnected) previewTrigger.focus();
  else if (file) [...document.querySelectorAll('[data-artifact]')].find((control) => control.dataset.artifact === file)?.focus();
});
handleLink(byId('history-link'), () => showHistory());
handleLink(byId('workspace-link'), openWorkspace);
handleLink(byId('brand-link'), openWorkspace);
handleLink(byId('benchmark-link'), openBenchmark);
byId('demo-link').addEventListener('click', () => void startBenchmark({ mode: 'demo', skillMode: 'without' }));
handleLink(byId('return-to-case'), () => {
  const run = selectedRun();
  if (!run?.caseId) return;
  const parent = run.skillSuite?.caseId ?? cases.find(({ id }) => id === run.caseId)?.skillSuite?.parentCaseId;
  chooseCase(parent ?? run.caseId);
});
handleLink(byId('benchmark-history-link'), () => showHistory('builtin'));
byId('history-filter').addEventListener('change', (event) => showHistory(event.target.value, { focus: false }));
byId('single-run-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void startBenchmark(Object.fromEntries(new FormData(event.currentTarget)));
});
byId('run-experiment').addEventListener('click', () => void startBenchmark({}, true));
byId('run-demo').addEventListener('click', () => void startBenchmark({ mode: 'demo', skillMode: 'without' }));
byId('run-testtarget').addEventListener('click', () => void startTestTarget());
byId('run-retest').addEventListener('click', () => {
  const run = selectedRun();
  if (run && !run.caseId && !run.testTarget) void startBenchmark({ mode: run.mode, skillMode: run.skillMode ?? 'with' });
});
window.addEventListener('popstate', () => {
  if (!routeReady) return;
  applyRoute(new URL(location.href), { update: null });
  let heading = viewHeadings[view];
  if (view === 'workspace' && creating) heading = 'project-dir';
  else if (view === 'benchmark' && benchmarkGroup && !byId('comparison').hidden) heading = 'comparison-title';
  else if (runId && ((view === 'workspace' && reportFirst) || (view === 'benchmark' && !benchmarkLaunch))) {
    heading = 'execution-title';
  }
  byId(heading).focus({ preventScroll: true });
});

boot();
