import { highlightedPreview } from './workbench-highlight.js';
import { createRunVisualization, isRunTerminalEvent } from './run-visualization.js';

const checks = [
  ['agent', 'Agent 产出', '记录 Agent 运行日志和代码差异。', '⌁'],
  ['skill', 'Skill 证据', '分别记录 Skill 激活事件和读取证据。', '◇'],
  ['code', '代码规范', '用独立配置检查代码和受保护文件。', '‹›'],
  ['backend', '后端启动', '由评测台启动后端并检查健康响应。', '▤'],
  ['frontend', '前端启动', '由评测台启动前端并检查健康响应。', '▣'],
  ['api', 'API 行为', '断言默认列表、状态筛选和非法参数。', '↔'],
  ['browser', '页面联调', '在浏览器里对照状态筛选请求和页面任务。', '▥'],
  ['mutation', '测试辨别力', '用同一批测试比较正常实现和已知缺陷。', '⊙'],
];
const labels = {
  pending: '待检查', queued: '排队中', running: '进行中', completed: '已结束',
  pass: '通过', fail: '失败', blocked: '阻塞', error: '错误',
};
const modeLabels = { codex: 'Codex', opencode: 'OpenCode v1.19.6', demo: '参考演示' };
const skillLabels = { with: '有 Skill', without: '无 Skill' };
const methodLabels = { 'skill-tool': '原生 Skill 工具', 'file-read': '文件读取' };
const skillSignals = {
  observed: ['pass', '已观察'], verified: ['pass', '已验证'],
  'not-observed': ['pending', '未观察到'], unknown: ['pending', '未知'],
};
const experimentLanePlan = [
  ['codex', ['with', 'without']],
  ['opencode', ['without', 'with']],
];
const experimentArms = experimentLanePlan.flatMap(([mode, order]) => order.map((skillMode) => [mode, skillMode]));
const comparisonChecks = checks.slice(2);
const activeStates = new Set(['queued', 'running']);
const terminalRuns = new Set(['completed', 'error']);
const terminalChecks = new Set(['pass', 'fail', 'blocked', 'error']);
const byId = (id) => document.getElementById(id);
const dialog = byId('artifact-dialog');
const dateFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'medium' });
const runVisualization = createRunVisualization(byId('progress'));
const comparisonLanes = experimentLanePlan.map(([mode, order]) => createComparisonLane(mode, order));

let runs = [];
let caseRunActive = false;
const route = new URLSearchParams(window.location.search);
let selectedId = route.get('run');
let selectedExperimentId = route.get('experiment');
let creating = false;
let revision = 0;
let historyKey;
let reportKey;
let comparisonKey;
let syncError = '';
let actionError = '';
let artifactRequest;
let artifactTrigger;
let journal;
let runListTimer;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function button(text, className, onClick) {
  const node = element('button', className, text);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}

function stateBadge(status, label = labels[status]) {
  const node = element('span', 'state', label);
  node.dataset.state = status;
  return node;
}

function skillSignalBadge(evidence, kind) {
  const signal = skillSignals[evidence?.[kind]] ?? skillSignals.unknown;
  return stateBadge(...signal);
}

function runLabel(run) {
  if (run.mode === 'demo') return modeLabels.demo;
  return `${modeLabels[run.mode]} · ${skillLabels[run.skillMode] ?? '原版'}`;
}

function activeRun() {
  return caseRunActive || runs.some((run) => activeStates.has(run.status));
}

function dateLabel(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : dateFormat.format(date);
}

