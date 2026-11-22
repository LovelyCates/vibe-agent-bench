import { renderOperationsEvidence } from './evidence-operations.js';
import { renderSkillEvidence } from './evidence-skills.js';
import { renderValidationEvidence } from './evidence-validation.js';
import { highlightedPreview } from './workbench-highlight.js';

const formatNumber = new Intl.NumberFormat('zh-CN');
const statusLabels = {
  pass: '通过', fail: '失败', error: '异常', blocked: '阻塞', pending: '未记录',
  skipped: '跳过', completed: '已完成', running: '进行中',
};
const maxStructuredLength = 2_000_000;
const previewLimit = 80;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = String(text);
  return node;
}

function valueText(value) {
  if (value == null || value === '') return '未记录';
  if (typeof value === 'boolean') return value ? '是' : '否';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function setValue(node, value) {
  node.append(value instanceof Node ? value : valueText(value));
}

function badge(status, label = Object.hasOwn(statusLabels, status) ? statusLabels[status] : status) {
  const node = element('span', 'badge', label);
  node.dataset.state = status;
  return node;
}

function facts(entries) {
  const list = element('dl', 'evidence-facts');
  for (const [label, value] of entries) {
    const field = element('div', 'evidence-fact');
    const content = element('dd');
    setValue(content, value);
    field.append(element('dt', null, label), content);
    list.append(field);
  }
  return list;
}

function metrics(entries) {
  const list = element('dl', 'evidence-metrics');
  for (const [label, value, status] of entries) {
    const metric = element('div', 'evidence-metric');
    if (status) metric.dataset.state = status;
    const content = element('dd');
    setValue(content, value);
    metric.append(element('dt', null, label), content);
    list.append(metric);
  }
  return list;
}

function section(title, ...children) {
  const card = element('section', 'evidence-section');
  card.append(element('h3', null, title), ...children.filter((node) => node != null));
  return card;
}

function table(headings, rows, caption = '证据明细') {
  const scroll = element('div', 'evidence-table-scroll');
  scroll.tabIndex = 0;
  scroll.setAttribute('role', 'region');
  scroll.setAttribute('aria-label', caption);
  const grid = element('table', 'evidence-table');
  const head = grid.createTHead().insertRow();
  for (const label of headings) {
    const heading = element('th', null, label);
    heading.scope = 'col';
    head.append(heading);
  }
  const body = grid.createTBody();
  for (const values of rows) {
    const row = body.insertRow();
    for (const value of values) setValue(row.insertCell(), value);
  }
  scroll.append(grid);
  return scroll;
}

function details(title, ...children) {
  const node = element('details', 'evidence-details');
  node.append(element('summary', null, title), ...children.filter((child) => child != null));
  return node;
}

function note(text) {
  return element('p', 'evidence-note', text);
}

function code(value, file = 'detail.txt') {
  const wrapper = element('div', 'evidence-code');
  wrapper.append(highlightedPreview(valueText(value), file, { maxLines: 100, maxChars: 16_000 }));
  return wrapper;
}

const ui = { element, badge, facts, metrics, section, table, details, note, code };
const renderers = [renderValidationEvidence, renderSkillEvidence, renderOperationsEvidence];

function expandable(title, render) {
  const node = details(title);
  const fill = () => {
    if (!node.open) return;
    node.append(render());
    node.removeEventListener('toggle', fill);
  };
  node.addEventListener('toggle', fill);
  return node;
}

const fields = new Map(Object.entries({
  model: '模型 ID', modelProvider: '模型服务', reasoningEffort: '推理强度', apiStyle: '接口协议',
  baseURL: 'API 地址', version: '版本', status: '状态', startedAt: '开始时间', finishedAt: '结束时间',
  durationMs: '耗时', timeoutMs: '超时设置', sessionId: '会话 ID', execution: '执行结果',
  code: '退出码', signal: '退出信号', timedOut: '是否超时', spawnError: '启动错误',
  finishReason: '结束原因', permissionMode: '权限模式', skillProfile: 'Skill 配置',
  auth: '认证方式', summary: '摘要', error: '错误信息', reason: '原因', path: '路径',
}));

function showField(key, value) {
  if (typeof value === 'number' && (key === 'durationMs' || key === 'timeoutMs')) return `${formatNumber.format(value)} ms`;
  if (typeof value === 'string' && value.length > 240) return expandable('查看完整内容', () => code(value));
  return value;
}

function fieldTree(data) {
  if (!data || typeof data !== 'object') return code(data);
  const output = document.createDocumentFragment();
  const pairs = Object.entries(data);
  const flat = [];
  for (const [key, value] of pairs.slice(0, previewLimit)) {
    const label = Array.isArray(data) ? `第 ${Number(key) + 1} 项` : fields.get(key) ?? key;
    if (value && typeof value === 'object') {
      const size = Object.keys(value).length;
      output.append(expandable(`${label} · ${size} ${Array.isArray(value) ? '项' : '个字段'}`, () => fieldTree(value)));
    } else {
      flat.push([label, showField(key, value)]);
    }
  }
  if (flat.length) output.prepend(facts(flat));
  if (!pairs.length) output.append(note('此处没有记录。'));
  if (pairs.length > previewLimit) output.append(note(`此层预览前 ${previewLimit} 项，完整数据见原始内容。`));
  return output;
}

function agentConfiguration(file, data) {
  if (!/^(?:codex-(?:agent|review)|opencode-agent|dsh-agent)-config\.json$/u.test(file)
    || !data || typeof data !== 'object' || Array.isArray(data)) return null;
  const config = [['模型 ID', data.model], ['模型服务', data.modelProvider], ['推理强度', data.reasoningEffort],
    ['Agent 版本', data.version], ['API 地址', data.baseURL], ['认证方式', data.auth]].filter(([, value]) => value != null);
  if (!config.length) return null;
  const process = [['退出码', data.execution?.code], ['是否超时', data.execution?.timedOut], ['结束原因', data.finishReason]]
    .filter(([, value]) => value != null);
  return section(file === 'codex-review-config.json' ? '审阅模型配置' : '本轮 Agent 配置',
    facts(config), process.length ? facts(process) : null, expandable('更多配置字段', () => fieldTree(data)));
}

const eventLabels = new Map(Object.entries({
  session: '会话启动', 'thread.started': '会话启动', 'turn.started': '轮次开始', 'turn.completed': '轮次结束',
  step_start: '步骤开始', step_finish: '步骤结束', tool_use: '工具记录', tool_call: '工具调用',
  tool_result: '工具返回', text: 'Agent 输出', final: '最终输出', thinking: '思考记录',
  status: '状态变化', error: '异常',
}));
const commandItems = new Set(['command_execution', 'mcp_tool_call', 'file_change', 'web_search']);
const errorStates = new Set(['fail', 'failed', 'failure', 'error', 'aborted', 'timeout']);
const logFilters = [
  ['important', '主要事件'], ['tool', '工具事件'], ['message', 'Agent 输出'], ['error', '异常事件'], ['all', '全部记录'],
];

function describeEvent(record, callNames) {
  const type = String(record.type ?? record.kind ?? record.event ?? '记录');
  const item = record.item ?? record.part ?? {};
  const input = record.input ?? item.state?.input ?? {};
  const name = record.tool ?? item.tool ?? callNames.get(record.callId) ?? item.command;
  if (record.callId && typeof name === 'string') callNames.set(record.callId, name);
  const state = record.status ?? item.state?.status ?? item.status;
  const error = Boolean(record.error) || errorStates.has(state) || /(?:^|[._])(?:failed|error)$/u.test(type)
    || (Number.isInteger(item.exit_code) && item.exit_code !== 0);
  const message = ['text', 'final', 'message'].includes(type) || item.type === 'agent_message';
  const tool = /^tool[_.]/u.test(type) || commandItems.has(item.type);
  const group = error ? 'error' : tool ? 'tool' : message ? 'message' : 'other';
  const title = eventLabels.get(type) ?? (item.type === 'command_execution' ? '命令执行'
    : item.type === 'file_change' ? '文件改动' : message ? 'Agent 输出' : type);
  const summary = [input.path, input.filePath, input.file_path, input.name, input.pattern, input.command,
    message ? record.text ?? item.text : undefined, record.phase, record.reason?.kind,
    typeof record.error === 'string' ? record.error : record.error?.message]
    .find((value) => typeof value === 'string' && value.trim() && value !== name);
  const parts = [title, typeof name === 'string' ? name : null, summary].filter(Boolean);
  return { title: parts.join(' · ').replace(/\s+/gu, ' ').slice(0, 200), group, tool, error, message,
    keywords: [...parts, record.callId, item.id, item.callID].filter((value) => typeof value === 'string').join(' ').toLowerCase() };
}

function eventLog(source) {
  const lines = source.split(/\r?\n/u);
  const callNames = new Map();
  const records = [];
  let unreadable = 0;
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record && typeof record === 'object' && !Array.isArray(record)) {
        records.push({ record, line: index + 1, ...describeEvent(record, callNames) });
      } else unreadable += 1;
    } catch {
      unreadable += 1;
    }
  }
  if (!records.length) return null;
  const tools = records.filter(({ tool }) => tool).length;
  const errors = records.filter(({ error }) => error).length;
  const view = element('div', 'evidence-log');
  const controls = element('div', 'evidence-log-controls');
  const label = element('label', null, '筛选事件');
  const select = element('select');
  for (const [value, name] of logFilters) select.append(Object.assign(element('option', null, name), { value }));
  select.value = records.every(({ group }) => group === 'other') ? 'all' : 'important';
  const count = element('span', 'evidence-note');
  count.setAttribute('role', 'status');
  label.append(select);
  const search = element('input', 'evidence-log-search');
  search.type = 'search';
  search.placeholder = '工具、路径或事件 ID';
  search.setAttribute('aria-label', '搜索证据事件');
  controls.append(label, search, count);
  const list = element('div', 'evidence-log-list');
  const more = element('button', 'button secondary compact', '显示更多事件');
  more.type = 'button';
  let shown = 0;
  let selected = [];

  function nextPage() {
    const next = selected.slice(shown, shown + previewLimit);
    for (const { record, line, title, group } of next) {
      const entry = expandable(`第 ${line} 行 · ${title}`, () => code(JSON.stringify(record, null, 2), 'event.json'));
      entry.classList.add('evidence-log-row');
      entry.dataset.group = group;
      list.append(entry);
    }
    shown += next.length;
    count.textContent = `显示 ${shown} / ${selected.length} 条`;
    more.hidden = shown === selected.length;
  }
  function applyFilter() {
    const filter = select.value;
    const query = search.value.trim().toLowerCase();
    selected = records.filter((record) => (filter === 'all'
      || (filter === 'important' ? record.group !== 'other' : record[filter])) && record.keywords.includes(query));
    shown = 0;
    list.replaceChildren();
    if (!selected.length) list.append(note('此分类没有记录。'));
    nextPage();
  }
  select.addEventListener('change', applyFilter);
  search.addEventListener('input', applyFilter);
  more.addEventListener('click', nextPage);
  applyFilter();
  view.append(metrics([
    ['可读事件', records.length], ['工具事件', tools], ['异常事件', errors, errors ? 'error' : 'neutral'],
  ]), section('事件明细', unreadable ? note(`${unreadable} 行暂时无法解析，见原始内容。`) : null, controls, list, more));
  return view;
}

export function buildEvidencePreview(file, source, context) {
  if (!source.trim() || source.length > maxStructuredLength) return null;
  const filename = file.split('/').at(-1);
  let view;
  if (/\.(?:jsonl|ndjson)$/iu.test(filename)) {
    view = eventLog(source);
  } else if (/^project-command-.+\.log$/iu.test(filename)) {
    view = renderOperationsEvidence(filename, source, ui, context);
  } else if (/\.json$/iu.test(filename)) {
    let data;
    try {
      data = JSON.parse(source);
    } catch {
      return null;
    }
    for (const render of [agentConfiguration, ...renderers]) {
      try {
        view = render(filename, data, ui, context);
        if (view) break;
      } catch {
        // A historical record with an unfamiliar shape can still be browsed as fields.
      }
    }
    view ||= section('记录字段', fieldTree(data));
  }
  if (!view) return null;
  const wrapper = element('div', 'evidence-view');
  wrapper.append(view);
  return wrapper;
}
