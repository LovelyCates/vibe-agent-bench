import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { readDshCatalog, redactDshEvent, trackDshRun } from './dsh-events.mjs';
import { getModelApiKey, getModelConfig } from './model-config.mjs';
import { redactOutput, terminateProcessTree } from './project-run.mjs';
import { buildSkillEvidence, prepareSkills } from './skill-packs.mjs';
import { skillName, skillPath, taskPrompt } from './task.mjs';

const isWindows = process.platform === 'win32';
const executablePackage = 'node_modules/@deepseek-ai/dsh/lib/bin.js';
const versionCommand = promisify(execFile);
const timeoutMs = 600_000;
const configFile = 'dsh-agent-config.json';
const stdoutFile = 'dsh-agent.jsonl';
const stderrFile = 'dsh-agent-stderr.log';
const proofFile = 'skill-proof.json';
const keyEnv = 'VIBE_BENCH_DSH_ROUTE_API_KEY';
// DSH's pi-ai Chat Completions adapter requires a credential even for a keyless server.
const keylessPlaceholder = 'bench-local-unauthenticated';
const artifacts = [
  { file: configFile, label: 'DSH 启动配置' },
  { file: stdoutFile, label: 'DSH 结构化事件' },
  { file: stderrFile, label: 'DSH 诊断日志' },
];
const skillArtifacts = [{ file: proofFile, label: 'Skill 原生读取证据' }, ...artifacts];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function isFile(path) {
  return (await stat(path).catch(() => null))?.isFile() ?? false;
}

async function dshCommand() {
  const override = process.env.VIBE_BENCH_DSH_BIN?.trim();
  const bundled = fileURLToPath(new URL(`../${executablePackage}`, import.meta.url));
  const directories = [process.env.APPDATA && join(process.env.APPDATA, 'npm'), ...(process.env.PATH ?? '').split(delimiter)]
    .filter(Boolean).map((path) => path.trim().replace(/^"|"$/gu, '')).filter(isAbsolute);
  const candidates = override ? [resolve(override)] : [bundled, ...directories.flatMap((path) => [
    join(path, executablePackage), join(path, isWindows ? 'dsh.exe' : 'dsh'),
  ])];
  for (const candidate of candidates) {
    const path = /\.(?:cmd|bat|ps1)$/iu.test(candidate) ? join(dirname(candidate), executablePackage) : candidate;
    if (await isFile(path)) {
      return /\.[cm]?js$/iu.test(path) ? { executable: process.execPath, prefix: [path] } : { executable: path, prefix: [] };
    }
  }
  throw new Error('找不到 DSH CLI。安装 @deepseek-ai/dsh 后，可用 VIBE_BENCH_DSH_BIN 指定其 lib/bin.js 或原生可执行文件。');
}

async function isolatedEnv(stateDir, openspecBin) {
  const home = join(stateDir, 'home');
  const temp = join(stateDir, 'temp');
  const roaming = join(home, 'AppData', 'Roaming');
  const local = join(home, 'AppData', 'Local');
  await Promise.all([roaming, local, temp].map((path) => mkdir(path, { recursive: true })));
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    /^(systemroot|windir|systemdrive|comspec|pathext|programfiles|programfiles\(x86\)|programw6432|node_extra_ca_certs)$/iu.test(name)));
  return {
    ...inherited,
    PATH: [openspecBin, dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter),
    HOME: home,
    USERPROFILE: home,
    APPDATA: roaming,
    LOCALAPPDATA: local,
    TMPDIR: temp,
    TEMP: temp,
    TMP: temp,
    DSH_HOME: join(stateDir, 'dsh'),
    DSH_AGENTS_HOME: join(stateDir, 'agents'),
    DSH_TELEMETRY_DISABLED: '1',
    OPENSPEC_TELEMETRY: '0',
    NO_COLOR: '1',
  };
}

