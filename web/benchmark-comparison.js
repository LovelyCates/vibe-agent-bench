const skillLabels = { with: '有 Skill', without: '无 Skill' };
const methodLabels = { 'skill-tool': '原生 Skill 工具', 'file-read': '文件读取' };
const skillSignals = {
  observed: ['pass', '已观察'], verified: ['pass', '已验证'],
  'not-observed': ['pending', '未观察到'], unknown: ['pending', '未知'],
};
const lanePlan = [
  { mode: 'codex', name: 'Codex', order: ['with', 'without'] },
  { mode: 'opencode', name: 'OpenCode v1.19.6', order: ['without', 'with'] },
];
const experimentArms = lanePlan.flatMap(({ mode, name, order }) => order.map((skillMode) => ({ mode, name, skillMode })));
const checks = [
  ['code', '代码规范'], ['backend', '后端启动'], ['frontend', '前端启动'],
  ['api', 'API 行为'], ['browser', '页面联调'], ['mutation', '测试辨别力'],
];
const terminalRuns = new Set(['completed', 'error']);
const terminalChecks = new Set(['pass', 'fail', 'blocked', 'error']);
const activeRuns = new Set(['queued', 'running']);

export function experimentRun(members) {
  return members.find(({ status }) => status === 'running')
    ?? members.find(({ mode, skillMode }) => mode === 'codex' && skillMode === 'with')
    ?? members[0];
}

export function experimentStatus(members) {
  if (members.some(({ status }) => status === 'running')) return 'running';
  if (members.some(({ status }) => status === 'queued')) return 'queued';
  const missingArm = experimentArms.some(({ mode, skillMode }) =>
    !members.some((member) => member.mode === mode && member.skillMode === skillMode));
  return missingArm || members.some(({ status }) => status === 'error') ? 'error' : 'completed';
}

function armState(run, experimentState) {
  if (run) return [run.status];
  return activeRuns.has(experimentState) ? ['pending', '待记录'] : ['error', '缺少记录'];
}

