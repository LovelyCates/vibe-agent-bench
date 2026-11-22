const statusLabels = {
  pass: '通过', fail: '失败', error: '异常', blocked: '阻塞',
  running: '进行中', pending: '未记录', skipped: '已跳过', completed: '已完成',
};

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isTextList(value) {
  return Array.isArray(value) && value.every(isText);
}

function facts(ui, rows) {
  return ui.facts(rows.filter(([, value]) =>
    isText(value) || Number.isFinite(value) || typeof value === 'boolean'));
}

function links(ui, context, targets) {
  const nodes = targets.map(([file, label]) => context?.artifactLink?.(file, label)).filter(Boolean);
  if (!nodes.length) return [];
  const group = ui.element('div', 'artifact-links');
  group.append(...nodes);
  return [group];
}

function list(ui, items, ordered = false) {
  const node = ui.element(ordered ? 'ol' : 'ul');
  for (const item of items) node.append(ui.element('li', '', item));
  return node;
}

function statusBadge(ui, status) {
  return isText(status) && Object.hasOwn(statusLabels, status)
    ? ui.badge(status, statusLabels[status])
    : ui.badge('neutral', isText(status) ? status : '未记录');
}

function isDiagnostic(value) {
  return isRecord(value) && isText(value.filePath) && Array.isArray(value.messages)
    && value.messages.every((message) => isRecord(message) && isText(message.message));
}

function lintFile(ui, path) {
  const relative = /[\\/]candidate[\\/](.+)$/u.exec(path)?.[1];
  const label = ui.element('code', '', relative ? relative.replaceAll('\\', '/') : path);
  if (relative) label.title = path;
  return label;
}

function lintEvidence(data, ui) {
  const eslintOnly = Array.isArray(data);
  const integrity = eslintOnly ? undefined : data?.integrity;
  const diagnostics = eslintOnly ? data : data?.diagnostics;
  const error = !eslintOnly && isText(data?.error) ? data.error : null;
  if (integrity !== undefined && (!Array.isArray(integrity)
    || !integrity.every((entry) => isRecord(entry) && isText(entry.file) && typeof entry.unchanged === 'boolean'))) return null;
  if (diagnostics !== undefined && (!Array.isArray(diagnostics) || !diagnostics.every(isDiagnostic))) return null;
  if (integrity === undefined && diagnostics === undefined && !error) return null;

  const issues = diagnostics?.flatMap(({ filePath, messages }) => messages.map((message) => ({ filePath, ...message })));
  const altered = integrity?.filter(({ unchanged }) => !unchanged).length;
  const totals = [];
  if (integrity) {
    totals.push(['受保护文件', integrity.length], ['发生改动', altered, altered ? 'fail' : 'neutral']);
  }
  if (diagnostics) {
    totals.push(['已检查源码', diagnostics.length], ['ESLint 问题', issues.length, issues.length ? 'fail' : 'neutral']);
  }
  const children = [];
  if (error) children.push(ui.badge('error', '检查出错'), ui.note(error));
  if (totals.length) children.push(ui.metrics(totals));
  if (integrity?.length) {
    children.push(ui.element('h4', '', '文件完整性'), ui.table(['文件', '比对结果'], integrity.map(({ file, unchanged }) => [
      ui.element('code', '', file),
      ui.badge(unchanged ? 'pass' : 'fail', unchanged ? '一致' : '有变动'),
    ]), '受保护文件比对结果'));
  }
  if (issues?.length) {
    children.push(ui.element('h4', '', 'ESLint 诊断'), ui.table(
      ['文件', '位置', '级别', '规则', '消息'],
      issues.map(({ filePath, line, column, ruleId, severity, fatal, message }) => [
        lintFile(ui, filePath),
        Number.isInteger(line) ? [line, Number.isInteger(column) ? column : null].filter((part) => part !== null).join(':') : '—',
        fatal === true || severity === 2 ? ui.badge('error', '错误')
          : severity === 1 ? ui.badge('neutral', '警告') : '—',
        isText(ruleId) ? ruleId : '—',
        message,
      ]),
      'ESLint 诊断明细',
    ));
  }
  if (diagnostics?.length) {
    children.push(ui.details('全部已检查源码（' + diagnostics.length + '）',
      ui.table(['文件', '问题数'], diagnostics.map(({ filePath, messages }) => [lintFile(ui, filePath), messages.length]),
        '源码文件检查记录')));
  }
  return ui.section('代码规范与文件完整性', ...children);
}

