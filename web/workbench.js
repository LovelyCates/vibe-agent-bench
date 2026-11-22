import { highlightedPreview } from './workbench-highlight.js';
import { createRunVisualization, isRunTerminalEvent, runEventPhase } from './run-visualization.js';

const byId = (id) => document.getElementById(id);
const labels = {
  draft: '待审核', approved: '已审核', queued: '排队中', pending: '等待中', running: '进行中',
  preparing: '准备中', completed: '已结束', pass: '通过', fail: '失败', failed: '失败',
  blocked: '阻塞', error: '异常', interrupted: '已中断', skipped: '已跳过',
};
const phases = { run: '调度', workspace: '准备工作副本', setup: '准备命令', agent: 'OpenCode', verify: '验收', advice: '修复建议' };
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
const draftEdits = new Map();
const runs = new Map();
const caseList = byId('case-list');
const eventsList = byId('events');
const eventFilter = byId('event-filter');
const eventSearch = byId('event-search');
const eventSearchText = new WeakMap();
const runVisualization = createRunVisualization(byId('run-visualization'), { onPhaseSelect: showPhaseEvents });
const dialog = byId('artifact-dialog');
const route = new URL(location.href);
let cases = [];
let defaultProject = '';
let scenario;
let skillProfiles = [];
let caseId = route.searchParams.get('case');
let runId = route.searchParams.get('run');
let currentTab = 'spec';
let historyView = route.hash === '#history';
let creating = false;
let loaded = false;
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
let seenActive = false;
let seenEnd = false;
let finalReads = 0;
let deferredEvents = [];
let evidenceEvents = [];
let previewController;
let previewTrigger;

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
  if (run.checks?.some(({ status }) => ['fail', 'error'].includes(status))) return badge('fail', '有检查未通过');
  if (run.checks?.some(({ status }) => ['blocked', 'skipped'].includes(status))) return badge('blocked', '有检查阻塞');
  return badge('pass', '验收通过');
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
const runRoute = (id) => `/api/runs/${encodeURIComponent(id)}`;
const selectedCase = () => cases.find(({ id }) => id === caseId);
const selectedRun = () => runs.get(runId);

function caseData(testCase) {
  return { title: testCase.title, requirement: testCase.requirement, prompt: testCase.prompt,
    commands: testCase.commands ?? [], skillProfile: testCase.skillProfile ?? 'none' };
}

function newestRuns() {
  return [...runs.values()].sort((a, b) => String(b.createdAt || b.startedAt).localeCompare(String(a.createdAt || a.startedAt)));
}

function latestRun(id) {
  return newestRuns().find((run) => run.caseId === id);
}

