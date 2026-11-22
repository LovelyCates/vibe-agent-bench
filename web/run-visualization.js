import { checkRunPhase, createRunTiming } from './run-timing.js';

const stages = [
  ['queue', '排队'], ['prepare', '准备项目'], ['implement', 'Agent 执行'], ['verify', '检查'], ['review', 'AI 建议'],
];
const eventPhases = { run: 'queue', workspace: 'prepare', setup: 'prepare', agent: 'implement', verify: 'verify', advice: 'review' };
const stageNames = new Map(stages);
const activeStatuses = new Set(['queued', 'preparing', 'running']);
const resultLabels = {
  pending: '待开始', running: '进行中', pass: '已完成', error: '未通过',
  blocked: '没能执行', skipped: '已跳过', unrecorded: '未记录',
};
const clockFormat = new Intl.DateTimeFormat('zh-CN', { hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' });

export function runEventPhase(event) {
  return Object.hasOwn(eventPhases, event.phase) ? eventPhases[event.phase] : undefined;
}

export function isRunTerminalEvent({ kind, phase, status }) {
  return kind === 'run' && phase === 'run' && (status === 'completed' || status === 'error');
}

export function displayRunStepStatus(run, step, status) {
  if (run.mode === 'demo' && status === 'blocked' && ['agent', 'skill', 'advice'].includes(step)) return 'skipped';
  return status;
}

const failedChecks = new Set(['fail', 'error']);
const blockedChecks = new Set(['blocked', 'interrupted']);
const verdictStates = new Map([
  ['pass', 'pass'], ['passed', 'pass'], ['fail', 'fail'], ['failed', 'fail'], ['blocked', 'blocked'],
  ['error', 'error'], ['inconclusive', 'unknown'], ['unknown', 'unknown'],
]);

function completedOutcome(checks, verdict) {
  if (verdictStates.has(verdict)) return verdictStates.get(verdict);
  if (checks.some(({ status }) => failedChecks.has(status))) return 'fail';
  if (checks.some(({ status }) => blockedChecks.has(status))) return 'blocked';
  if (checks.length && checks.every(({ status }) => status === 'pass')) return 'pass';
  return 'unknown';
}

export function summarizeRunOutcome(run) {
  const checks = (run.checks ?? []).map((check) => ({
    ...check, status: displayRunStepStatus(run, check.id, check.status),
  }));
  const byId = (id) => checks.find((check) => check.id === id);
  if (run.status === 'queued') return { state: 'queued', title: '排队中', text: '轮到这条用例后会自动开始。', checks: [] };
  if (activeStatuses.has(run.status)) {
    const current = checks.find(({ status }) => activeStatuses.has(status));
    return { state: 'running', title: '正在运行', text: current?.title ? `当前在做「${current.title}」。` : '正在等待本轮的进度。', checks: [] };
  }

  const verdict = run.testTarget?.verdict ?? run.nativeCase?.verdict;
  const requiredChecks = run.mode === 'demo' ? checks.filter(({ id, status }) =>
    !(['agent', 'skill'].includes(id) && status === 'skipped')) : checks;
  const state = run.status === 'error' ? 'error' : completedOutcome(requiredChecks, verdict);
  const failed = checks.filter((check) => failedChecks.has(check.status));
  const blocked = checks.filter((check) => blockedChecks.has(check.status));
  const first = (items) => items.filter(Boolean).find((check) => check.summary) ?? items.find(Boolean);
  if (state === 'pass') {
    const title = verdict ? '符合预期' : '验收通过';
    const report = byId('honesty');
    if (report?.status === 'pass' && failedChecks.has(byId('verification')?.status)) {
      return { state, title, text: '外部验收按预期失败，Agent 如实报告了结果。', checks: [report] };
    }
    const completed = checks.filter(({ status }) => status === 'pass');
    const domainCheck = run.nativeCase && completed.find(({ id }) =>
      !['workspace', 'agent', 'skill', 'integrity', 'native-expectation'].includes(id));
    const useful = [byId('approval'), byId('browser'), byId('api'), byId('code'), domainCheck, byId('native-expectation')]
      .filter((check) => check?.status === 'pass');
    const proof = first([...useful, ...completed]);
    return { state, title, text: verdict ? '本轮通过了用例设定的检查。' : `${completed.length} 项检查通过。`, checks: proof ? [proof] : [] };
  }
  if (state === 'fail') {
    // The aggregate check can repeat more specific failures, such as missing Skill evidence.
    const specific = failed.filter(({ id }) => id !== 'native-expectation');
    const problems = (specific.length ? specific : failed).slice(0, 2);
    return { state, title: '未达预期', text: problems.length ? '以下检查未通过。' : '本轮判定为未达预期，可以查看已保存的检查。', checks: problems };
  }
  if (state === 'error' || state === 'blocked') {
    const problem = first([...failed, ...blocked]);
    const title = state === 'error' ? '运行中断' : '检查无法完成';
    return { state, title, text: '本轮没有完成判断所需的检查。', checks: problem ? [problem] : [] };
  }
  return { state, title: '暂时无法判断', text: '已保存的检查结果还不足以判断这条用例是否通过。', checks: [] };
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

export function createRunOutcome(container, { onCheckSelect } = {}) {
  container.classList.add('run-outcome');
  container.setAttribute('aria-labelledby', `${container.id}-title`);
  const title = element('h3', 'run-outcome-title');
  title.id = `${container.id}-title`;
  const text = element('p', 'run-outcome-text');
  const proof = element('ul', 'run-outcome-proof');
  container.append(title, text, proof);
  let signature;

  function update(run) {
    container.hidden = !run;
    if (!run) return;
    const result = summarizeRunOutcome(run);
    const nextSignature = JSON.stringify([run.id, result.state, result.title, result.text,
      result.checks.map(({ id, title: name, summary }) => [id, name, summary])]);
    if (nextSignature === signature) return;
    signature = nextSignature;
    container.dataset.state = result.state;
    setText(title, result.title);
    setText(text, result.text);
    proof.hidden = !result.checks.length;
    proof.replaceChildren(...result.checks.map(({ id, title: name, summary }) => {
      const item = element('li');
      const description = element('div');
      description.append(element('strong', null, name), element('p', null, summary));
      item.append(description);
      if (onCheckSelect) {
        const detail = element('button', 'button secondary compact', '看检查依据');
        detail.type = 'button';
        detail.setAttribute('aria-label', `看检查依据，${name}`);
        detail.addEventListener('click', () => onCheckSelect(id));
        item.append(detail);
      }
      return item;
    }));
  }

  return { update };
}

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

function checkState(status) {
  if (status === 'pass') return 'pass';
  if (status === 'error' || status === 'fail') return 'error';
  if (status === 'blocked' || status === 'interrupted') return 'blocked';
  if (status === 'skipped') return 'skipped';
  if (activeStatuses.has(status)) return 'running';
  return 'pending';
}

function summarize(states) {
  if (!states.length) return 'unrecorded';
  if (states.includes('running')) return 'running';
  if (states.includes('pending')) return 'pending';
  if (states.includes('error')) return 'error';
  if (states.includes('blocked')) return 'blocked';
  if (states.includes('pass')) return 'pass';
  return 'skipped';
}

function stageStates(run, phasesByCheck) {
  const checks = run.checks ?? [];
  const agentIndex = checks.findIndex(({ id }) => id === 'agent');
  const grouped = { prepare: [], implement: [], verify: [] };
  const progress = checks.map(({ id, status }, index) => {
    const phase = checkRunPhase(id, index, agentIndex, phasesByCheck);
    const state = checkState(displayRunStepStatus(run, id, status));
    grouped[phase].push(state);
    return state;
  });
  return {
    progress,
    states: new Map([
      ['queue', run.status === 'queued' ? 'running' : run.startedAt || run.status === 'completed' ? 'pass'
        : run.status === 'error' ? 'error' : 'running'],
      ...Object.entries(grouped).map(([phase, states]) => [phase, summarize(states)]),
      ['review', run.advice ? checkState(displayRunStepStatus(run, 'advice', run.advice.status)) : 'unrecorded'],
    ]),
  };
}

function elapsedTime(run, now) {
  const active = activeStatuses.has(run.status);
  const start = Date.parse(run.startedAt || (run.status === 'queued' ? run.createdAt : ''));
  const end = active ? now : Date.parse(run.finishedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '—';
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const pad = (value) => String(value).padStart(2, '0');
  return hours ? `${hours}:${pad(minutes % 60)}:${pad(seconds % 60)}` : `${pad(minutes)}:${pad(seconds % 60)}`;
}

const fractionalSeconds = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 });

function durationLabel(ms) {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${fractionalSeconds.format(ms / 1000)} s`;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ${Math.floor(ms / 1000) % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function setStyle(node, property, value) {
  if (node.style.getPropertyValue(property) !== value) node.style.setProperty(property, value);
}

export function createRunVisualization(container, { onPhaseSelect } = {}) {
  container.classList.add('run-visualization');
  container.hidden = true;
  container.setAttribute('role', 'region');
  container.setAttribute('aria-label', '运行流程');
  const title = element('h3', 'run-viz-title', '运行流程');
  const signal = element('span', 'run-viz-signal');
  const elapsed = element('span', 'run-viz-elapsed');
  elapsed.setAttribute('role', 'timer');
  const facts = element('div', 'run-viz-facts');
  facts.append(signal, elapsed);
  const header = element('div', 'run-viz-header');
  header.append(title, facts);

  const trace = element('div', 'run-viz-trace');
  trace.setAttribute('role', 'group');
  const scale = element('div', 'run-viz-scale');
  const scaleTitle = element('span', 'run-viz-scale-title', '阶段');
  const tickList = element('div', 'run-viz-ticks');
  tickList.setAttribute('aria-hidden', 'true');
  const ticks = Array.from({ length: 5 }, () => element('span'));
  tickList.append(...ticks);
  scale.append(scaleTitle, tickList, element('span', 'run-viz-scale-unit', '耗时'));
  const rail = element('ol', 'run-viz-rail');
  rail.setAttribute('role', 'list');
  rail.setAttribute('aria-label', '执行阶段');
  const stageNodes = new Map(stages.map(([phase, name]) => {
    const item = element('li', 'run-viz-stage');
    item.dataset.phase = phase;
    const control = element(onPhaseSelect ? 'button' : 'div', 'run-viz-step');
    if (onPhaseSelect) {
      control.type = 'button';
      control.title = `查看${name}事件`;
      control.setAttribute('aria-controls', 'events');
      control.addEventListener('click', () => onPhaseSelect(phase));
    }
    const mark = element('span', 'run-viz-marker');
    mark.setAttribute('aria-hidden', 'true');
    const caption = element('span', 'run-viz-stage-state');
    const label = element('span', 'run-viz-stage-label');
    label.append(mark, element('strong', null, name), caption);
    const track = element('span', 'run-viz-track');
    const span = element('span', 'run-viz-span');
    span.hidden = true;
    track.setAttribute('aria-hidden', 'true');
    track.append(span);
    const duration = element('span', 'run-viz-duration', '—');
    control.append(label, track, duration);
    item.append(control);
    rail.append(item);
    return [phase, { item, control, caption, duration, span }];
  }));
  trace.append(scale, rail);

  const activity = element('div', 'run-viz-activity');
  const context = element('span', 'run-viz-activity-context');
  const copy = element('p', 'run-viz-activity-copy');
  const time = element('time', 'run-viz-activity-time');
  activity.append(context, copy, time);

  const footer = element('div', 'run-viz-footer');
  const count = element('strong', 'run-viz-count');
  const results = element('ul', 'run-viz-results');
  const metrics = element('div', 'run-viz-metrics');
  metrics.append(element('span', null, '检查进度'), count);
  const progress = element('div', 'run-viz-progress');
  progress.setAttribute('role', 'progressbar');
  progress.setAttribute('aria-label', '检查进度');
  progress.setAttribute('aria-valuemin', '0');
  footer.append(metrics, progress, results);
  const highlights = element('div', 'run-viz-highlights');
  highlights.append(activity, footer);
  const body = element('div', 'run-viz-body');
  body.append(trace, highlights);
  container.append(header, body);

  let currentRun, timer, latest, deferredTerminal, lastSeq, progressKey, measuredAt;
  const recordedPhases = new Set();
  const phasesByCheck = new Map();
  const timing = createRunTiming();

  function updateClock(now = Date.now()) {
    if (!currentRun) return;
    measuredAt = now;
    const value = elapsedTime(currentRun, now);
    const label = currentRun.status === 'queued' ? '排队' : '运行';
    const description = value === '—' ? `${label}耗时未记录` : `${label}耗时 ${value}`;
    setText(elapsed, value === '—' ? '耗时未记录' : value);
    elapsed.dataset.label = label;
    if (elapsed.getAttribute('aria-label') !== description) elapsed.setAttribute('aria-label', description);
    const measurement = timing.measure(currentRun, phasesByCheck, now);
    const observedEnds = [...measurement.phases.values()].map(({ offsetMs, durationMs }) => offsetMs + (durationMs ?? 0));
    const length = Math.max(measurement.durationMs ?? 0, ...observedEnds);
    const axisOrigin = Number.isFinite(Date.parse(currentRun.createdAt)) ? '入队' : '最早记录';
    const axisDescription = `阶段耗时自${axisOrigin}起计`;
    if (tickList.title !== axisDescription) {
      tickList.title = axisDescription;
      trace.setAttribute('aria-label', axisDescription);
    }
    tickList.hidden = length <= 0;
    for (const [index, tick] of ticks.entries()) {
      setText(tick, index === 0 ? '0' : durationLabel(index / (ticks.length - 1) * length));
    }
    for (const [phase, { span, duration }] of stageNodes) {
      const measured = measurement.phases.get(phase);
      const lengthMs = measured?.durationMs;
      span.hidden = !measured;
      setText(duration, lengthMs == null ? '—' : `${measured.partial ? '≥ ' : ''}${durationLabel(lengthMs)}`);
      duration.title = measured ? [
        `起点 +${durationLabel(measured.offsetMs)}`,
        lengthMs == null ? '阶段耗时未记录' : measured.partial && '截至最后一条活动记录',
      ].filter(Boolean).join(' · ') : '阶段耗时未记录';
      if (!measured) continue;
      setStyle(span, '--span-start', `${length > 0 ? measured.offsetMs / length * 100 : 0}%`);
      setStyle(span, '--span-width', `${length > 0 ? (lengthMs ?? 0) / length * 100 : 0}%`);
      span.dataset.kind = lengthMs > 0 ? 'span' : 'point';
      span.toggleAttribute('data-live', measured.live);
      span.toggleAttribute('data-partial', measured.partial);
    }
  }

  function updateProgress(states) {
    const key = states.join(',');
    if (key === progressKey) return;
    progressKey = key;
    const counts = { pass: 0, error: 0, blocked: 0, skipped: 0 };
    for (const state of states) if (Object.hasOwn(counts, state)) counts[state]++;
    const done = Object.values(counts).reduce((total, value) => total + value, 0);
    footer.hidden = states.length === 0;
    count.textContent = `${done} / ${states.length}`;
    const outcomes = [['pass', '通过'], ['error', '未通过'], ['blocked', '阻塞'], ['skipped', '跳过']];
    results.replaceChildren(...outcomes.filter(([state]) => counts[state] > 0).map(([state, label]) => {
      const item = element('li', null, `${label} ${counts[state]}`);
      item.dataset.state = state;
      return item;
    }));
    progress.setAttribute('aria-valuemax', String(states.length || 1));
    progress.setAttribute('aria-valuenow', String(done));
    progress.setAttribute('aria-valuetext', [
      `${done} / ${states.length} 项检查已结束`,
      ...outcomes.filter(([state]) => counts[state]).map(([state, label]) => `${label} ${counts[state]} 项`),
    ].join('，'));
    progress.replaceChildren(...states.map((state) => {
      const segment = element('span');
      segment.dataset.state = state;
      segment.setAttribute('aria-hidden', 'true');
      return segment;
    }));
  }

  function update(run, entries = [], { disconnected = false } = {}) {
    const changedRun = currentRun?.id !== run?.id;
    if (!run || changedRun) {
      latest = null;
      deferredTerminal = null;
      lastSeq = 0;
      measuredAt = undefined;
      recordedPhases.clear();
      phasesByCheck.clear();
      timing.reset();
    }
    currentRun = run;
    container.hidden = !run;
    const active = Boolean(run && activeStatuses.has(run.status));
    const ticking = active && !disconnected;
    if (!ticking && timer) {
      clearInterval(timer);
      timer = undefined;
    }
    if (!run) return;
    if (ticking && !timer) timer = setInterval(updateClock, 1000);
    const sync = disconnected ? 'offline' : active ? 'live' : run.status === 'error' ? 'error' : 'idle';
    container.dataset.sync = sync;
    setText(signal, { offline: '更新暂缓', live: '实时更新', error: '运行异常', idle: '已结束' }[sync]);
    for (const entry of entries) {
      if (!Number.isSafeInteger(entry.seq) || entry.seq <= lastSeq) continue;
      lastSeq = entry.seq;
      const phase = runEventPhase(entry);
      timing.record(entry, phase);
      if (phase) recordedPhases.add(phase);
      if (entry.checkId && ['prepare', 'implement', 'verify'].includes(phase)) phasesByCheck.set(entry.checkId, phase);
      if (!entry.summary) continue;
      // The run snapshot and its terminal event arrive through separate requests.
      if (active && isRunTerminalEvent(entry)) deferredTerminal = entry;
      else latest = entry;
    }
    updateClock(disconnected && measuredAt !== undefined ? measuredAt : Date.now());
    if (!active && deferredTerminal) {
      if (!latest || deferredTerminal.seq > latest.seq) latest = deferredTerminal;
      deferredTerminal = null;
    }

    const { progress: checks, states } = stageStates(run, phasesByCheck);
    const activeStage = active && [...states].findLast(([, state]) => state === 'running')?.[0];
    for (const [phase, { item, control, caption }] of stageNodes) {
      const state = states.get(phase);
      item.dataset.state = state;
      if (phase === activeStage) item.setAttribute('aria-current', 'step');
      else item.removeAttribute('aria-current');
      setText(caption, phase === 'queue' && run.status === 'queued' ? '排队中' : resultLabels[state]);
      if (onPhaseSelect) control.disabled = !recordedPhases.has(phase);
    }

    const phaseName = latest && stageNames.get(runEventPhase(latest));
    const terminalEvent = latest && isRunTerminalEvent(latest);
    setText(context, terminalEvent ? '结束记录' : phaseName ? `最新 · ${phaseName}` : '执行动态');
    setText(copy, latest?.summary || (active ? '等待执行事件…' : '时间线暂无记录。已保存的检查和证据仍可查看。'));
    const at = Date.parse(latest?.at);
    time.hidden = !Number.isFinite(at);
    if (!time.hidden) {
      time.dateTime = latest.at;
      setText(time, clockFormat.format(at));
    }
    updateProgress(checks);
  }

  return { update };
}