function providerPatch(model, skillRoots, sessionDirectory) {
  const api = model.apiStyle === 'responses' ? 'openai-responses' : 'openai-completions';
  const reasoning = model.reasoningEffort;
  return [
    { id: 'llm-pi-ai', config: { providers: { 'vibe-bench': {
      api, baseURL: model.baseURL, apiKeyEnv: keyEnv,
      ...(api === 'openai-completions' && { compat: { supportsDeveloperRole: false, maxTokensField: 'max_tokens', supportsStore: false } }),
      models: [{ id: model.model, ...(reasoning && { reasoningEfforts: { [reasoning]: reasoning } }) }],
    } } } },
    { id: 'agent-default-model', config: {
      provider: 'vibe-bench', model: model.model, ...(reasoning && { reasoningEffort: reasoning }),
    } },
    { id: 'skill-filesystem', config: { includeDefaultRoots: false, customSkillDirs: skillRoots, watch: false } },
    { id: 'session-persistence-jsonl', config: { root: sessionDirectory, compression: 'none' } },
    ...['session-log-deepseek', 'plugin-package-inventory-deepseek', 'session-title-llm', 'web-search-deepseek', 'web-deepseek-api', 'web-fetch-http']
      .map((id) => ({ id, disabled: true })),
  ];
}

async function preparePackedMarkers(context) {
  if (!context) return;
  for (const entry of context.entries.values()) {
    const text = await readFile(entry.file, 'utf8');
    const frontmatter = /^---\r?\n[\s\S]*?\r?\n---\r?\n/u.exec(text);
    if (!frontmatter) throw new Error(`Skill ${entry.name} 缺少 DSH 需要的 YAML 元数据。`);
    // DSH caps a projected tool result at 8 KiB per string. Keep the run-only marker in the visible body.
    const marker = `<!-- ${entry.token} -->`;
    const body = text.slice(frontmatter[0].length).replace(`\n\n${marker}\n`, '');
    const staged = `${frontmatter[0]}\n${marker}\n${body}`;
    await writeFile(entry.file, staged);
    entry.stagedSha256 = sha256(staged);
  }
}

async function regularFile(path) {
  const info = await lstat(path).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (!info) return { present: false, bytes: null };
  return { present: true, bytes: info.isFile() && !relative(path, await realpath(path)) ? await readFile(path) : null };
}

async function protectedSnapshot(workspace, files) {
  return Promise.all(files.map(async (file) => {
    const path = resolve(workspace, file);
    const scope = relative(workspace, path);
    if (!scope || isAbsolute(scope) || scope === '..' || scope.startsWith(`..${sep}`)) {
      throw new Error('DSH 验收资产路径必须位于临时工作区内。');
    }
    const { present, bytes } = await regularFile(path);
    return [file, bytes ? sha256(bytes) : present ? 'unreadable' : null];
  }));
}

async function consume(input, path, convert) {
  const handle = await open(path, 'w', 0o600);
  const lines = createInterface({ input, crlfDelay: Infinity });
  const close = () => lines.close();
  input.once('close', close);
  try {
    for await (const line of lines) await handle.writeFile(`${await convert(line)}\n`, 'utf8');
  } finally {
    input.off('close', close);
    lines.close();
    await handle.close();
  }
}