function updateNotice() {
  const text = notice || pollError;
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

function updateLocation(mode = 'replaceState') {
  const next = new URL('/', location.href);
  if (caseId) next.searchParams.set('case', caseId);
  if (runId) next.searchParams.set('run', runId);
  if (historyView) next.hash = '#history';
  if (next.href !== location.href) history[mode](null, '', next);
}

function renderNavigation() {
  byId('workspace-intro').hidden = historyView;
  byId('workspace').hidden = historyView;
  byId('history-intro').hidden = !historyView;
  byId('history').hidden = !historyView;
  byId('workspace-link').toggleAttribute('aria-current', !historyView);
  byId('history-link').toggleAttribute('aria-current', historyView);
  byId(historyView ? 'history-link' : 'workspace-link').setAttribute('aria-current', 'page');
  if (historyView) renderHistory();
}

function renderCases() {
  byId('case-count').textContent = String(cases.length);
  if (!cases.length) {
    caseList.replaceChildren(element('p', 'empty-small', '还没有项目用例。'));
    return;
  }
  const list = document.createDocumentFragment();
  for (const record of cases) {
    const entry = button(null, 'case-item', () => chooseCase(record.id));
    if (record.id === caseId && !creating) entry.setAttribute('aria-current', 'true');
    const file = element('span', 'shelf-icon');
    file.append(icon('file'));
    const copy = element('span');
    copy.append(element('span', 'case-title', record.title), element('span', 'case-subtitle', `${record.projectName} · ${labels[record.status]}`));
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

function renderFlow() {
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
  renderSkillProfile(edit.skillProfile, testCase.profile === 'sample');
  if (JSON.stringify(caseData(testCase)) === JSON.stringify(edit)) draftEdits.delete(caseId);
  else draftEdits.set(caseId, edit);
  renderReviewActions();
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

function renderReview() {
  const testCase = selectedCase();
  const review = byId('case-panel');
  const report = byId('execution');
  if (reportFirst && runId && report.previousElementSibling === review) review.before(report);
  else if ((!reportFirst || !runId) && review.previousElementSibling === report) report.before(review);
  review.hidden = !testCase || creating;
  byId('create-panel').hidden = !creating;
  report.hidden = (!testCase && !runId) || creating;
  byId('cancel-create').hidden = !cases.length;
  renderFlow();
  if (!testCase || creating) return;
  byId('case-title').textContent = testCase.title;
  byId('case-path').textContent = testCase.projectDir;
  byId('case-state').replaceWith(Object.assign(badge(testCase.status), { id: 'case-state' }));
  byId('case-version').textContent = `v${testCase.version}`;
  const data = draftEdits.get(caseId) ?? caseData(testCase);
  for (const name of editors) byId(`review-${name}`).value = data[name];
  const sample = testCase.profile === 'sample';
  const skillSelect = byId('review-skill-profile');
  const available = skillProfiles.length ? skillProfiles : [{ id: 'none', title: '无配置 Skill' }];
  const options = sample ? available.filter(({ id }) => id === 'none') : [...available];
  if (!options.some(({ id }) => id === data.skillProfile)) options.push({ id: data.skillProfile, title: `${data.skillProfile}（本机缺少）` });
  skillSelect.replaceChildren(...options.map(({ id, title }) => Object.assign(element('option', null, title), { value: id })));
  skillSelect.value = data.skillProfile;
  renderSkillProfile(data.skillProfile, sample);
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
  const testCase = selectedCase();
  if (!testCase || creating) return;
  const dirty = draftEdits.has(caseId);
  const approval = testCase.status === 'approved';
  const stale = approval && skillLockChanged(testCase);
  const run = selectedRun();
  const runningHere = run?.caseId === caseId && active.has(run.status);
  const data = draftEdits.get(caseId) ?? caseData(testCase);
  byId('command-count').textContent = String(testCase.profile === 'sample' ? sampleChecks.length : data.commands.length);
  byId('save-case').hidden = approval && !dirty;
  byId('save-case').disabled = Boolean(busy) || !dirty;
  byId('approve-case').hidden = approval && !dirty && !stale;
  byId('approve-case').disabled = Boolean(busy);
  byId('run-case').disabled = Boolean(busy) || dirty || !approval || runningHere || stale;
  byId('run-case').lastElementChild.textContent = runningHere ? '用例执行中' : run?.caseVersion === testCase.version ? '再次运行' : '运行用例';
  byId('add-command').disabled = Boolean(busy) || data.commands.length >= 20;
  for (const control of byId('review-form').querySelectorAll('input, select, textarea, .command .icon-button')) {
    control.disabled = busy === 'review';
  }
  byId('review-skill-profile').disabled ||= testCase.profile === 'sample';
  let hint = '审核通过后即可运行。';
  if (dirty) hint = '有未保存的修改，审核后即可按新版本运行。';
  else if (runningHere) hint = `正在执行 v${run.caseVersion}。`;
  else if (stale) hint = 'Skill 包版本已变更，请重新审查配置。';
  else if (approval) hint = `已准备好运行 v${testCase.version}。`;
  byId('review-hint').textContent = hint;
}

function renderHistory() {
  const entries = newestRuns().filter((run) => run.caseId).map((run) => {
    const profile = skillProfiles.find(({ id }) => id === run.skillProfile);
    const details = [`v${run.caseVersion}`, run.scenario || run.skillProfile !== 'none' ? profile?.title : '',
      formatTime(run.startedAt || run.createdAt)].filter(Boolean).join(' · ');
    return { run, details };
  });
  const signature = JSON.stringify(entries.map(({ run, details }) => [
    run.id, run.caseId, run.caseTitle, details, run.status,
    run.status === 'completed' && run.checks?.map(({ status }) => status),
  ]));
  if (signature === historySignature) return;
  historySignature = signature;

  byId('history-count').textContent = `共 ${entries.length} 次运行`;
  const container = byId('history-list');
  const focused = container.contains(document.activeElement) ? document.activeElement.dataset.runId : undefined;
  const list = document.createDocumentFragment();
  for (const { run, details } of entries) {
    const link = element('a', 'history-run');
    link.dataset.runId = run.id;
    link.href = `/?${new URLSearchParams({ case: run.caseId, run: run.id })}`;
    link.addEventListener('click', (event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      chooseCase(run.caseId, run.id, { focusExecution: true });
    });
    const copy = element('span');
    copy.append(element('strong', null, run.caseTitle), element('small', null, details));
    link.append(copy, runBadge(run));
    list.append(link);
  }
  if (!entries.length) list.append(element('p', 'empty-small', '还没有单用例评测记录。'));
  container.replaceChildren(list);
  if (focused) {
    const replacement = [...container.children].find((link) => link.dataset.runId === focused);
    (replacement ?? byId('history-title')).focus({ preventScroll: true });
  }
}

function setBusy(action) {
  busy = action;
  byId('generate').disabled = Boolean(action);
  byId('generate').firstChild.data = action === 'create' ? '正在生成…' : '生成审核草稿';
  for (const control of byId('create-form').querySelectorAll('input, textarea')) control.disabled = action === 'create';
  byId('use-sample').disabled = action === 'create';
  byId('use-java-vue').disabled = action === 'create';
  byId('cancel-create').disabled = action === 'create';
  renderReviewActions();
}

function rememberCase(record) {
  cases = [record, ...cases.filter(({ id }) => id !== record.id)];
  draftEdits.delete(record.id);
}

function chooseCase(id, requestedRun, { focusExecution = false, update = 'pushState' } = {}) {
  const changed = caseId !== id || creating;
  caseId = id;
  creating = false;
  historyView = false;
  reportFirst = Boolean(requestedRun);
  if (changed) currentTab = 'spec';
  setNotice('');
  selectRun(requestedRun ?? latestRun(id)?.id ?? null);
  renderNavigation();
  renderCases();
  renderReview();
  updateLocation(update);
  if (focusExecution && runId) focusRun();
  else if (changed && selectedCase()) byId('case-title').focus({ preventScroll: true });
}

function openCreate() {
  creating = true;
  setNotice('');
  renderCases();
  renderReview();
  byId('project-dir').focus();
}

async function createCase(event) {
  event.preventDefault();
  if (busy) return;
  const requestBody = Object.fromEntries(new FormData(event.currentTarget));
  requestBody.projectDir = requestBody.projectDir.trim().replace(/^"(.*)"$/u, '$1');
  setNotice('');
  setBusy('create');
  try {
    const { case: record } = await api('/api/cases', { method: 'POST', body: requestBody });
    byId('create-form').reset();
    rememberCase(record);
    chooseCase(record.id);
  } catch (error) {
    setNotice(error.message);
    byId('notice').scrollIntoView({ block: 'nearest' });
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
    changeTab('spec');
    byId(`review-${missing}`).focus();
    setNotice('请填写用例标题、需求和提示词，再审核通过。');
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
  } catch (error) {
    setNotice(error.message);
    byId('notice').scrollIntoView({ block: 'nearest' });
  } finally {
    setBusy('');
  }
}

function focusRun() {
  byId('execution-title').focus({ preventScroll: true });
  if (byId('execution').getBoundingClientRect().top > innerHeight * .52 || byId('execution').getBoundingClientRect().top < 0) {
    byId('execution').scrollIntoView({ block: 'start', behavior: 'instant' });
  }
}

async function startRun() {
  const testCase = selectedCase();
  if (!testCase || byId('run-case').disabled) return;
  setNotice('');
  setBusy('run');
  try {
    const { run } = await api(`${caseRoute(testCase.id)}/run`, { method: 'POST', body: { version: testCase.version } });
    runs.set(run.id, run);
    chooseCase(testCase.id, run.id, { focusExecution: true });
  } catch (error) {
    setNotice(error.message);
    byId('notice').scrollIntoView({ block: 'nearest' });
  } finally {
    setBusy('');
  }
}

function openPreview(label, file, trigger, href) {
  previewController?.abort();
  previewController = new AbortController();
  previewTrigger = trigger;
  byId('artifact-title').textContent = label;
  byId('artifact-file').textContent = file;
  const raw = byId('artifact-raw');
  raw.hidden = !href;
  if (href) raw.href = href;
  byId('artifact-content').replaceChildren(element('p', 'empty-small', '正在读取证据…'));
  if (!dialog.open) dialog.showModal();
  return previewController.signal;
}

function previewText(text, file, signal) {
  if (signal.aborted) return;
  byId('artifact-content').replaceChildren(text ? highlightedPreview(text, file) : element('p', 'empty-small', '此文件为空。'));
}

function previewError(error, signal) {
  if (!signal.aborted) byId('artifact-content').replaceChildren(element('p', 'notice', error.message));
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
  const url = `${runRoute(run.id)}/artifacts/${encodeURIComponent(artifact.file)}`;
  const signal = openPreview(artifact.label, artifact.file, trigger, url);
  try {
    if (/\.(png|webp|jpe?g|gif)$/i.test(artifact.file)) {
      const image = element('img');
      image.alt = artifact.label;
      image.src = url;
      await image.decode();
      if (!signal.aborted) byId('artifact-content').replaceChildren(image);
      return;
    }
    const response = await fetch(url, { cache: 'no-store', signal });
    if (!response.ok) throw new Error(`无法读取证据。HTTP ${response.status}`);
    previewText(await response.text(), artifact.file, signal);
  } catch (error) {
    previewError(error, signal);
  }
}

function artifactActions(run, artifacts = []) {
  const nodes = element('div', 'artifact-links');
  for (const artifact of artifacts) {
    if (!artifact?.file) continue;
    const trigger = button(null, 'artifact-link', () => showArtifact(run, artifact, trigger));
    trigger.dataset.artifact = artifact.file;
    trigger.append(icon('file'), element('span', null, artifact.label || artifact.file));
    nodes.append(trigger);
  }
  return nodes;
}

function focusCheck(id) {
  const row = byId(`check-${id}`);
  row?.focus({ preventScroll: true });
  row?.scrollIntoView({ block: 'nearest' });
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
    || (entry.kind === 'tool' && entry.status === 'completed' && (entry.tool === 'skill' || editTools.has(entry.tool)));
}

function showsVerifiedRead(entry) {
  return entry.summary?.startsWith('已验证读取 · ');
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
  const acceptance = agentIndex < 0 ? [] : checks.slice(agentIndex + 1).filter(({ id }) => id !== 'skill');
  const proof = skillCheck?.artifacts?.find(({ file }) => file === 'skill-proof.json');
  const diff = agentCheck?.artifacts?.find(({ file }) => file === 'candidate.diff');
  const inventory = evidenceEvents.find(({ kind, checkId }) => kind === 'phase' && checkId === 'skill');
  const calls = evidenceEvents.filter(({ tool }) => tool === 'skill');
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
  } else if (calls.length || inventory) {
    if (inventory) skill.append(element('p', null, inventory.summary));
    skill.append(element('p', null, `原生加载 ${calls.length} 次 · 正文验证 ${reads.length} 次`));
  } else if (run.skillEvidence?.read === 'verified') {
    skill.append(element('p', null, 'Skill 正文读取已验证。'));
  } else if (run.skillProfile === 'none') {
    skill.append(element('p', null, '本轮未配置 Skill。'));
  } else {
    const profile = skillProfiles.find(({ id }) => id === run.skillProfile);
    skill.append(element('p', null, [profile?.title, running ? '等待发现与加载' : '未记录发现与加载'].filter(Boolean).join(' · ')));
  }
  if (proof) skill.append(artifactActions(run, [proof]));
  else if (calls.length || inventory) {
    skill.append(evidenceButton('查看 Skill 事件', 'skill-events', () => focusEvidenceEvent((reads[0] ?? calls[0] ?? inventory).seq)));
  }

  const changes = evidenceCard('代码改动', 'code');
  changes.append(element('p', null, edits.length ? `观察到 ${edits.length} 次已完成的编辑调用`
    : running ? '等待编辑事件' : '未记录编辑工具完成事件'));
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
    verification.append(outcomes, evidenceButton('查看验收检查', 'verification', () => focusCheck(acceptance[0].id)));
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
  const rows = document.createDocumentFragment();
  for (const check of run.checks) {
    const row = element('li', 'check');
    row.id = `check-${check.id}`;
    row.tabIndex = -1;
    row.dataset.state = check.status;
    const mark = element('span', 'check-icon');
    const marker = check.status === 'pass' ? 'check' : ['fail', 'error'].includes(check.status) ? 'cross' : pending.has(check.status) ? 'clock' : 'terminal';
    mark.append(icon(marker));
    const copy = element('div', 'check-copy');
    copy.append(element('strong', null, check.title));
    if (check.summary) copy.append(element('p', null, check.summary));
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
    if (check.artifacts?.length) copy.append(artifactActions(run, check.artifacts));
    const aside = element('div', 'check-aside');
    aside.append(badge(check.status));
    if (duration(check.durationMs)) aside.append(element('span', 'duration', duration(check.durationMs)));
    row.append(mark, copy, aside);
    rows.append(row);
  }
  list.replaceChildren(rows);
  if (file) [...list.querySelectorAll('[data-artifact]')].find((control) => control.dataset.artifact === file)?.focus({ preventScroll: true });
}

function addEvents(run, entries, live) {
  const fragment = document.createDocumentFragment();
  const following = followingTimeline();
  const filter = eventFilter.value;
  const query = eventSearch.value.trim().toLowerCase();
  for (const entry of entries) {
    const row = element('li', 'event');
    row.dataset.seq = String(entry.seq);
    row.dataset.state = entry.status ?? '';
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
    const status = labels[entry.status];
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
      time.textContent, kindLabel, kind, summary, ...context, status, entry.status, entry.tool, detailText,
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
  const title = byId('events-title');
  title.focus({ preventScroll: true });
  title.scrollIntoView({ block: 'nearest' });
}

function showPhaseEvents(phase) {
  eventFilter.value = `phase-${phase}`;
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
    : active.has(selectedRun()?.status) ? '等待执行事件…' : '这次运行暂时没有事件。';
}

function renderAdvice(run) {
  const advice = run.advice;
  byId('advice').hidden = !advice || (advice.status === 'pending' && !advice.summary);
  if (!advice || byId('advice').hidden) return;
  byId('advice-state').replaceChildren(badge(advice.status, advice.status === 'pass' ? '已生成' : undefined));
  const body = document.createDocumentFragment();
  if (advice.summary) body.append(element('p', null, advice.summary));
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
  runVisualization.update(run, entries, { disconnected: Boolean(pollError) });
  byId('execution-empty').hidden = Boolean(run);
  byId('execution-empty').lastElementChild.textContent = missingRun ? '找不到这次运行。'
    : runId ? '正在读取这次运行…' : '运行已审核的用例后，检查结果会出现在这里。';
  byId('execution-body').hidden = !run;
  if (!run) {
    byId('execution-meta').textContent = '执行后会逐项显示状态、耗时和证据。';
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
  const profile = skillProfiles.find(({ id }) => id === run.skillProfile);
  byId('execution-meta').textContent = [run.caseTitle, `v${run.caseVersion}`, 'OpenCode',
    run.scenario || run.skillProfile !== 'none' ? profile?.title : '', formatTime(run.startedAt || run.createdAt)].filter(Boolean).join(' · ');
  byId('execution-meta').title = run.id;
  const live = `${labels[run.status]}。${done} 项检查已完成。`;
  if (byId('execution-live').textContent !== live) byId('execution-live').textContent = live;
  renderEventEmpty();
  renderChecks(run);
  renderAdvice(run);
}

function selectRun(next) {
  if (runId === next && pollController) return;
  runId = next;
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
  eventFilter.value = 'all';
  eventSearch.value = '';
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
  if (historyView) renderHistory();
  if (running) seenActive = true;
  // The final event can be appended after the state snapshot changes to completed.
  const draining = seenActive && !seenEnd && (!run?.finishedAt || finalReads < 3);
  if (!running && draining && run?.finishedAt) finalReads += 1;
  if (!missingRun && (running || draining || retryable)) {
    pollTimer = setTimeout(() => refreshRun(id, signal), failures.length ? 1200 : 500);
  }
}

async function loadHistory() {
  const { runs: entries } = await api('/api/runs');
  for (const run of entries) if (run.caseId) runs.set(run.id, run);
  if (historyView) renderHistory();
}

function showHistory() {
  historyView = true;
  setNotice('');
  renderNavigation();
  updateLocation('pushState');
  loadHistory().catch((error) => setNotice(error.message));
  byId('history-title').focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

async function boot() {
  const [projects, records] = await Promise.allSettled([api('/api/cases'), loadHistory()]);
  if (projects.status === 'rejected') {
    connection('error', '连接失败');
    caseList.replaceChildren(element('p', 'empty-small', '无法读取项目用例。'));
    setNotice(projects.reason.message);
    return;
  }
  loaded = true;
  connection('ready', '本地服务已连接');
  cases = projects.value.cases;
  defaultProject = projects.value.defaultProject;
  scenario = projects.value.scenarios?.[0];
  skillProfiles = projects.value.skillProfiles ?? [];
  byId('use-sample').hidden = !defaultProject;
  byId('use-java-vue').hidden = !scenario;
  let run = selectedRun();
  if (!run && runId) {
    try {
      ({ run } = await api(runRoute(runId)));
      if (run.caseId) runs.set(runId, run);
      else {
        location.replace(`/benchmark?${new URLSearchParams({ run: runId })}`);
        return;
      }
    } catch (error) {
      setNotice(error.message);
      runId = null;
    }
  }
  if (run?.caseId) caseId = run.caseId;
  if (!selectedCase() && !run) caseId = cases[0]?.id ?? null;
  creating = !caseId && !run;
  selectRun(run?.id ?? latestRun(caseId)?.id ?? null);
  renderNavigation();
  renderCases();
  renderReview();
  updateLocation();
  if (!notice && records.status === 'rejected') setNotice(records.reason.message);
  if (route.searchParams.has('run') && run && !historyView) focusRun();
}

byId('new-case').addEventListener('click', openCreate);
byId('cancel-create').addEventListener('click', () => chooseCase(caseId ?? cases[0]?.id));
byId('use-sample').addEventListener('click', () => {
  byId('project-dir').value = defaultProject;
  byId('project-dir').focus();
});
byId('use-java-vue').addEventListener('click', () => {
  if (!scenario) return;
  byId('project-dir').value = scenario.projectDir;
  byId('create-title-input').value = scenario.title;
  byId('create-requirement').value = scenario.requirement;
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
new ResizeObserver(updateTimelineLatest).observe(eventsList);
byId('create-form').addEventListener('submit', createCase);
byId('review-form').addEventListener('input', storeEdits);
byId('review-form').addEventListener('submit', updateCase);
byId('run-case').addEventListener('click', startRun);
byId('timeline-jump').addEventListener('click', (event) => {
  event.preventDefault();
  focusTimeline();
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
dialog.addEventListener('close', () => {
  previewController?.abort();
  const file = previewTrigger?.dataset.artifact;
  if (previewTrigger?.isConnected) previewTrigger.focus();
  else if (file) [...document.querySelectorAll('[data-artifact]')].find((control) => control.dataset.artifact === file)?.focus();
});
byId('history-link').addEventListener('click', (event) => {
  event.preventDefault();
  showHistory();
});
byId('workspace-link').addEventListener('click', (event) => {
  event.preventDefault();
  historyView = false;
  renderNavigation();
  updateLocation('pushState');
  byId('page-title').focus({ preventScroll: true });
  window.scrollTo(0, 0);
});
window.addEventListener('popstate', () => {
  if (!loaded) return;
  const current = new URL(location.href);
  if (current.hash === '#history') {
    historyView = true;
    renderNavigation();
    return;
  }
  const nextRun = current.searchParams.get('run');
  const nextCase = current.searchParams.get('case') ?? runs.get(nextRun)?.caseId ?? cases[0]?.id;
  if (nextCase) chooseCase(nextCase, nextRun ?? undefined, { update: 'replaceState' });
  else {
    historyView = false;
    renderNavigation();
    openCreate();
  }
});

boot();
