const unknown = '未知';
const proofFile = 'skill-proof.json';

const methods = {
  'skill-tool': '原生 Skill 工具',
  'file-read': '读取 Skill 文件',
};

const logFiles = {
  codex: ['codex-agent.jsonl', 'Codex 原生事件'],
  dsh: ['dsh-agent.jsonl', 'DSH 原生事件'],
  opencode: ['opencode-agent.jsonl', 'OpenCode 原生事件'],
};

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasText = (value) => typeof value === 'string' && value.trim().length > 0;
const knownText = (value) => hasText(value) ? value : unknown;

function yesNo(value, yes, no) {
  if (value === true) return ['pass', yes];
  if (value === false) return ['pending', no];
  return ['pending', unknown];
}

function fileState(value) {
  return value === false ? ['fail', '已变化'] : yesNo(value, '一致', '已变化');
}

function activationState(value) {
  if (value === 'observed') return ['pass', '已观察'];
  return ['pending', value === 'not-observed' ? '未观察到' : unknown];
}

function readState(value) {
  if (value === 'verified') return ['pass', '已验证'];
  return ['pending', value === 'not-observed' ? '未观察到' : unknown];
}

function metric(label, [status, text]) {
  return [label, text, status];
}

function codeValue(ui, value) {
  return hasText(value) ? ui.element('code', null, value) : unknown;
}

function knownFacts(ui, facts) {
  const entries = facts.filter(([, value]) => value != null);
  return entries.length ? ui.facts(entries) : null;
}

function nativeLog(context, mode) {
  const engine = context?.run?.mode ?? mode;
  const source = hasText(engine) && Object.hasOwn(logFiles, engine) ? logFiles[engine] : null;
  return source ? context?.artifactLink?.(...source) : null;
}

function callMethod(value) {
  if (!hasText(value)) return unknown;
  return Object.hasOwn(methods, value) ? methods[value] : value;
}

function skillName(data) {
  const event = [data.readEvent, data.activationEvent, ...(Array.isArray(data.calls) ? data.calls : [])]
    .find((entry) => hasText(entry?.name));
  return event?.name ?? data.path.split(/[/\\]/u).at(-2);
}

function eventInfo(event, fallbackId, method, label) {
  const source = isRecord(event) ? event : {};
  const id = [source.callId, source.item?.id, source.evidence, source.itemId, source.partId, fallbackId].find(hasText);
  const line = Number.isSafeInteger(source.line) && source.line > 0 ? source.line : null;
  const exitCode = source.item?.exit_code ?? source.exitCode;
  if (!hasText(id) && !line && !Number.isInteger(exitCode)) return null;
  return {
    labels: [label], id, line, exitCode,
    method: source.method ?? method,
    location: source.path ?? source.directory,
  };
}

function collapseEvents(events) {
  const distinct = [];
  for (const event of events.filter(Boolean)) {
    const same = distinct.find(({ id, line }) => hasText(event.id) ? id === event.id : event.line && line === event.line);
    if (same) same.labels.push(...event.labels.filter((label) => !same.labels.includes(label)));
    else distinct.push(event);
  }
  if (distinct.every(({ line }) => line !== null)) distinct.sort((first, second) => first.line - second.line);
  return distinct;
}

function fixtureEvents(data) {
  if (Array.isArray(data.calls)) {
    return collapseEvents(data.calls.filter(isRecord).map((call) => {
      const labels = call.method === 'skill-tool' ? '激活' : '文件读取';
      return eventInfo(call, null, data.method, call.bodyVerified === true ? `${labels} · 正文验证` : labels);
    }));
  }
  return collapseEvents([
    eventInfo(data.activationEvent, data.activationEventId, data.method, '激活'),
    eventInfo(data.skillFileReadEvent, null, 'file-read', '文件读取'),
    eventInfo(data.readEvent, data.readEventId, data.method, data.read === 'verified' ? '正文验证' : '读取记录'),
    isRecord(data.read) ? eventInfo(data.read, null, 'file-read', '历史读取记录') : null,
  ]);
}

function renderFixture(data, ui, context) {
  const content = ui.element('div', 'evidence-skills');
  const presence = data.skillMode === 'with' ? '有 Skill' : data.skillMode === 'without' ? '无 Skill 对照' : unknown;
  const fileMetric = data.skillMode === 'without' && data.unchanged === true
    ? ['pass', '保持缺席'] : fileState(data.unchanged);
  content.append(ui.section('读取结论', ui.metrics([
    metric('清单发现', ['pending', '未记录']),
    metric('激活', activationState(data.activation)),
    metric('正文验证', readState(data.read)),
    metric('文件完整性', fileMetric),
  ]), ui.note('激活来自匹配 Skill 名称的原生事件。正文验证要求工具返回本轮写入目标文件的专用标记。')));

  content.append(ui.section('Skill 身份', ui.facts([
    ['Skill 名称', codeValue(ui, skillName(data))],
    ['目标文件', codeValue(ui, data.path)],
    ['试验组', presence],
    ['观察方式', callMethod(data.method)],
  ]), knownFacts(ui, [
    ['SHA-256', hasText(data.sha256) ? codeValue(ui, data.sha256) : null],
    ['运行前文件', typeof data.presentBefore === 'boolean' ? data.presentBefore ? '存在' : '缺席' : null],
    ['运行后文件', typeof data.presentAfter === 'boolean' ? data.presentAfter ? '存在' : '缺席' : null],
    ['线程 ID', hasText(data.threadId) ? codeValue(ui, data.threadId) : null],
    ['会话 ID', hasText(data.sessionId) ? codeValue(ui, data.sessionId) : null],
  ])));

  const events = fixtureEvents(data);
  const link = nativeLog(context, data.threadId ? 'codex' : Array.isArray(data.calls) ? 'dsh' : 'opencode');
  const eventView = events.length ? ui.table(['记录', '方式', '事件定位', '文件或目录'], events.map((event) => {
    const location = [
      event.line ? `第 ${event.line} 行` : null,
      event.id,
      Number.isInteger(event.exitCode) ? `退出码 ${event.exitCode}` : null,
    ].filter(Boolean).join(' · ');
    return [event.labels.join(' · '), callMethod(event.method), codeValue(ui, location), codeValue(ui, event.location)];
  }), '同一个原生事件可以同时记录激活与正文验证。') : ui.note('此文件未保留可定位的工具事件。');
  const legacy = data.activation === undefined && typeof data.read !== 'string'
    ? ui.note('历史证据缺少本轮正文标记的核验结果，激活和正文验证均记为未知。') : null;
  content.append(ui.section('原生事件', eventView, legacy, link));
  return content;
}

