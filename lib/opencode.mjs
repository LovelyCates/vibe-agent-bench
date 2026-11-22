import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { redactOutput, terminateProcessTree } from './project-run.mjs';
import { buildSkillEvidence, prepareSkills, skillDirectory, skillInventory, verifySkillEvent } from './skill-packs.mjs';
import { skillName, skillPath, taskPrompt } from './task.mjs';

const version = '1.19.6';
const model = 'gpt-6.2-sol';
const variant = 'medium';
const apiKeyEnv = 'VIBE_BENCH_OPENAI_API_KEY';
const timeoutMs = 300_000;
const isWindows = process.platform === 'win32';
const readVersion = promisify(execFile);
const allowedEdits = [
  'backend/tasks-route.mjs', 'frontend/index.html', 'frontend/app.mjs', 'frontend/style.css', 'test/*.test.mjs',
];
const configFile = 'opencode-agent-config.json';
const stdoutFile = 'opencode-agent.jsonl';
const stderrFile = 'opencode-agent-stderr.log';
const proofFile = 'skill-proof.json';
const nativeArtifacts = [
  { file: configFile, label: 'OpenCode 启动配置' },
  { file: stdoutFile, label: 'OpenCode 结构化事件' },
  { file: stderrFile, label: 'OpenCode 诊断日志' },
];

const slashes = (path) => path.replaceAll('\\', '/');

async function isFile(path) {
  return (await stat(path).catch(() => null))?.isFile() ?? false;
}

async function executablePath() {
  const override = process.env.VIBE_BENCH_OPENCODE_BIN;
  if (override) return resolve(override);
  if (!isWindows) return 'opencode';
  const npm = process.env.APPDATA ? [join(process.env.APPDATA, 'npm')] : [];
  const directories = [...npm, ...(process.env.PATH ?? '').split(delimiter)].filter(Boolean);
  for (const directory of directories) {
    for (const executable of ['opencode.exe', 'node_modules/opencode-ai/bin/opencode.exe']) {
      const path = join(directory.replace(/^"|"$/gu, ''), executable);
      if (await isFile(path)) return path;
    }
  }
  throw new Error('找不到 OpenCode 原生可执行文件。可使用 VIBE_BENCH_OPENCODE_BIN 指定路径。');
}

function config(workspace, keyFile, projectCase, skillContext) {
  // OpenCode reports edit paths relative to its worktree, which is `/` for this non-Git fixture.
  const workspaceRoot = parse(workspace).root;
  const edit = { '*': 'deny' };
  for (const path of allowedEdits) {
    edit[path] = 'allow';
    edit[slashes(relative(workspaceRoot, join(workspace, path)))] = 'allow';
  }
  const projectEdit = {
    '*': 'deny',
    [`${slashes(relative(workspaceRoot, workspace))}/*`]: 'allow',
    [`${slashes(workspace)}/*`]: 'allow',
    [`${slashes(relative(workspaceRoot, workspace))}/${skillDirectory}/*`]: 'deny',
    [`${slashes(workspace)}/${skillDirectory}/*`]: 'deny',
  };
  for (const file of projectCase?.protectedFiles ?? []) {
    projectEdit[file] = 'deny';
    projectEdit[slashes(relative(workspaceRoot, join(workspace, file)))] = 'deny';
    projectEdit[slashes(join(workspace, file))] = 'deny';
  }
  const bash = {
    '*': 'deny',
    'node --test': 'allow',
    'node --test test/*.test.mjs': 'allow',
    'node --test ./test/*.test.mjs': 'allow',
  };
  const projectShell = { '*': 'deny' };
  if (projectCase?.scenario === 'java-vue-status-filter') {
    for (const name of ['test:api', 'test:browser', 'lint', 'build']) projectShell[`npm run ${name}`] = 'allow';
  }
  if (skillContext?.openspecBin) {
    for (const pattern of ['openspec list *', 'openspec context *', 'openspec status *', 'openspec instructions *', 'openspec new change *', 'openspec validate *']) {
      projectShell[pattern] = 'allow';
    }
  }

  return {
    autoupdate: false,
    share: 'disabled',
    snapshot: false,
    formatter: false,
    lsp: false,
    enabled_providers: ['openai'],
    model: `openai/${model}`,
    small_model: `openai/${model}`,
    skills: { paths: projectCase ? (skillContext?.paths.map(slashes) ?? []) : [dirname(dirname(skillPath))] },
    ...(skillContext && { instructions: [slashes(skillContext.instructions)] }),
    permission: {
      '*': 'deny', read: 'allow', glob: 'allow', grep: 'allow', list: 'allow', todowrite: 'allow',
      external_directory: 'deny', edit: projectCase ? projectEdit : edit,
      bash: projectCase ? projectShell : bash,
      skill: projectCase ? { '*': 'deny', ...Object.fromEntries([...skillContext?.entries.keys() ?? []].map((name) => [name, 'allow'])) }
        : { '*': 'deny', [skillName]: 'allow' },
    },
    provider: {
      openai: {
        npm: '@ai-sdk/openai',
        options: { baseURL: 'https://api.openai.com/v1', apiKey: `{file:${slashes(keyFile)}}` },
        models: {
          [model]: {
            reasoning: true,
            tool_call: true,
            options: { reasoningEffort: variant },
            variants: { [variant]: { reasoningEffort: variant } },
          },
        },
      },
    },
  };
}