function serviceEvidence(file, data, ui) {
  if (!isRecord(data) || !['stdout', 'stderr', 'result', 'readiness', 'error'].some((key) => Object.hasOwn(data, key))) return null;
  const readiness = isRecord(data.readiness) ? data.readiness : null;
  const health = isRecord(readiness?.health) ? readiness.health : null;
  const body = isRecord(health?.body) ? health.body : null;
  const result = isRecord(data.result) ? data.result : null;
  const children = [];
  const totals = [];
  if (Number.isInteger(health?.status)) {
    totals.push(['健康接口', 'HTTP ' + health.status, health.status === 200 ? 'neutral' : 'fail']);
  }
  if (typeof body?.ready === 'boolean') {
    totals.push(['就绪状态', body.ready ? '已就绪' : '未就绪', body.ready ? 'pass' : 'fail']);
  }
  if (isText(data.error)) children.push(ui.badge('error', '启动异常'), ui.note(data.error));
  if (totals.length) children.push(ui.metrics(totals));
  if (isText(readiness?.url) || isText(health?.contentType) || isText(body?.service)) {
    children.push(facts(ui, [
      ['服务地址', readiness?.url], ['服务名称', body?.service], ['响应类型', health?.contentType],
    ]));
  }
  if (health && Object.hasOwn(health, 'body')) {
    const bodyText = typeof health.body === 'string' ? health.body : JSON.stringify(health.body, null, 2);
    if (bodyText) children.push(ui.details('健康接口响应体', ui.code(bodyText, typeof health.body === 'string' ? 'health.txt' : 'health.json')));
  }
  const processDetails = [];
  if (result) {
    processDetails.push(ui.facts([
      ['退出码', Number.isInteger(result.code) ? result.code : '—'],
      ['终止信号', isText(result.signal) ? result.signal : '—'],
    ]));
    if (isText(result.error)) processDetails.push(ui.note(result.error));
  }
  if (isText(data.stderr)) processDetails.push(ui.element('h4', '', '标准错误'), ui.code(data.stderr, 'stderr.log'));
  if (isText(data.stdout)) processDetails.push(ui.element('h4', '', '标准输出'), ui.code(data.stdout, 'stdout.log'));
  if (processDetails.length) children.push(ui.details('进程退出与输出', ...processDetails));
  if (!children.length) return null;
  const service = file.includes('backend') ? '后端' : '前端';
  const scene = file.startsWith('browser-empty-') ? ' · 空结果场景' : '';
  return ui.section(service + '启动与健康检查' + scene, ...children);
}

function phaseLabel(phase) {
  if (phase === 'setup') return '准备';
  if (phase === 'verify') return '验收';
  return isText(phase) ? phase : '—';
}

function milliseconds(value) {
  return Number.isFinite(value) && value >= 0 ? value.toLocaleString('zh-CN') + ' 毫秒' : undefined;
}

function commandText(command) {
  if (!isText(command?.program)) return undefined;
  const args = Array.isArray(command.args) ? command.args : [];
  if (!args.every((arg) => typeof arg === 'string')) return undefined;
  return [command.program, ...args.map((arg) => /^[\w./:=@-]+$/u.test(arg) ? arg : JSON.stringify(arg))].join(' ');
}