function tally(skills, key) {
  if (!skills.some((skill) => typeof skill[key] === 'boolean')) return unknown;
  const count = skills.filter((skill) => skill[key] === true).length;
  const missing = skills.filter((skill) => typeof skill[key] !== 'boolean').length;
  return `${count}/${skills.length}${missing ? ` · 未知 ${missing}` : ''}`;
}

function packCalls(skills, ui, mode, native) {
  const entries = skills.flatMap(({ name, calls }) => Array.isArray(calls)
    ? calls.filter(isRecord).map((call) => [name, call]) : []);
  if (!entries.length) return null;
  return ui.details('查看调用记录', ui.table(['Skill', '方式', native ? '正文核验' : '正文标记', '事件 ID'], entries.map(([name, call]) => [
    codeValue(ui, name),
    callMethod(call.method ?? (mode === 'opencode' ? 'skill-tool' : null)),
    ui.badge(...yesNo(call.bodyVerified, '已匹配', '未匹配')),
    codeValue(ui, call.evidence ?? call.callId),
  ]), '同一 Skill 的调用按证据文件中的记录顺序呈现。'));
}

function renderPacks(data, ui, context) {
  const content = ui.element('div', 'evidence-skills');
  const skills = data.packs.flatMap((pack) => pack.skills);
  const native = data.profile === 'testtarget-native' || data.profile === 'native-project';
  const masking = hasText(data.masked) ? ui.facts([
    ['本轮屏蔽的 Skill', codeValue(ui, data.masked)],
    ['原生清单', data.maskedVisible === false ? ui.badge('pass', '已确认缺席')
      : data.maskedVisible === true ? ui.badge('fail', '仍可发现') : ui.badge('pending', '未核验')],
  ]) : null;
  content.append(ui.section('项目 Skill 证据', ui.metrics([
    ['配置', knownText(data.profile)],
    ['Skill 包', data.packs.length],
    ['清单发现', tally(skills, 'discovered')],
    ['工具加载', tally(skills, 'loaded')],
    ['正文验证', tally(skills, 'verified')],
  ]), masking, ui.note(native ? '正文核验将 OpenCode 工具返回与项目里的 Skill 正文比对。'
    : '发现来自原生清单或 Skill 工具证据。加载记录工具是否返回了该 Skill 的内容，正文验证核对返回内容中的本轮专用标记。')));

  for (const pack of data.packs) {
    const details = knownFacts(ui, [
      ['包 ID', hasText(pack.id) ? codeValue(ui, pack.id) : null],
      ['版本', hasText(pack.version) ? codeValue(ui, pack.version) : null],
      ['修订', hasText(pack.revision) ? codeValue(ui, pack.revision) : null],
      ['用途', pack.role === 'workflow' ? '工作流程' : pack.role === 'standard' ? '工程规范' : null],
      ['来源', hasText(pack.source) ? codeValue(ui, pack.source) : null],
    ]);
    const rows = pack.skills.map((skill) => [
      codeValue(ui, skill.name),
      codeValue(ui, skill.path),
      ui.badge(...yesNo(skill.discovered, '已发现', '未发现')),
      ui.badge(...yesNo(skill.loaded, '已加载', '未记录加载')),
      ui.badge(...yesNo(skill.verified, '已验证', '未验证')),
      ui.badge(...fileState(skill.unchanged)),
    ]);
    const table = rows.length ? ui.table(['Skill 名称', '工作区文件', '清单发现', '工具加载', '正文验证', '文件完整性'], rows)
      : ui.note('这个包没有可展示的 Skill 记录。');
    const hashes = pack.skills.filter(({ sha256 }) => hasText(sha256));
    const fingerprints = hashes.length ? ui.details('查看文件摘要', ui.table(['Skill', 'SHA-256'], hashes.map(({ name, sha256 }) => [
      codeValue(ui, name), codeValue(ui, sha256),
    ]))) : null;
    content.append(ui.section(hasText(pack.title) ? pack.title : pack.id, details, table,
      packCalls(pack.skills, ui, context?.run?.mode, native), fingerprints));
  }

  const log = nativeLog(context);
  if (log) content.append(ui.section('关联证据', log));
  return content;
}

export function renderSkillEvidence(file, data, ui, context) {
  if (file !== proofFile || !isRecord(data)) return null;
  if (Object.hasOwn(data, 'packs')) {
    const valid = Array.isArray(data.packs) && data.packs.every((pack) => isRecord(pack)
      && (hasText(pack.title) || hasText(pack.id)) && Array.isArray(pack.skills)
      && pack.skills.every((skill) => isRecord(skill) && hasText(skill.name)));
    return valid ? renderPacks(data, ui, context) : null;
  }
  if (!hasText(data.path) || !['activation', 'read', 'calls', 'unchanged'].some((key) => Object.hasOwn(data, key))) return null;
  return renderFixture(data, ui, context);
}