async function isolatedEnvironment(directory, openCodeConfig, openspecBin) {
  const home = join(directory, 'home');
  const temporary = join(directory, 'temp');
  const roaming = join(home, 'AppData', 'Roaming');
  const local = join(home, 'AppData', 'Local');
  await Promise.all([mkdir(roaming, { recursive: true }), mkdir(local, { recursive: true }), mkdir(temporary)]);
  const inherited = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => /^(path|systemroot|windir|systemdrive|comspec|pathext|programfiles|programfiles\(x86\)|programw6432)$/iu.test(key)));

  if (openspecBin) {
    const name = Object.keys(inherited).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
    inherited[name] = [openspecBin, inherited[name]].filter(Boolean).join(delimiter);
  }
  return {
    ...inherited,
    USERPROFILE: home,
    APPDATA: roaming,
    LOCALAPPDATA: local,
    TMPDIR: temporary,
    TEMP: temporary,
    TMP: temporary,
    XDG_CONFIG_HOME: join(directory, 'config'),
    XDG_DATA_HOME: join(directory, 'data'),
    XDG_STATE_HOME: join(directory, 'state'),
    XDG_CACHE_HOME: join(directory, 'cache'),
    OPENCODE_TEST_HOME: home,
    OPENCODE_TEST_MANAGED_CONFIG_DIR: join(directory, 'managed'),
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
    OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
    OPENCODE_DISABLE_CLAUDE_CODE: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENSPEC_TELEMETRY: '0',
    OPENCODE_CONFIG_CONTENT: JSON.stringify(openCodeConfig),
  };
}