function renderCommand(ui, context, record) {
  const children = [];
  if (isText(record.status)) children.push(statusBadge(ui, record.status));
  if (isText(record.summary)) children.push(ui.note(record.summary));
  if (isText(record.command)) children.push(ui.code(record.command, 'command.txt'));
  const rows = [
    ['阶段', record.phase && phaseLabel(record.phase)],
    ['耗时', milliseconds(record.durationMs)],
    ['超时上限', milliseconds(record.timeoutMs)],
    ['是否超时', record.timedOut],
    ['退出码', record.exitCode],
    ['终止信号', record.signal],
  ];
  if (rows.some(([, value]) => isText(value) || Number.isFinite(value) || typeof value === 'boolean')) children.push(facts(ui, rows));
  if (isText(record.error) && record.error !== record.summary) children.push(ui.note(record.error));
  if (isText(record.stderr)) children.push(ui.element('h4', '', '标准错误'), ui.code(record.stderr, 'stderr.log'));
  if (isText(record.stdout)) children.push(ui.element('h4', '', '标准输出'), ui.code(record.stdout, 'stdout.log'));
  if (isText(record.output)) children.push(ui.element('h4', '', '命令输出'), ui.code(record.output, 'output.log'));
  children.push(...links(ui, context, [['case-input.json', '项目输入与命令清单']]));
  return ui.section('项目命令记录', ...children);
}

function commandLog(data, ui, context) {
  if (typeof data !== 'string') return null;
  const match = /^\$ ([^\r\n]+)\r?\n([\s\S]*?)\r?\n([^\r\n]+) 用时 (\d+) 毫秒。\s*$/u.exec(data);
  if (!match) return null;
  const [, command, output, summary, duration] = match;
  const status = summary === '命令成功完成。' ? 'pass'
    : /^命令退出码为 /u.test(summary) ? 'fail'
      : /^(?:命令超时|命令提前终止|无法执行)/u.test(summary) ? 'error' : undefined;
  const exitCode = /^命令退出码为 (-?\d+)。$/u.exec(summary)?.[1];
  return renderCommand(ui, context, {
    command, output, summary, durationMs: Number(duration), status,
    exitCode: exitCode === undefined ? undefined : Number(exitCode),
  });
}

function commandResult(data, ui, context) {
  if (!isRecord(data)) return null;
  const config = isRecord(data.command) ? data.command : data;
  const result = isRecord(data.result) ? data.result : data;
  const command = isText(data.command) ? data.command : commandText(config);
  const exitCode = Number.isInteger(result.exitCode) ? result.exitCode : result.code;
  const error = isText(result.error) ? result.error : result.error?.message ?? result.spawnError?.message;
  const status = data.status ?? result.status;
  if (!command && !isText(status) && !Number.isInteger(exitCode)
    && !isText(error) && ![result.stdout, result.stderr, result.output].some(isText)) return null;
  return renderCommand(ui, context, {
    command, exitCode, error, status, phase: config.phase, timeoutMs: config.timeoutMs,
    summary: data.summary, durationMs: data.durationMs ?? result.durationMs,
    timedOut: result.timedOut, signal: result.signal, stdout: result.stdout, stderr: result.stderr, output: result.output,
  });
}

function commandTable(commands, ui, context) {
  return ui.table(['检查项', '阶段', '命令', '超时上限', '记录'], commands.map((command) => {
    const log = isText(command.id) && /^[a-z0-9][a-z0-9_-]{0,63}$/u.test(command.id)
      ? context?.artifactLink?.('project-command-' + command.id + '.log', '查看日志') : null;
    return [
      isText(command.label) ? command.label : command.id,
      phaseLabel(command.phase),
      ui.element('code', '', commandText(command)),
      milliseconds(command.timeoutMs) ?? '—',
      log ?? '—',
    ];
  }), '项目命令清单');
}