async function invoke({ command, patch, workspace, env, artifactDir, prompt, secret, observations, onEvent }) {
  const child = spawn(command.executable, [...command.prefix, '--profile', 'headless', '--patch', patch,
    '--json', '--permission-mode', 'workspace-write', '--approval-policy', 'never', '-'], {
    cwd: workspace, env, windowsHide: true, detached: !isWindows, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let spawnError = null;
  let timedOut = false;
  let cleanup;
  let drainTimer;
  let drainExpired = false;
  const destroyPipes = () => { child.stdout.destroy(); child.stderr.destroy(); };
  const stop = () => cleanup ??= terminateProcessTree(child).catch(() => child.kill('SIGKILL')).finally(destroyPipes);
  const timer = setTimeout(() => {
    timedOut = true;
    void stop();
  }, timeoutMs);
  const exited = new Promise((done) => {
    child.once('error', (error) => { spawnError = error.code ?? error.name; });
    child.once('exit', () => {
      clearTimeout(timer);
      // Descendants may keep Windows pipe handles open after DSH exits.
      drainTimer = setTimeout(() => { drainExpired = true; destroyPipes(); }, 2500);
    });
    child.once('close', (code, signal) => done({ code, signal }));
  });
  child.stdin.on('error', () => {});
  child.stdin.end(prompt, 'utf8');
  try {
    const [execution] = await Promise.all([
      exited,
      consume(child.stdout, join(artifactDir, stdoutFile), async (line) => {
        const event = redactDshEvent(line, secret);
        const visible = observations.observe(event);
        if (visible) await onEvent(visible);
        return JSON.stringify(event);
      }),
      consume(child.stderr, join(artifactDir, stderrFile), (line) => redactOutput(line, secret)),
    ]);
    return { ...execution, timedOut, spawnError, drainExpired };
  } catch (error) {
    await stop();
    await exited;
    throw error;
  } finally {
    clearTimeout(timer);
    clearTimeout(drainTimer);
    await cleanup;
  }
}

function runIssue(execution, state) {
  if (execution.spawnError) return `无法启动 DSH CLI（${execution.spawnError}）。`;
  if (execution.timedOut) return 'DSH 运行超时。';
  if (execution.signal) return `DSH 提前终止（${execution.signal}）。`;
  if (execution.code !== 0 || state.error) return `DSH 执行失败（退出码 ${execution.code}），详情见诊断日志。`;
  if (state.finish !== 'completed') return 'DSH 未记录已完成的会话结束事件。';
  return null;
}

async function reportPackedSkills({ context, calls, discovered, issue, artifactDir, report }) {
  if (!context) {
    await report('skill', 'blocked', 'DSH Skill 包准备失败。', artifacts);
    return null;
  }
  const inventory = [...context.entries.values()].map(({ name, packId, path, sha256: fingerprint }) => ({
    name, packId, path, sha256: fingerprint,
    discovered: Boolean(discovered?.has(name)) || calls.some((call) => call.name === name && call.method === 'skill-tool'),
  }));
  const proof = await buildSkillEvidence(context, inventory, calls);
  await writeFile(join(artifactDir, proofFile), JSON.stringify(proof, null, 2) + '\n');
  const count = proof.packs.flatMap(({ skills }) => skills).filter(({ verified }) => verified).length;
  const unchanged = proof.packs.every(({ skills }) => skills.every((skill) => skill.unchanged));
  const missing = proof.packs.filter(({ skills }) => !skills.some((skill) => skill.verified)).map(({ title }) => title);
  await report('skill', issue ? 'blocked' : unchanged && !missing.length ? 'pass' : 'fail',
    `DSH 已验证 ${count} 项 Skill 正文。${missing.length ? `缺少 ${missing.join('、')} 的正文证据。` : ''}${unchanged ? '' : '有 Skill 文件发生变化。'}`, skillArtifacts);
  return proof;
}

async function reportFixtureSkill({ workspace, artifactDir, original, offered, skillMode, issue, state, report }) {
  const current = await regularFile(resolve(workspace, skillPath));
  const unchanged = offered ? Boolean(current.bytes?.equals(original.bytes)) : !current.present;
  const activation = state.skillCalls.find(({ method }) => method === 'skill-tool');
  const verified = state.skillCalls.find(({ bodyVerified }) => bodyVerified);
  const noEvidence = issue ? 'unknown' : 'not-observed';
  const proof = { activation: activation ? 'observed' : noEvidence,
    read: verified ? 'verified' : noEvidence, method: verified?.method ?? activation?.method ?? null };
  await writeFile(join(artifactDir, proofFile), JSON.stringify({
    path: skillPath, skillMode, ...proof, sessionId: state.sessionId, unchanged,
    sha256: original.bytes ? sha256(original.bytes) : null, calls: state.skillCalls,
  }, null, 2) + '\n');
  const altered = !unchanged || (!offered && state.skillCalls.length > 0);
  const status = altered ? 'fail' : issue ? 'blocked' : offered && !verified ? 'fail' : 'pass';
  const summary = altered ? '运行中发现 Skill 文件变化或对照组出现 Skill 读取。' : issue ? 'DSH 未完成，Skill 读取证据不完整。'
    : offered ? verified ? 'DSH 原生事件已核验本轮 Skill 正文。' : '未观察到可核验的 DSH Skill 正文读取。'
      : '对照组 Skill 文件缺席，未观察到读取。';
  await report('skill', status, summary, skillArtifacts);
  return proof;
}

export async function runDsh({ workspace, artifactDir, report, prompt = taskPrompt, onEvent = () => {},
  projectCase = null, skillToken = null, skillMode = skillToken ? 'with' : 'without', protectedFiles = projectCase?.protectedFiles ?? [] }) {
  workspace = await realpath(workspace);
  const fixtureFile = resolve(workspace, skillPath);
  const original = projectCase ? null : await regularFile(fixtureFile);
  if (original && (skillToken ? !original.bytes?.includes(skillToken) : original.present)) {
    throw new Error('DSH 工作区中的 Skill 文件与评测条件不一致。');
  }
  const packProfile = projectCase?.skillProfile ?? 'none';
  await report('agent', 'running', '正在运行 DeepSeek Harness。');
  if (original || packProfile !== 'none') await report('skill', 'running', '正在收集 DSH 原生 Skill 事件。');

  const stateDir = await mkdtemp(join(await realpath(tmpdir()), 'vibe-bench-dsh-'));
  let execution = null;
  let version = null;
  let issue;
  let secret;
  let model;
  let context;
  let discovered;
  let observations = trackDshRun(workspace, new Map());
  try {
    model = getModelConfig();
    secret = await getModelApiKey(model);
    if (!secret && !model.allowNoApiKey) throw new Error('DSH 缺少模型 API 密钥，请检查评测台的模型配置。');
    const command = await dshCommand();
    context = await prepareSkills(workspace, packProfile, projectCase?.skillLocks);
    await preparePackedMarkers(context);
    const entries = context?.entries ?? new Map(original ? [[skillName, {
      name: skillName, file: fixtureFile, path: skillPath, token: skillToken,
    }]] : []);
    observations = trackDshRun(workspace, entries);
    const baseline = await protectedSnapshot(workspace, protectedFiles);
    const env = await isolatedEnv(stateDir, context?.openspecBin);
    const versionOutput = await versionCommand(command.executable, [...command.prefix, '--version'], {
      cwd: workspace, env, timeout: 5000, windowsHide: true,
    });
    version = redactOutput(versionOutput.stdout.trim(), secret);
    const patch = join(stateDir, 'bench.cordis.patch.yml');
    const sessionDirectory = join(stateDir, 'sessions');
    const roots = context?.paths ?? (original ? [dirname(dirname(fixtureFile))] : []);
    await writeFile(patch, JSON.stringify(providerPatch(model, roots, sessionDirectory)), { mode: 0o600 });
    const workflow = context ? (await readFile(context.instructions, 'utf8')).trim() : '';
    execution = await invoke({ command, patch, workspace, artifactDir, env: { ...env, [keyEnv]: secret || keylessPlaceholder },
      prompt: workflow ? `${prompt}\n\n${workflow}` : prompt, secret, observations, onEvent });
    issue = runIssue(execution, observations.state);
    if (context) discovered = await readDshCatalog(sessionDirectory, observations.state.sessionId).catch(() => null);
    const after = await protectedSnapshot(workspace, protectedFiles);
    const altered = after.filter(([, hash], index) => hash === 'unreadable' || hash !== baseline[index][1]).map(([file]) => file);
    if (altered.length) issue ??= redactOutput(`DSH 运行中验收资产发生变化（${altered.join('、')}）。`, secret);
  } catch (error) {
    issue = error.signal || error.code ? 'DSH CLI 无法启动或无法保存本次运行日志。' : redactOutput(error.message, secret);
  } finally {
    await rm(stateDir, { recursive: true, force: true, maxRetries: 3 }).catch((error) => {
      console.error(`DSH 临时状态清理失败（${error.code ?? 'UNKNOWN'}）。`);
    });
  }

  for (const file of [stdoutFile, stderrFile]) {
    const path = join(artifactDir, file);
    if (!(await isFile(path))) await writeFile(path, file === stderrFile && issue ? `${issue}\n` : '', { mode: 0o600 });
  }
  await writeFile(join(artifactDir, configFile), JSON.stringify({
    version, model: model && redactOutput(model.model, secret), modelProvider: model?.preset,
    baseURL: model && redactOutput(model.displayBaseURL, secret),
    apiStyle: model?.apiStyle, reasoningEffort: model?.reasoningEffort, timeoutMs, execution,
    auth: secret ? 'project-api-key' : model?.allowNoApiKey ? 'local-endpoint-placeholder-bearer' : 'missing',
    permissionMode: 'workspace-write', profile: 'headless', skillProfile: packProfile,
    sessionId: observations.state.sessionId, finishReason: observations.state.finish,
  }, null, 2) + '\n', { mode: 0o600 });
  await report('agent', issue ? 'error' : 'pass', issue ?? 'DSH 完成实现轮次。', artifacts);
  const skillEvidence = original ? await reportFixtureSkill({ workspace, artifactDir, original, offered: Boolean(skillToken),
    skillMode, issue, state: observations.state, report }) : packProfile !== 'none'
    ? await reportPackedSkills({ context, calls: observations.state.skillCalls, discovered, issue, artifactDir, report }) : null;
  return { ok: !issue, skillEvidence, sessionId: observations.state.sessionId };
}