function parseEvent(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function preview(value, key, limit = 420) {
  if (typeof value !== 'string') return '';
  const text = redactOutput(value, key).trim();
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

function visiblePath(workspace, value, key) {
  if (typeof value !== 'string' || !value) return '';
  const rel = isAbsolute(value) ? relative(workspace, value) : value;
  const path = slashes(rel);
  if (path === '..' || path.startsWith('../') || isAbsolute(rel)) return '项目目录之外';
  return preview(path, key, 190);
}

const toolLabels = {
  apply_patch: '应用补丁', bash: '执行命令', edit: '编辑文件', glob: '查找文件', grep: '搜索内容',
  list: '列出目录', read: '读取文件', skill: '加载 Skill', todowrite: '更新待办', write: '写入文件',
};

function normalizeEvent(event, workspace, key) {
  const { part, type } = event ?? {};
  const phase = 'agent';
  if (type === 'step_start') return { kind: 'step', phase, summary: 'OpenCode 开始处理。', status: 'running' };
  if (type === 'step_finish') {
    const completed = part?.reason === 'stop';
    return {
      kind: 'step', phase, status: completed ? 'completed' : 'running',
      summary: completed ? 'OpenCode 完成响应。' : 'OpenCode 完成一个步骤。',
    };
  }
  if (type === 'error') {
    const name = preview(event.error?.name, key, 70);
    return { kind: 'error', phase, status: 'error', summary: name ? `OpenCode 报错（${name}）。` : 'OpenCode 报错。' };
  }
  if (type === 'text' && part?.type === 'text' && part?.synthetic !== true) {
    const summary = preview(part.text, key);
    if (summary) return { kind: 'message', phase, summary };
  }
  if (type !== 'tool_use' || part?.type !== 'tool' || !/^[a-z][a-z0-9_-]{0,47}$/u.test(part.tool ?? '')) return null;
  const tool = part.tool;
  const { input, metadata, output, status: state } = part.state ?? {};
  const status = state === 'error' ? 'error' : state === 'completed' ? 'completed' : 'running';
  let target = visiblePath(workspace, input?.filePath ?? input?.path, key);
  let outputPreview = '';
  if (tool === 'glob' || tool === 'grep') target = preview(input?.pattern, key, 190);
  if (tool === 'skill') target = preview(input?.name, key, 190);
  if (tool === 'bash') {
    target = preview(input?.command, key, 260);
    outputPreview = preview(output, key);
  }
  if (tool === 'apply_patch' && Array.isArray(metadata?.files)) {
    target = metadata.files.slice(0, 5).map((entry) => visiblePath(workspace, entry?.filePath, key)).filter(Boolean).join('、');
    if (metadata.files.length > 5) target += ` 等 ${metadata.files.length} 个文件`;
  }
  const label = toolLabels[tool] ?? tool;
  const action = status === 'error' ? `${label}失败` : label;
  return {
    kind: 'tool', phase, tool, status,
    summary: target ? preview(`${action} · ${target}`, key) : action,
    ...(outputPreview ? { detail: outputPreview } : {}),
  };
}

async function* pipeLines(input) {
  const lines = createInterface({ input, crlfDelay: Infinity });
  const close = () => lines.close();
  input.once('close', close);
  try {
    yield* lines;
  } finally {
    input.off('close', close);
    lines.close();
  }
}

async function* streamEvents(input, { workspace, onEvent, key, projectCase, skillContext, skillCalls }) {
  for await (const line of pipeLines(input)) {
    const event = parseEvent(line);
    if (event?.type === 'reasoning' || event?.part?.type === 'reasoning') continue;
    const normalized = normalizeEvent(event, workspace, key);
    const proof = verifySkillEvent(skillContext, event);
    if (proof) {
      skillCalls.push(proof);
      if (normalized) {
        normalized.summary = `${proof.bodyVerified ? '已验证读取' : '已加载'} · ${proof.name}`;
        normalized.detail = `Skill 包 ${proof.packId}\n源文件 ${proof.path}\n调用 ${proof.evidence}`;
      }
    }
    if (normalized) await onEvent(normalized);
    if (!projectCase) {
      yield redactOutput(line, key) + '\n';
    } else if (normalized) {
      const { type, timestamp, sessionID, part } = event;
      yield JSON.stringify({
        type, timestamp, sessionID: preview(sessionID, key, 140),
        part: part && {
          type: part.type, id: preview(part.id, key, 140), callID: preview(part.callID, key, 140),
          reason: preview(part.reason, key, 60), tool: normalized.tool,
        },
        error: type === 'error' ? { name: preview(event.error?.name, key, 70) || 'OpenCodeError' } : undefined,
        preview: normalized,
      }) + '\n';
    }
  }
}

async function* redactSecrets(input, key) {
  for await (const line of pipeLines(input)) {
    yield redactOutput(line, key) + '\n';
  }
}

async function invokeOpenCode({ executable, env, workspace, artifactDir, prompt, onEvent, key, projectCase, skillContext, skillCalls }) {
  const args = [
    'run', '--pure', '--format', 'json', '--model', `openai/${model}`, '--variant', variant,
    '--agent', 'build', '--title', projectCase ? 'Project benchmark' : 'Task status filter benchmark',
  ];
  const child = spawn(executable, args, {
    cwd: workspace, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: !isWindows,
  });
  let timedOut = false;
  let spawnError;
  let cleanup;
  let drainTimer;
  let drainExpired = false;
  const stop = () => cleanup ??= terminateProcessTree(child).catch(() => child.kill('SIGKILL')).finally(() => {
    child.stdout.destroy();
    child.stderr.destroy();
  });
  const timer = setTimeout(() => {
    timedOut = true;
    void stop();
  }, timeoutMs);
  const exited = new Promise((done) => {
    child.once('error', (error) => {
      spawnError = error.code ?? error.message;
      done({ code: null, signal: null, timedOut, spawnError });
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      // Windows descendants can keep inherited pipe handles open after the CLI itself exits.
      drainTimer = setTimeout(() => {
        drainExpired = true;
        child.stdout.destroy();
        child.stderr.destroy();
      }, 2_500);
      done({ code, signal, timedOut, spawnError });
    });
  });
  child.stdin.on('error', () => {});
  child.stdin.end(prompt, 'utf8');

  try {
    const tolerateInheritedPipe = (error) => {
      if (!drainExpired || error.code !== 'ERR_STREAM_PREMATURE_CLOSE') throw error;
    };
    const [execution] = await Promise.all([
      exited,
      pipeline(child.stdout, (input) => streamEvents(input, { workspace, onEvent, key, projectCase, skillContext, skillCalls }),
        createWriteStream(join(artifactDir, stdoutFile))).catch(tolerateInheritedPipe),
      pipeline(child.stderr, (input) => redactSecrets(input, key), createWriteStream(join(artifactDir, stderrFile))).catch(tolerateInheritedPipe),
    ]);
    return { ...execution, drainExpired };
  } catch (error) {
    await stop();
    const execution = await exited;
    if (timedOut) return execution;
    throw error;
  } finally {
    clearTimeout(timer);
    clearTimeout(drainTimer);
    await cleanup;
  }
}

function samePath(workspace, received, expected) {
  if (typeof received !== 'string' || !received) return false;
  const actual = resolve(workspace, received);
  return isWindows ? actual.toLowerCase() === expected.toLowerCase() : actual === expected;
}

async function inspectEvents({ workspace, artifactDir, skillToken }) {
  const result = { sessionId: null, finishReason: null, errorName: null, activation: null, read: null, skillFileRead: null };
  const expected = resolve(workspace, skillPath);
  const input = createReadStream(join(artifactDir, stdoutFile), { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber++;
    const event = parseEvent(line);
    if (typeof event?.sessionID !== 'string') continue;
    result.sessionId ??= event.sessionID;
    if (event.sessionID !== result.sessionId) continue;
    if (event.type === 'error') result.errorName = event.error?.name ?? 'OpenCodeError';
    if (event.type === 'step_finish') result.finishReason = event.part?.reason ?? null;
    const { part } = event;
    if (event.type !== 'tool_use' || part?.type !== 'tool' || part.sessionID !== result.sessionId
      || part.state?.status !== 'completed' || typeof part.state.output !== 'string') continue;
    const { input, metadata, output } = part.state;
    const location = { line: lineNumber, partId: part.id, callId: part.callID };
    if (part.tool === 'skill' && input?.name === skillName && metadata?.name === skillName
      && output.startsWith(`<skill_content name="${skillName}">\n`)) {
      const evidence = { ...location, method: 'skill-tool', name: skillName, directory: metadata.dir ?? null };
      result.activation ??= evidence;
      if (skillToken && samePath(workspace, metadata.dir, dirname(expected)) && output.includes(skillToken)) {
        result.read ??= evidence;
      }
    }
    if (part.tool === 'read' && samePath(workspace, input?.filePath, expected)) {
      const readOutput = /^<path>([^\r\n]+)<\/path>\r?\n<type>file<\/type>\r?\n<content>([\s\S]*?)<\/content>/u.exec(output);
      if (!readOutput || !samePath(workspace, readOutput[1], expected)) continue;
      const evidence = { ...location, method: 'file-read', path: skillPath };
      result.skillFileRead ??= evidence;
      if (skillToken && readOutput[2].includes(skillToken)) result.read ??= evidence;
    }
  }
  return result;
}

function executionIssue(execution, events) {
  if (execution.spawnError) return `无法启动 OpenCode CLI（${execution.spawnError}）。`;
  if (execution.timedOut) return 'OpenCode 运行超时。';
  if (execution.signal) return `OpenCode 提前终止（${execution.signal}）。`;
  if (events.errorName || execution.code !== 0) return `OpenCode CLI 执行失败（退出码 ${execution.code}），详情见结构化事件和诊断日志。`;
  if (events.finishReason !== 'stop') return 'OpenCode 事件未记录成功结束的实现轮次。';
  return null;
}

async function readSkill(workspace) {
  const path = join(workspace, skillPath);
  try {
    if (!(await lstat(path)).isFile()) return { present: true, bytes: null };
    return { present: true, bytes: await readFile(path) };
  } catch (error) {
    if (error.code === 'ENOENT') return { present: false, bytes: null };
    throw error;
  }
}

export async function runOpenCode({
  workspace, artifactDir, skillToken, skillMode, report, prompt = taskPrompt, onEvent = () => {}, projectCase = null,
}) {
  workspace = await realpath(workspace);
  const originalSkill = projectCase ? null : await readSkill(workspace);
  const offered = Boolean(skillToken);
  if (originalSkill && (offered ? !originalSkill.bytes?.includes(skillToken) : originalSkill.present)) {
    throw new Error('OpenCode 工作区的 Skill 文件与评测条件不一致。');
  }
  await report('agent', 'running', '正在运行 OpenCode CLI。');
  const packProfile = projectCase?.skillProfile ?? 'none';
  if (originalSkill || packProfile !== 'none') await report('skill', 'running', '正在收集 OpenCode 的 Skill 事件。');

  const root = resolve(tmpdir());
  const stateDir = await mkdtemp(join(root, 'vibe-bench-opencode-'));
  let actualVersion = null;
  let issue;
  let events;
  let execution;
  let skillContext;
  let inventory = [];
  let key;
  let temporaryKeyFile;
  const skillCalls = [];
  try {
    key = process.env[apiKeyEnv]?.trim();
    let keyFile;
    if (key) {
      keyFile = join(stateDir, 'openai-api-key');
      const handle = await open(keyFile, 'wx', 0o600);
      temporaryKeyFile = keyFile;
      try {
        await handle.writeFile(key, 'utf8');
      } finally {
        await handle.close();
      }
    } else {
      keyFile = process.env.LOCALAPPDATA && resolve(process.env.LOCALAPPDATA, 'VibeAgentBench', 'openai-api-key');
      if (!keyFile || !(await isFile(keyFile))) throw new Error('找不到 OpenAI 项目密钥文件。');
      key = (await readFile(keyFile, 'utf8')).trim();
      if (!key) throw new Error('OpenAI 项目密钥文件为空。');
    }
    const executable = await executablePath();
    skillContext = await prepareSkills(workspace, packProfile, projectCase?.skillLocks);
    const env = await isolatedEnvironment(stateDir, config(workspace, keyFile, projectCase, skillContext), skillContext?.openspecBin);
    const checked = await readVersion(executable, ['--version'], { cwd: workspace, env, timeout: 5_000, windowsHide: true });
    const reportedVersion = checked.stdout.trim();
    actualVersion = redactOutput(reportedVersion, key);
    if (reportedVersion !== version) throw new Error(`OpenCode CLI 版本应为 ${version}，实际为 ${actualVersion || '未知'}。`);
    if (skillContext) {
      const discovered = await readVersion(executable, ['debug', 'skill', '--pure'], {
        cwd: workspace, env, timeout: 15_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024,
      });
      inventory = skillInventory(skillContext, discovered.stdout);
      const missing = inventory.filter(({ discovered }) => !discovered);
      await onEvent({ kind: 'phase', phase: 'agent', checkId: 'skill', status: missing.length ? 'fail' : 'pass',
        summary: `OpenCode 原生清单发现 ${inventory.length - missing.length}/${inventory.length} 项 Skill。`,
        detail: inventory.map(({ name, discovered }) => `${discovered ? '已发现' : '未发现'} ${name}`).join('\n') });
      if (missing.length) throw new Error(`OpenCode 未发现 ${missing.map(({ name }) => name).join('、')}。`);
    }
    execution = await invokeOpenCode({ executable, env, workspace, artifactDir, prompt, onEvent, key, projectCase, skillContext, skillCalls });
    events = await inspectEvents({ workspace, artifactDir, skillToken });
    issue = executionIssue(execution, events);
  } catch (error) {
    issue = error.signal || error.code ? 'OpenCode CLI 无法启动或无法保存本次运行日志。' : redactOutput(error.message, key);
    for (const file of [stdoutFile, stderrFile]) {
      const path = join(artifactDir, file);
      if (!(await isFile(path))) await writeFile(path, file === stderrFile ? `${issue}\n` : '', 'utf8');
    }
  } finally {
    if (temporaryKeyFile) {
      await unlink(temporaryKeyFile).catch((error) => {
        if (error.code !== 'ENOENT') console.error(`OpenCode 临时密钥删除失败（${error.code ?? 'UNKNOWN'}）。`);
      });
    }
    if (dirname(resolve(stateDir)) === root && basename(stateDir).startsWith('vibe-bench-opencode-')) {
      // Windows background services may briefly hold files in the isolated profile.
      void rm(stateDir, { recursive: true, force: true, maxRetries: 3 }).catch((error) => {
        console.error(`OpenCode 临时状态清理失败（${error.code ?? 'UNKNOWN'}）。`);
      });
    }
  }
  await writeFile(join(artifactDir, configFile), JSON.stringify({
    version: actualVersion, requiredVersion: version, model, reasoningEffort: variant, modelProvider: 'openai',
    auth: 'project-api-key', agent: 'build', session: 'fresh', externalPlugins: false, projectConfig: false,
    ...(execution && { execution }),
    ...(projectCase ? { skillProfile: packProfile, shell: skillContext?.openspecBin || projectCase.scenario ? 'allowlist' : 'disabled',
      edits: 'workspace', events: 'redacted' } : {}),
  }, null, 2) + '\n', 'utf8');
  await report('agent', issue ? 'error' : 'pass', issue ?? 'OpenCode CLI 完成了实现轮次。', nativeArtifacts);
  if (!originalSkill) {
    const skillEvidence = await buildSkillEvidence(skillContext, inventory, skillCalls);
    if (skillEvidence) {
      const required = skillEvidence.packs.filter((pack) => !pack.skills.some(({ verified, unchanged }) => verified && unchanged));
      const valid = skillEvidence.packs.every((pack) => pack.skills.every(({ unchanged }) => unchanged));
      await writeFile(join(artifactDir, proofFile), JSON.stringify(skillEvidence, null, 2) + '\n', 'utf8');
      const count = skillEvidence.packs.flatMap(({ skills }) => skills).filter(({ verified }) => verified).length;
      const issueSummary = required.length ? `未验证读取 ${required.map(({ title }) => title).join('、')}。` : '';
      await report('skill', issue ? 'blocked' : valid && !required.length ? 'pass' : 'fail',
        `已验证 ${count} 项正文。${valid ? issueSummary : '运行期间有 Skill 文件变化。'}`,
        [{ file: proofFile, label: 'Skill 版本与原生读取证据' }, ...nativeArtifacts]);
    } else if (packProfile !== 'none') {
      await report('skill', 'blocked', 'Skill 包无法完成注册，查看 OpenCode 诊断。', nativeArtifacts);
    }
    return { ok: !issue, skillEvidence, sessionId: events?.sessionId ?? null };
  }

  const finalSkill = await readSkill(workspace);
  const unchanged = offered ? Boolean(finalSkill.bytes?.equals(originalSkill.bytes)) : !finalSkill.present;
  const missingEvidence = issue ? 'unknown' : 'not-observed';
  const skillEvidence = {
    activation: events?.activation ? 'observed' : missingEvidence,
    read: events?.read ? 'verified' : missingEvidence,
    method: events?.read?.method ?? events?.activation?.method ?? null,
  };
  await writeFile(join(artifactDir, proofFile), JSON.stringify({
    path: skillPath,
    skillMode,
    ...skillEvidence,
    sha256: originalSkill.bytes ? createHash('sha256').update(originalSkill.bytes).digest('hex') : null,
    unchanged,
    sessionId: events?.sessionId ?? null,
    activationEvent: events?.activation ?? null,
    readEvent: events?.read ?? null,
    skillFileReadEvent: events?.skillFileRead ?? null,
  }, null, 2) + '\n', 'utf8');

  let skillStatus = 'pass';
  let summary = offered ? 'OpenCode 事件证明本次 Skill 正文已读取，文件摘要一致。' : '对照组的 Skill 文件缺席，运行中未观察到该 Skill。';
  if (!unchanged || (!offered && (events?.activation || events?.skillFileRead))) {
    skillStatus = 'fail';
    summary = offered ? '运行期间修改或删除了受保护的 Skill 文件。' : '对照组运行出现了本应缺席的 Skill 文件或加载事件。';
  } else if (!events?.read && (offered || issue)) {
    skillStatus = issue ? 'blocked' : 'fail';
    summary = issue ? 'OpenCode 未成功完成，Skill 观察证据不完整。' : 'OpenCode 事件未验证本次 Skill 正文的读取。';
  }
  await report('skill', skillStatus, summary, [{ file: proofFile, label: 'Skill 观察证据' }, ...nativeArtifacts]);
  return { ok: !issue, skillEvidence };
}