function inputMetadata(file, data, ui, context) {
  if (!isRecord(data)) return null;
  if (file === 'trial-config.json') {
    if (!isText(data.baselineSha256) && !isText(data.promptSha256) && !isText(data.experimentId)) return null;
    const skillMode = data.skillMode === 'with' ? '使用 Skill' : data.skillMode === 'without' ? '无 Skill' : data.skillMode;
    const skillAtStart = typeof data.skillPresentAtStart === 'boolean' ? (data.skillPresentAtStart ? '存在' : '缺席') : undefined;
    return ui.section('对照条件与输入摘要', facts(ui, [
      ['实验 ID', data.experimentId], ['Agent', data.agent], ['Skill 条件', skillMode], ['起始 Skill 文件', skillAtStart],
      ['基线 SHA-256', data.baselineSha256], ['提示词 SHA-256', data.promptSha256],
    ]), ...links(ui, context, [['task-prompt.txt', '原始任务提示词']]));
  }

  const commands = Array.isArray(data.commands) && data.commands.every((command) => commandText(command)
    && (isText(command.label) || isText(command.id))) ? data.commands : null;
  const files = isTextList(data.files) ? data.files : null;
  const project = file === 'case-input.json';
  if (project ? !isText(data.caseId) && !files && !commands : !commands) return null;
  const children = [];
  if (project) {
    children.push(facts(ui, [
      ['项目用例', data.title], ['用例 ID', data.caseId], ['版本', data.version], ['Agent', data.agent],
      ['评测配置', data.profile], ['场景', data.scenario], ['Skill 组合', data.skillProfile],
      ['项目目录', data.projectDir], ['基线 SHA-256', data.baselineSha256],
    ]));
  }
  if (isText(data.requirement)) children.push(ui.element('h4', '', '任务要求'), ui.note(data.requirement));
  if (commands) {
    children.push(ui.element('h4', '', '项目命令'));
    children.push(commands.length ? commandTable(commands, ui, context) : ui.note('命令清单为空。'));
  }
  if (Array.isArray(data.skillLocks) && data.skillLocks.length && data.skillLocks.every((item) => isRecord(item) && isText(item.id))) {
    children.push(ui.details('锁定的 Skill 版本', ui.table(['Skill', '版本', '修订'], data.skillLocks.map(({ id, version, revision }) =>
      [id, isText(version) ? version : '—', isText(revision) ? revision : '—']), 'Skill 版本记录')));
  }
  if (Array.isArray(data.fixtures) && data.fixtures.length && data.fixtures.every((item) => isRecord(item) && isText(item.path) && isText(item.sha256))) {
    children.push(ui.details('本轮复制到隔离工作区的测试资料', ui.table(['文件', 'SHA-256'],
      data.fixtures.map(({ path, sha256 }) => [path, sha256]))));
  }
  if (files) children.push(ui.details('起始文件（' + files.length + '）', list(ui, files)));
  children.push(...links(ui, context, [['task-prompt.txt', '送给 Agent 的任务'], ['verification-assets.json', '验收资产校验']]));
  return ui.section(project ? '项目输入与命令清单' : '验收命令配置', ...children);
}

function verificationAssets(data, ui, context) {
  if (!isRecord(data) || !isTextList(data.altered)) return null;
  const { altered } = data;
  return ui.section('验收资产校验',
    ui.metrics([['发生改动的验收资产', altered.length, altered.length ? 'fail' : 'pass']]),
    altered.length ? list(ui, altered) : ui.note('原有验收资产校验通过。'),
    ...links(ui, context, [['case-input.json', '项目输入与命令清单'], ['candidate.diff', '查看代码差异']]));
}

function adviceInput(data, ui) {
  if (!Array.isArray(data) || !data.every((x) => isRecord(x) && isText(x.id) && isText(x.status))) return null;
  if (!data.length) return ui.section('提供给审阅模型的证据', ui.note('证据清单为空。'));
  return ui.section('提供给审阅模型的证据', ui.table(['检查项', '状态', '摘要', '证据名称'], data.map((check) => [
    isText(check.title) ? check.title + ' · ' + check.id : check.id,
    statusBadge(ui, check.status),
    isText(check.summary) ? check.summary : '—',
    isTextList(check.artifacts) && check.artifacts.length ? list(ui, check.artifacts) : '—',
  ]), '提供给审阅模型的检查记录'));
}

function adviceOutput(data, ui, context) {
  if (!isRecord(data) || !isText(data.summary) || !Array.isArray(data.items)
    || !data.items.every((item) => isRecord(item) && isText(item.finding) && isText(item.fix)
      && isTextList(item.evidenceIds) && isTextList(item.retest))) return null;
  const children = [ui.note(data.summary)];
  const checks = new Map(Array.isArray(context?.run?.checks)
    ? context.run.checks.filter((check) => isText(check?.id)).map((check) => [check.id, check.title]) : []);
  for (const item of data.items) {
    children.push(ui.element('h4', '', item.finding), facts(ui, [['修复建议', item.fix]]));
    if (item.retest.length) children.push(ui.element('p', '', '复测步骤'), list(ui, item.retest, true));
    if (item.evidenceIds.length) {
      children.push(facts(ui, [['引用检查', item.evidenceIds.map((id) => {
        const title = checks.get(id);
        return isText(title) ? title + '（' + id + '）' : id;
      }).join('、')]]));
    }
  }
  children.push(...links(ui, context, [['advice-evidence.json', '提供给审阅模型的证据']]));
  return ui.section('模型审阅建议', ...children);
}