export function createBenchmarkComparison({ element, badge, formatTime, runLabel, runHref, onSelect }) {
  const section = document.getElementById('comparison');
  const meta = document.getElementById('comparison-meta');
  const statusContainer = document.getElementById('comparison-status');
  const lanesContainer = document.getElementById('comparison-lanes');
  const table = document.getElementById('comparison-table');
  const lanes = lanePlan.map(createLane);
  lanesContainer.replaceChildren(...lanes.map(({ node }) => node));
  let previous;

  function createLane({ mode, name, order }) {
    const node = element('section', 'comparison-lane');
    node.dataset.mode = mode;
    const title = element('h4', null, name);
    title.id = `comparison-lane-${mode}`;
    node.setAttribute('aria-labelledby', title.id);
    const summary = element('span', 'comparison-lane-summary');
    const heading = element('div', 'comparison-lane-heading');
    heading.append(title, summary);
    const list = element('ol', 'comparison-lane-steps');
    list.setAttribute('role', 'list');
    const steps = order.map((skillMode) => {
      const item = element('li', 'comparison-step');
      const target = element('div', 'comparison-step-name');
      const status = badge('pending');
      const line = element('div', 'comparison-step-heading');
      line.append(target, status);
      const progress = element('progress', 'comparison-step-progress');
      progress.setAttribute('aria-label', `${name} ${skillLabels[skillMode]}检查进度`);
      const count = element('span', 'comparison-step-caption');
      item.append(line, progress, count);
      list.append(item);
      return { skillMode, item, target, status, progress, count };
    });
    node.append(heading, list);
    return { mode, node, summary, steps };
  }

  function reportLink(run, selected, className = 'button secondary compact', label = '查看报告') {
    const link = element('a', className, label);
    link.href = runHref(run);
    link.dataset.runId = run.id;
    link.setAttribute('aria-label', `查看 ${runLabel(run)} 报告`);
    if (selected) link.setAttribute('aria-current', 'true');
    link.addEventListener('click', (event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      onSelect(run);
    });
    return link;
  }

  function renderLanes(arms, status, selectedId) {
    for (const lane of lanes) {
      let finished = 0;
      for (const step of lane.steps) {
        const run = arms.get(`${lane.mode}-${step.skillMode}`);
        const [state, label] = armState(run, status);
        const selected = Boolean(run && run.id === selectedId);
        const total = run?.checks.length ?? 0;
        const checked = run?.checks.filter(({ status }) => terminalChecks.has(status)).length ?? 0;
        if (terminalRuns.has(run?.status)) finished++;
        step.item.dataset.state = state;
        step.item.toggleAttribute('data-selected', selected);
        if (!step.target.firstElementChild || step.target.firstElementChild.dataset.runId !== run?.id) {
          const title = skillLabels[step.skillMode];
          step.target.replaceChildren(run ? reportLink(run, selected, 'comparison-step-link', title) : element('span', null, title));
        }
        const link = step.target.querySelector('a');
        if (selected) link?.setAttribute('aria-current', 'true');
        else link?.removeAttribute('aria-current');
        if (step.status.dataset.state !== state || (label && step.status.textContent !== label)) {
          const next = badge(state, label);
          step.status.replaceWith(next);
          step.status = next;
        }
        step.progress.hidden = total === 0;
        step.progress.max = total || 1;
        step.progress.value = checked;
        step.count.hidden = !run;
        if (run) step.count.textContent = `已检查 ${checked} / ${total} 项`;
      }
      lane.summary.textContent = `${finished} / ${lane.steps.length} 组已结束`;
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
    const signal = evidence?.[kind];
    const cell = tableCell(badge(...(skillSignals[signal] ?? skillSignals.unknown)));
    const method = methodLabels[evidence?.method];
    if (method && (signal === 'observed' || signal === 'verified')) {
      cell.append(element('span', 'muted-caption', method));
    }
    return cell;
  }

  function renderTable(arms, status, selectedId) {
    const focused = table.contains(document.activeElement) ? document.activeElement.dataset.runId : undefined;
    const head = element('thead');
    const headers = element('tr');
    const captions = ['评测组', '运行', '激活证据', '读取证据', ...checks.map(([, title]) => title), '详情'];
    headers.append(...captions.map((caption) => tableHeading(caption, 'col')));
    head.append(headers);

    const body = element('tbody');
    for (const { mode, name, skillMode } of experimentArms) {
      const arm = `${mode}-${skillMode}`;
      const run = arms.get(arm);
      const selected = Boolean(run && run.id === selectedId);
      const row = element('tr');
      row.dataset.arm = arm;
      row.toggleAttribute('data-selected', selected);
      const group = tableHeading(name, 'row');
      group.append(element('span', 'muted-caption', skillLabels[skillMode]));
      row.append(group, tableCell(badge(...armState(run, status))));
      row.append(evidenceCell(run?.skillEvidence, 'activation'), evidenceCell(run?.skillEvidence, 'read'));
      const outcomes = new Map(run?.checks.map(({ id, status }) => [id, status]));
      for (const [id] of checks) row.append(tableCell(badge(outcomes.get(id) ?? 'pending')));
      row.append(tableCell(run ? reportLink(run, selected) : '—'));
      body.append(row);
    }
    table.replaceChildren(head, body);
    if (focused) [...table.querySelectorAll('a')].find(({ dataset }) => dataset.runId === focused)?.focus({ preventScroll: true });
  }

  return function render(members, selectedId) {
    section.hidden = !members.length;
    if (!members.length) {
      previous = undefined;
      return;
    }
    const signature = JSON.stringify([selectedId, members.map(({ id, status, skillEvidence, checks }) =>
      [id, status, skillEvidence, checks.map(({ id, status }) => [id, status])])]);
    if (signature === previous) return;
    previous = signature;

    const arms = new Map(members.map((member) => [`${member.mode}-${member.skillMode}`, member]));
    const finished = experimentArms.filter(({ mode, skillMode }) => terminalRuns.has(arms.get(`${mode}-${skillMode}`)?.status)).length;
    const status = experimentStatus(members);
    meta.textContent = `${formatTime(members.at(-1).createdAt)} · 已结束 ${finished} / ${experimentArms.length} 组`;
    if (statusContainer.firstElementChild?.dataset.state !== status) statusContainer.replaceChildren(badge(status));
    renderLanes(arms, status, selectedId);
    renderTable(arms, status, selectedId);
  };
}