async function request(path, options) {
  const response = await fetch(path, { cache: 'no-store', ...options });
  if (!response.ok) {
    const details = await response.json().catch(() => ({}));
    const error = new Error(details.error || `请求返回 HTTP ${response.status}。`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

function runUrl(run) {
  const url = new URL(window.location.href);
  url.searchParams.set('run', run.id);
  if (run.experimentId) url.searchParams.set('experiment', run.experimentId);
  else url.searchParams.delete('experiment');
  url.hash = '';
  return url;
}

function selectRun(run, remember = false) {
  selectedId = run?.id;
  selectedExperimentId = run?.experimentId;
  if (remember && run) window.history.replaceState(null, '', runUrl(run));
  render();
}

function experimentRun(members) {
  return members.find(({ status }) => status === 'running')
    ?? members.find(({ mode, skillMode }) => mode === 'codex' && skillMode === 'with')
    ?? members[0];
}

function visibleRun() {
  const byRoute = runs.find(({ id }) => id === selectedId);
  if (!selectedExperimentId) return byRoute ?? runs[0];
  const members = runs.filter(({ experimentId }) => experimentId === selectedExperimentId);
  return members.find(({ id }) => id === selectedId) ?? experimentRun(members) ?? byRoute ?? runs[0];
}

function experimentStatus(members) {
  if (members.some(({ status }) => status === 'running')) return 'running';
  if (members.some(({ status }) => status === 'queued')) return 'queued';
  const missingArm = experimentArms.some(([mode, skillMode]) =>
    !members.some((member) => member.mode === mode && member.skillMode === skillMode));
  return missingArm || members.some(({ status }) => status === 'error') ? 'error' : 'completed';
}

function renderHistory() {
  const key = JSON.stringify([selectedId, selectedExperimentId, runs.map(({ id, experimentId, mode, skillMode, status, createdAt }) => [id, experimentId, mode, skillMode, status, createdAt])]);
  if (key === historyKey) return;
  historyKey = key;
  byId('history-count').textContent = `${runs.length} 次运行`;
  const container = byId('history');
  if (!runs.length) {
    container.replaceChildren(element('p', 'history-empty', '暂无运行记录。'));
    return;
  }

  const focused = container.contains(document.activeElement) ? document.activeElement.dataset.runId : undefined;
  const list = element('ul', 'history-list');
  const groups = new Map();
  for (const run of runs) {
    const id = run.experimentId ?? run.id;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(run);
  }
  for (const [id, members] of groups) {
    const latest = members[0];
    const grouped = Boolean(latest.experimentId);
    const selected = grouped ? id === selectedExperimentId : id === selectedId;
    const item = element('li');
    const control = button(null, 'history-item', () => selectRun(grouped ? experimentRun(members) : latest, true));
    control.dataset.runId = id;
    control.title = id;
    if (selected) control.setAttribute('aria-current', 'true');
    const details = element('span');
    const time = element('time', null, dateLabel(latest.createdAt));
    time.dateTime = latest.createdAt;
    details.append(element('strong', null, grouped ? '四组对照' : runLabel(latest)), time);
    control.append(details, stateBadge(grouped ? experimentStatus(members) : latest.status));
    item.append(control);
    list.append(item);
  }
  const previousScroll = container.firstElementChild?.scrollTop ?? 0;
  container.replaceChildren(list);
  list.scrollTop = previousScroll;
  if (focused) {
    Array.from(list.querySelectorAll('button')).find((control) => control.dataset.runId === focused)?.focus({ preventScroll: true });
  }
}

function tableHeading(label, scope) {
  const heading = element('th', null, label);
  heading.scope = scope;
  return heading;
}

function tableCell(content) {
  const cell = element('td');
  cell.append(content);
  return cell;
}

function evidenceCell(evidence, kind) {
  const cell = tableCell(skillSignalBadge(evidence, kind));
  const method = methodLabels[evidence?.method];
  if (method && ['observed', 'verified'].includes(evidence[kind])) {
    cell.append(element('span', 'muted-caption', method));
  }
  return cell;
}

function reportLink(run, className = 'button button-secondary', label = '查看报告') {
  const link = element('a', className, label);
  const url = runUrl(run);
  url.hash = 'report-title';
  link.href = url;
  link.dataset.runId = run.id;
  link.setAttribute('aria-label', `查看 ${runLabel(run)} 报告`);
  link.addEventListener('click', (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    selectRun(run, true);
    byId('report-title').focus();
  });
  return link;
}

function createComparisonLane(mode, order) {
  const node = element('section', 'comparison-lane');
  node.dataset.mode = mode;
  const heading = element('div', 'comparison-lane-heading');
  const title = element('h4', null, modeLabels[mode]);
  title.id = `comparison-lane-${mode}`;
  node.setAttribute('aria-labelledby', title.id);
  const summary = element('span', 'comparison-lane-summary');
  heading.append(title, summary);
  const list = element('ol', 'comparison-lane-steps');
  list.setAttribute('role', 'list');
  const steps = order.map((skillMode) => {
    const node = element('li', 'comparison-step');
    const name = element('div', 'comparison-step-name');
    const badge = stateBadge('pending');
    const line = element('div', 'comparison-step-heading');
    line.append(name, badge);
    const progress = element('progress', 'comparison-step-progress');
    progress.setAttribute('aria-label', `${modeLabels[mode]} ${skillLabels[skillMode]}检查进度`);
    const count = element('span', 'comparison-step-caption');
    node.append(line, progress, count);
    list.append(node);
    return { skillMode, node, name, badge, progress, count };
  });
  node.append(heading, list);
  return { mode, node, summary, steps };
}

function comparisonArmState(run, status) {
  if (run) return [run.status, labels[run.status]];
  return activeStates.has(status) ? ['pending', '待记录'] : ['error', '缺少记录'];
}

function renderComparisonLanes(arms, status) {
  for (const lane of comparisonLanes) {
    let finished = 0;
    for (const step of lane.steps) {
      const run = arms.get(`${lane.mode}-${step.skillMode}`);
      const [state, label] = comparisonArmState(run, status);
      const selected = Boolean(run && run.id === selectedId);
      const total = run?.checks.length ?? 0;
      const checked = run?.checks.filter(({ status }) => terminalChecks.has(status)).length ?? 0;
      if (terminalRuns.has(run?.status)) finished += 1;
      step.node.dataset.state = state;
      step.node.toggleAttribute('data-selected', selected);
      if (!step.name.firstChild || step.name.firstChild.dataset.runId !== run?.id) {
        const title = skillLabels[step.skillMode];
        step.name.replaceChildren(run ? reportLink(run, 'comparison-step-link', title) : element('span', null, title));
      }
      const link = step.name.querySelector('a');
      if (selected) link?.setAttribute('aria-current', 'true');
      else link?.removeAttribute('aria-current');
      step.badge.dataset.state = state;
      if (step.badge.textContent !== label) step.badge.textContent = label;
      step.progress.hidden = total === 0;
      step.progress.max = total || 1;
      step.progress.value = checked;
      const caption = run ? `已检查 ${checked} / ${total} 项` : '';
      step.count.hidden = !run;
      if (step.count.textContent !== caption) step.count.textContent = caption;
    }
    lane.summary.textContent = `${finished} / ${lane.steps.length} 组已结束`;
  }
}

function renderComparison() {
  const container = byId('comparison');
  const members = selectedExperimentId ? runs.filter(({ experimentId }) => experimentId === selectedExperimentId) : [];
  container.hidden = !members.length;
  if (!members.length) {
    comparisonKey = undefined;
    return;
  }
  const key = JSON.stringify([selectedId, members.map(({ id, status, skillEvidence, checks: rowChecks }) => [id, status, skillEvidence, rowChecks.map(({ status: checkStatus }) => checkStatus)])]);
  if (key === comparisonKey) return;
  comparisonKey = key;

  const arms = new Map(experimentArms.map(([mode, skillMode]) => [
    `${mode}-${skillMode}`, members.find((member) => member.mode === mode && member.skillMode === skillMode),
  ]));
  const finished = [...arms.values()].filter((run) => terminalRuns.has(run?.status)).length;
  const date = members.at(-1).createdAt;
  const status = experimentStatus(members);
  byId('comparison-meta').textContent = `${dateLabel(date)} · 已结束 ${finished} / ${experimentArms.length} 组`;
  const statusContainer = byId('comparison-status');
  if (statusContainer.firstElementChild?.dataset.state !== status) statusContainer.replaceChildren(stateBadge(status));
  renderComparisonLanes(arms, status);
  const table = byId('comparison-table');
  const focused = table.contains(document.activeElement) ? document.activeElement.dataset.runId : undefined;
  const head = element('thead');
  const headers = element('tr');
  const captions = ['评测组', '运行', '激活证据', '读取证据', ...comparisonChecks.map(([, title]) => title), '详情'];
  headers.append(...captions.map((caption) => tableHeading(caption, 'col')));
  head.append(headers);

  const body = element('tbody');
  for (const [mode, skillMode] of experimentArms) {
    const run = arms.get(`${mode}-${skillMode}`);
    const row = element('tr');
    row.dataset.arm = `${mode}-${skillMode}`;
    if (run && run.id === selectedId) row.dataset.selected = '';
    const group = tableHeading(modeLabels[mode], 'row');
    group.append(element('span', 'muted-caption', skillLabels[skillMode]));
    const recordedStatus = stateBadge(...comparisonArmState(run, status));
    row.append(group, tableCell(recordedStatus));
    row.append(evidenceCell(run?.skillEvidence, 'activation'), evidenceCell(run?.skillEvidence, 'read'));
    const outcomes = new Map(run?.checks.map(({ id, status }) => [id, status]));
    for (const [id] of comparisonChecks) row.append(tableCell(stateBadge(outcomes.get(id) ?? 'pending')));
    row.append(tableCell(run ? reportLink(run) : '—'));
    body.append(row);
  }
  table.replaceChildren(head, body);
  if (focused) Array.from(table.querySelectorAll('a')).find((link) => link.dataset.runId === focused)?.focus({ preventScroll: true });
}

function syncRunVisualization(run) {
  if (journal?.run.id === run?.id) {
    if (journal && journal.run !== run) {
      journal.run = run;
      runVisualization.update(run, [], { disconnected: journal.disconnected });
    }
    return;
  }

  journal?.controller.abort();
  window.clearTimeout(journal?.timer);
  journal = run && { run, controller: new AbortController(), cursor: 0, terminalReads: 0, disconnected: false };
  runVisualization.update(run ?? null);
  if (journal) void pollJournal(journal);
}

async function pollJournal(subscription) {
  const { controller, run: { id } } = subscription;
  if (controller.signal.aborted) return;
  let delay = 550;
  try {
    const path = `/api/runs/${encodeURIComponent(id)}/events?after=${subscription.cursor}`;
    const { events, status } = await request(path, { signal: controller.signal });
    if (controller.signal.aborted) return;
    const entries = [];
    for (const entry of events.sort((a, b) => a.seq - b.seq)) {
      if (!Number.isSafeInteger(entry.seq) || entry.seq <= subscription.cursor) continue;
      entries.push(entry);
      subscription.cursor = entry.seq;
    }
    subscription.disconnected = false;
    runVisualization.update(subscription.run, entries);
    if (entries.some(isRunTerminalEvent)) return;
    if (entries.length || activeStates.has(status) || activeStates.has(subscription.run.status)) subscription.terminalReads = 0;
    // The final snapshot is visible before the corresponding journal entry is appended.
    else if (++subscription.terminalReads >= 3) return;
  } catch (error) {
    if (controller.signal.aborted) return;
    subscription.disconnected = true;
    runVisualization.update(subscription.run, [], { disconnected: true });
    if (error.status && error.status < 500 && error.status !== 408 && error.status !== 429) return;
    delay = activeStates.has(subscription.run.status) ? 1200 : 3200;
  }
  subscription.timer = window.setTimeout(() => pollJournal(subscription), delay);
}

function openArtifact(run, artifact, trigger) {
  artifactRequest?.abort();
  const controller = new AbortController();
  artifactRequest = controller;
  artifactTrigger = trigger;
  byId('artifact-title').textContent = artifact.label;
  byId('artifact-filename').textContent = artifact.file;
  const content = byId('artifact-content');
  content.replaceChildren(element('p', 'advice-summary', '正在读取证据…'));
  if (!dialog.open) dialog.showModal();

  const url = `/api/runs/${encodeURIComponent(run.id)}/artifacts/${encodeURIComponent(artifact.file)}`;
  const showError = (message) => {
    if (!controller.signal.aborted) content.replaceChildren(element('p', 'advice-summary', message));
  };

  if (/\.(png|jpe?g|webp|gif)$/i.test(artifact.file)) {
    const image = element('img');
    image.alt = artifact.label;
    image.onload = () => {
      if (!controller.signal.aborted) content.replaceChildren(image);
    };
    image.onerror = () => showError('无法读取图片证据。');
    image.src = url;
    return;
  }

  fetch(url, { cache: 'no-store', signal: controller.signal })
    .then((response) => {
      if (!response.ok) throw new Error(`无法读取证据。HTTP ${response.status}`);
      return response.text();
    })
    .then((value) => {
      if (!controller.signal.aborted) content.replaceChildren(value ? highlightedPreview(value, artifact.file) : element('p', 'advice-summary', '此证据文件为空。'));
    })
    .catch((error) => showError(error.message));
}

function artifactActions(run, artifacts) {
  const actions = element('div', 'artifact-actions');
  for (const artifact of artifacts) {
    const trigger = button(artifact.label, 'artifact-link', () => openArtifact(run, artifact, trigger));
    trigger.dataset.artifact = artifact.file;
    actions.append(trigger);
  }
  return actions;
}

function skillDetails(evidence) {
  const details = element('div', 'skill-evidence');
  for (const [kind, title] of [['activation', '激活'], ['read', '读取']]) {
    const item = element('span');
    item.append(title, skillSignalBadge(evidence, kind));
    details.append(item);
  }
  const method = methodLabels[evidence?.method];
  if (method) details.append(element('span', null, method));
  return details;
}

function renderChecks(run) {
  const entries = new Map(run?.checks.map((check) => [check.id, check]));
  const list = document.createDocumentFragment();
  for (const [id, title, defaults, glyph] of checks) {
    const check = entries.get(id);
    const row = element('li', 'check');
    row.id = `check-${id}`;
    row.tabIndex = -1;
    const icon = element('span', 'check-icon', glyph);
    icon.setAttribute('aria-hidden', 'true');
    const detail = element('div');
    detail.append(element('h3', null, title), element('p', null, check?.summary || defaults));
    if (id === 'skill' && run?.mode !== 'demo' && run?.skillMode) detail.append(skillDetails(run.skillEvidence));
    if (check?.artifacts?.length) detail.append(artifactActions(run, check.artifacts));
    row.append(icon, detail, stateBadge(check?.status || 'pending'));
    list.append(row);
  }
  const container = byId('checks');
  const focused = container.contains(document.activeElement) ? document.activeElement : null;
  const rowId = focused?.closest('.check')?.id;
  const artifact = focused?.dataset.artifact;
  container.replaceChildren(list);
  if (rowId) {
    const row = byId(rowId);
    const control = Array.from(row.querySelectorAll('button')).find((trigger) => trigger.dataset.artifact === artifact);
    (control ?? row).focus({ preventScroll: true });
  }
}

function renderAdvice(run) {
  const content = byId('advice');
  const status = byId('advice-status');
  const advice = run?.advice;
  if (advice?.status && run.mode !== 'demo') status.replaceChildren(stateBadge(advice.status, advice.status === 'pass' ? '已生成' : undefined));
  else status.replaceChildren();

  let explanation = '真实评测完成后，Codex 会根据证据给出修复建议和复测步骤。';
  if (run?.mode === 'demo') explanation = '演示运行保留检查证据，修复建议由真实评测生成。';
  else if (advice?.status === 'running') explanation = '正在根据检查证据生成建议…';
  const summary = element('p', 'advice-summary', advice?.summary || explanation);
  const nodes = [summary];
  if (advice?.artifacts?.length) nodes.push(artifactActions(run, advice.artifacts));
  if (!advice?.items?.length) {
    content.replaceChildren(...nodes);
    return;
  }

  const findings = element('ul', 'findings');
  for (const item of advice.items) {
    const finding = element('li', 'finding');
    finding.append(element('h3', null, item.finding));
    const fix = element('p', null, item.fix);
    const steps = element('ol');
    for (const step of item.retest) steps.append(element('li', null, step));
    finding.append(fix, element('h4', null, '复测步骤'), steps);

    const references = element('div', 'refs');
    references.setAttribute('aria-label', '引用的检查项目');
    for (const evidenceId of item.evidenceIds) {
      const check = checks.find(([id]) => id === evidenceId);
      if (!check) continue;
      const link = button(check[1], 'artifact-link', () => {
        const row = byId(`check-${evidenceId}`);
        row.focus({ preventScroll: true });
        row.scrollIntoView({ block: 'nearest' });
      });
      references.append(link);
    }
    if (references.childElementCount) finding.append(references);
    findings.append(finding);
  }
  content.replaceChildren(...nodes, findings);
}

function renderReport(run, busy) {
  const key = JSON.stringify([run, busy]);
  if (key === reportKey) return;
  reportKey = key;
  const meta = byId('report-meta');
  const actions = byId('report-actions');
  if (run) {
    meta.textContent = `${runLabel(run)} · ${dateLabel(run.createdAt)}`;
    meta.title = run.id;
    const skillMode = run.mode === 'demo' ? 'without' : run.skillMode ?? 'with';
    const rerun = button('发起复测', 'button button-secondary', () => launch({ mode: run.mode, skillMode }));
    rerun.title = run.mode === 'demo' || run.skillMode
      ? '从同一初始样例按当前模式发起新一轮评测。'
      : '从同一初始样例按有 Skill 条件复测原版记录。';
    rerun.setAttribute('aria-description', rerun.title);
    rerun.disabled = busy;
    actions.replaceChildren(stateBadge(run.status), rerun);
  } else {
    meta.textContent = '每次运行保留独立的检查证据。';
    meta.removeAttribute('title');
    actions.replaceChildren(stateBadge('pending', '待开始'));
  }

  renderChecks(run);
  renderAdvice(run);
  const live = byId('live-status');
  const status = run ? `${runLabel(run)}${labels[run.status]}，${run.checks.filter((check) => terminalChecks.has(check.status)).length} 项已检查。` : '';
  if (status !== live.textContent) live.textContent = status;
}

function render() {
  const busy = creating || Boolean(activeRun());
  for (const id of ['run-experiment', 'run-single', 'run-demo', 'agent-mode', 'skill-mode']) byId(id).disabled = busy;
  const notice = byId('notice');
  const error = actionError || syncError;
  notice.hidden = !error;
  if (notice.textContent !== error) notice.textContent = error;
  renderHistory();
  renderComparison();
  const run = runs.find((run) => run.id === selectedId);
  syncRunVisualization(run);
  renderReport(run, busy);
}

async function launch({ mode, skillMode, comparison = false }) {
  if (creating || activeRun()) return;
  creating = true;
  actionError = '';
  revision += 1;
  render();

  try {
    const response = await request(comparison ? '/api/experiments' : '/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(comparison ? {} : { mode, skillMode }),
    });
    const admitted = comparison ? response.runs : [response.run];
    const ids = new Set(admitted.map(({ id }) => id));
    runs = [...admitted, ...runs.filter(({ id }) => !ids.has(id))];
    syncError = '';
    selectRun(comparison ? experimentRun(admitted) : admitted[0], true);
    byId(comparison ? 'comparison-title' : 'report-title').focus();
  } catch (error) {
    actionError = `${comparison ? '四组对照' : '评测'}未启动。${error.message}`;
  } finally {
    revision += 1;
    creating = false;
    render();
    if (activeRun() && runListTimer !== undefined) {
      window.clearTimeout(runListTimer);
      runListTimer = window.setTimeout(poll, 0);
    }
  }
}

async function poll() {
  runListTimer = undefined;
  const currentRevision = revision;
  try {
    const result = await request('/api/runs');
    if (currentRevision !== revision || creating) return;
    const caseRun = result.runs.find((run) => run.caseId && run.id === selectedId);
    if (caseRun) {
      location.replace(`/?${new URLSearchParams({ case: caseRun.caseId, run: caseRun.id })}`);
      return;
    }
    caseRunActive = result.runs.some((run) => run.caseId && activeStates.has(run.status));
    runs = result.runs.filter((run) => !run.caseId);
    syncError = '';
    const run = visibleRun();
    selectedId = run?.id;
    selectedExperimentId = run?.experimentId;
  } catch (error) {
    if (currentRevision === revision) syncError = `无法更新运行记录。${error.message}`;
  } finally {
    render();
    runListTimer = window.setTimeout(poll, activeRun() ? 900 : 3200);
  }
}

byId('single-run-form').addEventListener('submit', (event) => {
  event.preventDefault();
  launch({ mode: byId('agent-mode').value, skillMode: byId('skill-mode').value });
});
byId('run-experiment').addEventListener('click', () => launch({ comparison: true }));
byId('run-demo').addEventListener('click', () => launch({ mode: 'demo', skillMode: 'without' }));
byId('close-artifact').addEventListener('click', () => dialog.close());
dialog.addEventListener('close', () => {
  artifactRequest?.abort();
  if (artifactTrigger?.isConnected) {
    artifactTrigger.focus();
    return;
  }
  const trigger = Array.from(document.querySelectorAll('button[data-artifact]')).find((control) => control.dataset.artifact === artifactTrigger?.dataset.artifact);
  (trigger ?? byId('report-title')).focus();
});
byId('comparison-lanes').append(...comparisonLanes.map(({ node }) => node));
render();
poll();