function adviceConfig(data, ui, context) {
  if (!isRecord(data) || ![data.modelProvider, data.preset, data.model, data.apiStyle].some(isText)) return null;
  return ui.section('模型审阅配置', facts(ui, [
    ['提供方', data.modelProvider ?? data.preset], ['API 样式', data.apiStyle], ['服务地址', data.baseURL],
    ['模型', data.model], ['推理强度', data.reasoningEffort], ['认证方式', data.auth],
  ]), ...links(ui, context, [['advice-api-response.json', '模型审阅响应记录']]));
}

function adviceResponse(data, ui, context) {
  if (!isRecord(data)) return null;
  const fields = ['httpStatus', 'responseStatus', 'model', 'reasoningEffort', 'requestId', 'errorCode'];
  const isAttempt = (attempt) => isRecord(attempt) && fields.some((field) => Object.hasOwn(attempt, field));
  const attempts = Array.isArray(data.attempts) && data.attempts.every(isAttempt) ? data.attempts : null;
  if (!attempts?.length && !isAttempt(data)) return null;
  const children = [];
  const final = isAttempt(data) ? data : attempts.at(-1);
  if (isText(final.errorCode)) children.push(ui.badge('error', '请求异常'), ui.note(final.errorCode));
  const totals = [];
  if (Number.isInteger(final.httpStatus)) totals.push(['HTTP 状态', final.httpStatus, final.httpStatus >= 400 ? 'fail' : 'neutral']);
  if (isText(final.responseStatus)) totals.push(['模型响应状态', final.responseStatus]);
  if (attempts?.length) totals.push(['请求次数', attempts.length]);
  if (totals.length) children.push(ui.metrics(totals));
  const textFields = [['模型', final.model], ['推理强度', final.reasoningEffort], ['请求 ID', final.requestId]];
  if (textFields.some(([, value]) => isText(value))) children.push(facts(ui, textFields));
  if (attempts?.length) {
    children.push(ui.details('逐次请求详情', ui.table([
      '请求', 'HTTP', '响应状态', '模型', '推理强度', '请求 ID', '错误代码',
    ], attempts.map((attempt, index) => [index + 1, ...fields.map((key) =>
      isText(attempt[key]) || Number.isInteger(attempt[key]) ? attempt[key] : '—')]), '审阅请求详情')));
  }
  children.push(...links(ui, context, [
    ['advice-api-config.json', '模型审阅配置'], ['advice-response.json', '模型审阅建议'],
  ]));
  if (!children.length) children.push(ui.note('响应记录中没有状态值。'));
  return ui.section('模型审阅响应记录', ...children);
}

export function renderOperationsEvidence(file, data, ui, context) {
  if (file === 'code.json' || file === 'lint.json') return lintEvidence(data, ui);
  if (/^(?:browser-empty-)?(?:backend|frontend)(?:-health)?\.json$/u.test(file)) return serviceEvidence(file, data, ui);
  if (/^project-command-[\w-]+\.log$/u.test(file)) return commandLog(data, ui, context);
  if (/^(?:project-)?command-[\w-]+\.json$/u.test(file)) return commandResult(data, ui, context);
  if (['case-input.json', 'trial-config.json', 'validation-config.json', 'validation-metadata.json'].includes(file)) {
    return inputMetadata(file, data, ui, context);
  }
  if (file === 'verification-assets.json') return verificationAssets(data, ui, context);
  if (file === 'advice-evidence.json') return adviceInput(data, ui);
  if (file === 'advice-response.json') return adviceOutput(data, ui, context);
  if (file === 'advice-api-config.json') return adviceConfig(data, ui, context);
  if (file === 'advice-api-response.json') return adviceResponse(data, ui, context);
  return null;
}
