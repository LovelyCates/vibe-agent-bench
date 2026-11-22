import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { discoverProjectOpenCode, listProjectFiles } from './cases.mjs';
import { getModelApiKey, getModelConfig } from './model-config.mjs';
import { nativeFixtureDirectory, normalizeNativeFixtures } from './native-case-draft.mjs';
import { openNativeOpenCode } from './native-opencode.mjs';
import { redactOutput, runProjectChecks } from './project-run.mjs';
import { digest, diffFrom, readTree, stageFiles } from './testtarget-workspace.mjs';

const launcherFile = '.opencode/.tools/openspec.mjs';
const toolFiles = ['.opencode/.tools/package.json', '.opencode/.tools/package-lock.json'];
const artifact = (file, label) => ({ file, label });
const caseFile = artifact('case-input.json', '审核版本与原生项目快照');
const promptFile = artifact('task-prompt.txt', '本轮发送给 Agent 的输入');
const proofFile = artifact('skill-proof.json', '项目 Skill 正文读取证据');
const diffFile = artifact('candidate.diff', '候选工作区差异');
const transcriptFile = artifact('target-conversation.json', '原生会话和工具记录');
const approvalFile = artifact('target-approvals.json', '本轮审批凭证');
const expectationFile = artifact('native-case-evidence.json', '预期与判定证据');

const slashes = (value) => value.replaceAll('\\', '/');
const usesApproval = (testCase) => testCase.native.expectation.writePolicy === 'proposal-only';
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const inside = (root, path) => {
  const child = relative(root, path);
  return child !== '..' && !child.startsWith('..' + sep) && !isAbsolute(child);
};
const inPaths = (file, paths) => paths.some((entry) => samePath(file, entry)
  || samePath(file.slice(0, entry.length + 1), entry + '/'));
const fixturePath = (name) => `${nativeFixtureDirectory}/${name}`;

export function nativeCaseCheckTitles(testCase) {
  const commands = (phase) => testCase.commands.filter((command) => command.phase === phase).map(({ id, label }) => [id, label]);
  return [['workspace', '项目快照与原生配置'], ...commands('setup'), ['agent', '原生 OpenCode 会话'],
    ['skill', '原生 Skill 正文核验'], ...(usesApproval(testCase) ? [['approval', '审批与写入边界']] : []),
    ['integrity', '保护资产完整性'], ['native-expectation', '预期与判定证据'], ...commands('verify')];
}

async function projectFiles(root) {
  const files = new Set(await listProjectFiles(root));
  // The project-local OpenSpec launcher may intentionally ignore its dependency manifests.
  if (files.has(launcherFile)) {
    for (const file of toolFiles) {
      const path = join(root, file);
      if ((await lstat(path).catch((error) => {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
        throw error;
      }))?.isFile()) files.add(file);
    }
  }
  return [...files].sort();
}

function hashFiles(files) {
  const hash = createHash('sha256');
  for (const [file, bytes] of files) hash.update(JSON.stringify([file, digest(bytes)]) + '\n');
  return hash.digest('hex');
}

function validateCatalog(files, reviewed, current, requiredReads) {
  if (reviewed.digest !== current.digest || ![...reviewed.configs, ...reviewed.skills].every(({ path, sha256 }) =>
    files.has(path) && digest(files.get(path)) === sha256)) {
    throw new Error('项目的 OpenCode 配置或 Skill 正文自审核后已有变化，请重新审核用例。');
  }
  if (!requiredReads.every(({ path, sha256 }) => files.has(path) && digest(files.get(path)) === sha256)) {
    throw new Error('本轮要求读取的项目规范自审核后已有变化，请重新审核用例。');
  }
}

async function recreateSkillLinks(root, workspace, files) {
  for (const link of ['.agents/skills', '.opencode/.agents/skills', '.opencode/skills', '.claude/skills']) {
    const source = join(root, link);
    if (!(await lstat(source).catch(() => null))?.isSymbolicLink()) continue;
    const destination = await realpath(source).catch(() => null);
    if (!destination || !inside(root, destination)) continue;
    const target = slashes(relative(root, destination));
    if (!target || ![...files.keys()].some((file) => file.startsWith(target + '/'))) continue;
    const location = join(workspace, link);
    await mkdir(dirname(location), { recursive: true });
    await symlink(join(workspace, target), location, process.platform === 'win32' ? 'junction' : 'dir');
  }
}

function dependencyRoot(command) {
  const [first, directory] = command.args;
  if (!/^(?:npm|pnpm|yarn)$/u.test(command.program)) return null;
  if (first !== '--prefix') return '.';
  if (typeof directory !== 'string' || !/^[\w.-]+(?:\/[\w.-]+)*$/u.test(directory)
    || directory.split('/').some((part) => part === '..' || part === '.')) return null;
  return directory;
}

async function copyLocalDependencies(root, workspace, files, commands) {
  const installRoots = new Set(commands.filter(({ phase }) => phase === 'setup').map(dependencyRoot));
  const roots = new Set(commands.filter(({ phase }) => phase === 'verify').map(dependencyRoot));
  if (files.has(launcherFile)) roots.add('.opencode/.tools');
  const staged = [];
  for (const directory of roots) {
    if (!directory || installRoots.has(directory)) continue;
    const manifest = directory === '.' ? '' : directory + '/';
    if (!files.has(manifest + 'package-lock.json')) continue;
    const source = join(root, directory, 'node_modules');
    if (!(await lstat(source).catch(() => null))?.isDirectory() || !inside(root, await realpath(source))) continue;
    // Local dependencies stay inside the candidate, including on projects with their own tests.
    await cp(source, join(workspace, directory, 'node_modules'), {
      recursive: true,
      filter: async (path) => {
        const file = slashes(relative(source, path));
        return !file.split('/').some((part) => ['.vite', '.vite-temp', '.cache'].includes(part))
          && !/(?:^|\/)(?:\.env(?:\.[^/]+)?|\.npmrc|\.netrc|auth\.json|credentials\.json|[^/]+\.(?:pem|key|p12|pfx))$/iu.test(file)
          && !(await lstat(path)).isSymbolicLink();
      },
    });
    staged.push(directory);
  }
  return staged;
}

function commandFiles(command) {
  return command.args.map((arg) => slashes(arg).replace(/^\.\//u, ''));
}

function protectedAssets(files, testCase) {
  const locked = new Set([...testCase.native.discovery.configs, ...testCase.native.discovery.skills].map(({ path }) => path));
  const commands = new Set(testCase.commands.filter(({ phase }) => phase === 'verify').flatMap(commandFiles));
  return [...files.keys()].filter((file) => locked.has(file) || commands.has(file) || inPaths(file, [nativeFixtureDirectory]) ||
    /(?:^|\/)(?:package(?:-lock)?\.json|[\w-]+\.lock(?:b)?|pnpm-lock\.yaml|\.gitignore|AGENTS\.md|(?:eslint|vitest|playwright)\.config\.[cm]?[jt]s)$/u.test(file)
    || /(?:^|\/)(?:__tests__|tests|test)\/|\.(?:spec|test)\.[^.]+$/u.test(file));
}

function stageOpenCodeConfig(bytes, key) {
  const config = redactOutput(bytes.toString('utf8'), key);
  if (/"\$schema"\s*:/u.test(config)) return Buffer.from(config);
  const opened = /^(?:\uFEFF|\s|\/\/[^\r\n]*|\/\*[\s\S]*?\*\/)*\{/u.exec(config)?.[0];
  if (!opened) return Buffer.from(config);
  // OpenCode 1.19.6 writes its schema hint on first load. Add the default to
  // the isolated copy before measuring changes made by Agent tools.
  const body = config.slice(opened.length);
  const separator = /^(?:\s|\/\/[^\r\n]*|\/\*[\s\S]*?\*\/)*\}/u.test(body) ? '' : ',';
  return Buffer.from(opened + '\n  "$schema": "https://opencode.ai/config.json"' + separator + body);
}

export async function stageNativeProject(testCase, workspace, key) {
  const root = await realpath(testCase.projectDir);
  if (relative(testCase.projectDir, root)) throw new Error('项目目录已移动，请重新生成审核草稿。');
  const [source, catalog] = await Promise.all([
    projectFiles(root).then((paths) => readTree(root, paths)), discoverProjectOpenCode(root),
  ]);
  validateCatalog(source, testCase.native.discovery, catalog, testCase.native.requiredReadLocks ?? []);
  const configPaths = new Set(catalog.configs.map(({ path }) => path));
  const entries = [...source].map(([file, bytes]) => [file, configPaths.has(file) && /^(?:\.opencode\/)?opencode\.jsonc?$/iu.test(file)
    ? stageOpenCodeConfig(bytes, key) : bytes]);
  await mkdir(workspace, { recursive: true });
  await stageFiles(workspace, entries);
  const fixtureFiles = normalizeNativeFixtures(testCase.native.fixtureFiles);
  if (fixtureFiles.length) {
    await mkdir(join(workspace, nativeFixtureDirectory));
    for (const { name, content } of fixtureFiles) {
      await writeFile(join(workspace, fixturePath(name)), content, { flag: 'wx', mode: 0o600 });
    }
  }
  await recreateSkillLinks(root, workspace, source);
  return { sha256: hashFiles(source), files: [...source.keys()],
    fixtures: fixtureFiles.map(({ name, content }) => ({ path: fixturePath(name), sha256: digest(content) })),
    dependencies: await copyLocalDependencies(root, workspace, source, testCase.commands), catalog };
}

async function takeSnapshot(workspace, before, fixtures = []) {
  const paths = new Set(await projectFiles(workspace));
  if (fixtures.length && (await lstat(join(workspace, nativeFixtureDirectory)).catch(() => null))?.isDirectory()) {
    for (const { path } of fixtures) {
      if ((await lstat(join(workspace, path)).catch(() => null))?.isFile()) paths.add(path);
    }
  }
  const after = await readTree(workspace, [...paths].sort());
  const changes = before ? [...new Set([...before.keys(), ...after.keys()])].sort()
    .filter((file) => !before.get(file) || !after.get(file) || !before.get(file).equals(after.get(file))) : [];
  return { after, changes };
}

function nativePolicy(workspace, before, testCase) {
  const agents = new Set();
  for (const [file, bytes] of before) {
    const markdownAgent = /^\.opencode\/agents?\/([\w-]+)\.md$/u.exec(file)?.[1];
    if (markdownAgent) agents.add(markdownAgent);
    if (!/^(?:\.opencode\/)?opencode\.jsonc?$/u.test(file)) continue;
    const raw = bytes.toString('utf8');
    const agentConfig = /"agent"\s*:\s*\{/u.exec(raw);
    if (agentConfig) {
      // JSONC project configuration is still loaded by OpenCode. Here we only select a
      // narrowly scoped list of read-only reviewer roles from its literal names.
      for (const hit of raw.slice(agentConfig.index).matchAll(/"([\w-]*review(?:er)?[\w-]*)"\s*:\s*\{/giu)) agents.add(hit[1]);
    }
  }
  // Keep the native permission configuration compact on Windows. Every reviewed
  // asset, including nested tests and documentation, is checked again by hash.
  const locked = ['AGENTS.md', 'opencode.json', 'opencode.jsonc', '.opencode/opencode.json', '.opencode/opencode.jsonc',
    '.opencode/plugins/*', '.opencode/plugin/*', '.opencode/.tools/*', '.opencode/skills/*', '.agents/skills/*',
    '.opencode/.agents/skills/*', '.claude/skills/*', nativeFixtureDirectory + '/*',
    '*/package.json', '*/package-lock.json', 'package.json', 'package-lock.json'];
  return {
    protectedPaths: locked,
    commands: testCase.commands,
    subagents: [...agents].filter((name) => /review/iu.test(name) && /^[\w-]{1,64}$/u.test(name)),
    openSpecLaunchers: before.has(launcherFile) ? ['node ' + launcherFile, 'node ./' + launcherFile] : [],
    skillPaths: [...new Set(testCase.native.discovery.skills.map(({ path }) => dirname(dirname(join(workspace, path)))))],
  };
}

function toolParts(turn) {
  return [...(turn?.messages ?? []), ...(turn?.children ?? []).flatMap(({ messages }) => messages ?? [])]
    .flatMap(({ info, parts }) => (parts ?? []).filter(({ type }) => type === 'tool')
      .map((part) => ({ ...part, sessionId: part.sessionID ?? info?.sessionID })));
}

function workPath(workspace, value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const path = value.trim();
  const normalized = slashes(path);
  const rootless = slashes(relative(parse(workspace).root, workspace));
  const absolute = inPaths(normalized, [rootless]) ? resolve(parse(workspace).root, path) : resolve(workspace, path);
  return inside(workspace, absolute) ? slashes(relative(workspace, absolute)) : `工作区外 · ${normalized}`;
}

function partRecord(part, path, time = 'end') {
  return { path, tool: part.tool, callId: part.callID ?? part.id, sessionId: part.sessionId,
    status: part.state?.status, at: part.state?.time?.[time] ?? null };
}

function observedWrites(workspace, parts) {
  return parts.flatMap((part) => {
    if (!['apply_patch', 'edit', 'multiedit', 'write'].includes(part.tool)) return [];
    const input = part.state?.input ?? {};
    const patch = String(input.patchText ?? input.patch ?? '');
    const paths = [input.filePath, input.path, ...[...patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gmu)].map((row) => row[1])];
    return [...new Set(paths.map((path) => workPath(workspace, path)).filter(Boolean))].map((path) => partRecord(part, path, 'start'));
  });
}

function signature(value) {
  return String(value ?? '').replace(/\s+/gu, ' ').trim();
}

function contentMatches(part, text, key) {
  const redact = (value) => signature(redactOutput(value, key));
  const content = redact(String(part.state?.output ?? '').replace(/(?:^|\n)\d+[:|]\s*/gu, '\n'));
  if (!content || !text.trim()) return false;
  if (content.includes(redact(text))) return true;
  if (part.tool !== 'read') return false;
  const lines = text.split(/\r?\n/u).map(redact).filter((line) => line.length >= 30);
  return [...new Set(lines)].filter((line) => content.includes(line)).length >= 2;
}

async function collectProof({ workspace, before, after, declared, inventory, parts, key }) {
  const nativeLocations = new Map();
  for (const item of inventory) {
    if (typeof item.location !== 'string') continue;
    const location = await realpath(item.location).catch(() => null);
    if (location && inside(workspace, location)) nativeLocations.set(item.name, slashes(relative(workspace, location)));
  }
  const nativeReads = [];
  for (const part of parts.filter(({ tool, state }) => tool === 'read' && state?.status === 'completed')) {
    const path = workPath(workspace, part.state?.input?.filePath ?? part.state?.input?.path);
    const source = path && before.get(path);
    if (source && !source.includes(0) && contentMatches(part, source.toString('utf8'), key)) nativeReads.push(partRecord(part, path));
  }
  const skills = declared.skills.map(({ name, path, sha256 }) => {
    const body = before.get(path)?.toString('utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, '').trim() ?? '';
    const discovered = nativeLocations.has(name) && samePath(nativeLocations.get(name), path);
    const calls = [];
    for (const part of parts) {
      if (part.state?.status !== 'completed') continue;
      const isSkill = part.tool === 'skill' && part.state?.input?.name === name && discovered;
      const source = workPath(workspace, part.state?.input?.filePath ?? part.state?.input?.path);
      const isRead = part.tool === 'read' && source && samePath(source, path);
      if (!isSkill && !isRead) continue;
      const evidence = partRecord(part, path);
      calls.push({ name, path, method: isSkill ? 'skill-tool' : 'file-read', bodyVerified: contentMatches(part, body, key),
        evidence: evidence.callId, sessionId: evidence.sessionId, finishedAt: evidence.at });
    }
    return { name, path, sha256, discovered, loaded: calls.length > 0, verified: calls.some(({ bodyVerified }) => bodyVerified),
      unchanged: before.get(path)?.equals(after.get(path) ?? Buffer.alloc(0)) ?? false, calls };
  });
  return { nativeReads, proof: { profile: 'native-project', packs: [
    { id: 'native-project', title: '项目自带 Skill', version: '已审核的项目快照', skills },
  ] } };
}

function summarizeTurn(turn, key) {
  const render = (messages) => (messages ?? []).map(({ info, parts }) => ({
    role: info?.role, id: info?.id, sessionId: info?.sessionID, model: info?.modelID, provider: info?.providerID,
    ...(info?.error && { error: info.error.name }),
    parts: (parts ?? []).filter((part) => part.type === 'tool' || part.type === 'text').map((part) =>
      part.type === 'text' ? { type: part.type, text: redactOutput(String(part.text ?? ''), key).slice(0, 4000) }
        : { type: part.type, tool: part.tool, id: part.callID ?? part.id, status: part.state?.status,
          input: redactOutput(JSON.stringify(part.state?.input ?? {}), key).slice(0, 1000),
          output: redactOutput(String(part.state?.output ?? part.state?.error ?? ''), key).slice(0, 3200) }),
  }));
  return { messages: render(turn?.messages), children: (turn?.children ?? []).map(({ session, messages }) => ({
    sessionId: session?.id, parentId: session?.parentID, title: session?.title, messages: render(messages),
  })) };
}

function check(id, title, pass, success, failure) {
  return { id, title, status: pass ? 'pass' : 'fail', summary: pass ? success : failure };
}

export function completedChildSessions(turn, parentId) {
  if (!parentId) return [];
  const completed = new Map();
  for (const { session, messages } of turn?.children ?? []) {
    if (typeof session?.id !== 'string' || session.parentID !== parentId || session.id === parentId) continue;
    const final = messages?.findLast(({ info }) => info?.role === 'assistant');
    if (final?.info?.sessionID === session.id && !final.info.error && Number.isFinite(final.info.time?.completed)
      && final.parts?.some(({ type, text }) => type === 'text' && typeof text === 'string' && text.trim())) {
      completed.set(session.id, { sessionId: session.id, parentId, completedAt: final.info.time.completed });
    }
  }
  return [...completed.values()];
}

function permissionCheck(rules, changes, writes, approved) {
  const paths = rules.writePolicy === 'proposal-only' && approved ? rules.postApprovalPaths ?? [] : rules.paths;
  const outside = (path) => {
    if (rules.writePolicy === 'none') return true;
    if (rules.writePolicy === 'proposal-only' && !approved) return !inPaths(path, paths);
    return path.startsWith('工作区外 · ') || (paths.length > 0 && !inPaths(path, paths)
      && !(approved && inPaths(path, rules.paths)));
  };
  const violations = [...new Set([...changes, ...writes.map(({ path }) => path)].filter(outside))];
  return check('write-boundary', '写入边界', !violations.length, '实际文件差异和原生写入尝试均符合审核边界。',
    '发现越界文件或写入尝试：' + violations.slice(0, 10).join('、'));
}

function chronologyChecks({ rules, changes, writes, skills, nativeReads, approved }) {
  const checks = [];
  const implementationChanges = changes.filter((path) => rules.writePolicy !== 'proposal-only' || !inPaths(path, rules.paths));
  const implementationWrites = writes.filter(({ path, status }) => status === 'completed'
    && (rules.writePolicy !== 'proposal-only' || !inPaths(path, rules.paths)));
  const firstWrite = implementationWrites.filter(({ at }) => Number.isFinite(at)).sort((a, b) => a.at - b.at)[0] ?? null;
  const unknownWriteOrder = implementationWrites.some(({ at }) => !Number.isFinite(at)) || implementationChanges.some((file) =>
    !implementationWrites.some(({ path }) => samePath(file, path)));
  if (rules.requireChange) {
    const applicable = rules.writePolicy === 'proposal-only' && !approved ? changes : implementationChanges;
    checks.push(check('required-change', '预期产物', applicable.length > 0, '已捕获要求的项目文件变化。', '未发现要求的项目文件变化。'));
  }
  if (rules.skillBeforeWrite || rules.requiredReads?.length) {
    const preWrite = (at) => !unknownWriteOrder && firstWrite && Number.isFinite(at) && at < firstWrite.at;
    const missingSkills = rules.skillBeforeWrite ? rules.expectedSkills.filter((name) => !skills.find((skill) => skill.name === name)
      ?.calls.some(({ bodyVerified, finishedAt }) => bodyVerified && preWrite(finishedAt))) : [];
    const missingReads = (rules.requiredReads ?? []).filter((path) => !nativeReads.some((read) => samePath(read.path, path) && preWrite(read.at))
      && !skills.some((skill) => samePath(skill.path, path) && skill.calls.some(({ bodyVerified, finishedAt }) => bodyVerified && preWrite(finishedAt))));
    const missing = [...missingSkills, ...missingReads];
    checks.push(check('before-write', '先取证再改代码', !missing.length, '要求的项目规范正文在第一次实现写入前已经核验。',
      (firstWrite && !unknownWriteOrder ? '缺少写入之前的正文证据：' : '无法核对实现写入的顺序：') + missing.join('、')));
  }
  return { checks, firstWrite };
}

function saveEvidence(artifactDir, evidence, data) {
  return writeFile(join(artifactDir, evidence.file), JSON.stringify(data, null, 2) + '\n');
}

export async function executeNativeProjectCase({ testCase, run, workspace, artifactDir, report, getCheck, onEvent, recordSkillEvidence }) {
  const { native, prompt, commands } = testCase;
  const { expectation: rules, discovery } = native;
  run.nativeCase ??= { scenario: native.scenario, expected: native.expected, approvals: [] };
  const metadata = run.nativeCase;
  const stateDir = join(dirname(workspace), 'native-case-state');
  const config = getModelConfig();
  const key = await getModelApiKey(config);
  metadata.model = config.model;
  let staged;

  await report('workspace', 'running', '复制已审核的项目配置和 Skill 到隔离工作区。');
  try {
    staged = await stageNativeProject(testCase, workspace, key);
    metadata.snapshot = staged.sha256;
    await saveEvidence(artifactDir, caseFile, { caseId: testCase.id, version: testCase.version, title: testCase.title,
      projectDir: testCase.projectDir, profile: testCase.profile, agent: 'opencode', model: config.model, provider: config.preset,
      baselineSha256: staged.sha256, files: staged.files, fixtures: staged.fixtures, dependencies: staged.dependencies, commands,
      native: { ...native, ...(native.fixtureFiles && { fixtureFiles: native.fixtureFiles.map(({ name, content }) => ({ name, content: redactOutput(content, key) })) }) } });
    await writeFile(join(artifactDir, promptFile.file), redactOutput(prompt, key));
    await report('workspace', 'pass', `已复制 ${staged.files.length} 个文件；项目原生配置和 Skill 的审核摘要一致。`, [caseFile, promptFile]);
  } catch (error) {
    await report('workspace', 'error', redactOutput(error.message, key));
    metadata.verdict = 'blocked';
    return { blocker: '无法准备已审核的原生项目快照。' };
  }

  const executeChecks = (selected) => runProjectChecks({ workspace, artifactDir, stateDir: join(stateDir, 'commands'),
    commands: selected, report, onEvent });
  const setup = await executeChecks(commands.filter(({ phase }) => phase === 'setup'));
  if (!setup.ok) {
    metadata.verdict = 'blocked';
    return { blocker: '准备命令未通过。' };
  }
  const fixtures = staged.fixtures;
  const { after: before } = await takeSnapshot(workspace, undefined, fixtures);
  if (fixtures.some(({ path, sha256 }) => !before.has(path) || digest(before.get(path)) !== sha256)) {
    await report('integrity', 'fail', '准备命令改动了已审核的测试资料。');
    metadata.verdict = 'blocked';
    return { blocker: '测试资料与已审核版本不一致。' };
  }
  const protect = protectedAssets(before, testCase);
  const signal = AbortSignal.timeout(1_200_000);
  let inventory = [];
  let opencode;
  let turn;
  let sessionError;
  let approved = false;
  let gateCheck;
  const gateIds = new Set(native.gateCommandIds ?? []);

  async function approve(status, summary, proposalHash) {
    const entry = { stage: 'proposal', status, summary, at: new Date().toISOString(), sessionId: opencode?.id,
      ...(proposalHash && { proposalHash }) };
    metadata.approvals.push(entry);
    await saveEvidence(artifactDir, approvalFile, metadata.approvals);
    await report('approval', ['approved', 'withheld'].includes(status) ? 'pass' : status === 'pending' ? 'running' : 'fail', summary, [approvalFile]);
    await onEvent({ kind: 'phase', phase: 'agent', checkId: 'approval', status: getCheck('approval').status, summary, detail: entry });
  }

  await report('agent', 'running', '正在启动项目自己的 OpenCode 会话。');
  await report('skill', 'running', '等待原生 Skill 清单和实际正文返回。');
  try {
    if (!key && !config.allowNoApiKey) throw new Error('先在模型配置中启用可供 OpenCode 使用的模型凭据。');
    opencode = await openNativeOpenCode({ workspace, stateDir: join(stateDir, 'opencode'), config, key, signal, onEvent,
      policy: nativePolicy(workspace, before, testCase) });
    metadata.sessionId = opencode.id;
    inventory = await opencode.inventory();
    if (usesApproval(testCase)) await approve('pending', '已发送提案输入，等待第一轮原生结果。');
    turn = await opencode.turn(prompt);
    if (turn.answer?.info?.error) throw new Error(`OpenCode 原生会话返回 ${turn.answer.info.error.name ?? '执行错误'}。`);

    if (usesApproval(testCase)) {
      const proposal = await takeSnapshot(workspace, before, fixtures);
      const boundary = permissionCheck(rules, proposal.changes, observedWrites(workspace, toolParts(turn)), false);
      const files = proposal.changes.filter((path) => inPaths(path, rules.paths) && proposal.after.get(path)?.length);
      const missing = (rules.approvalFiles ?? []).filter((file) => !files.includes(file));
      const protectedChanged = proposal.changes.some((file) => protect.includes(file));
      const hash = files.length ? hashFiles(new Map(files.map((file) => [file, proposal.after.get(file)]))) : null;
      const needsProposal = Boolean(rules.requireChange || native.confirmationPrompt);
      const canCheck = boundary.status === 'pass' && !missing.length && !protectedChanged && (!needsProposal || files.length > 0);
      const gateResult = canCheck ? await executeChecks(commands.filter(({ id }) => gateIds.has(id))) : null;
      const untouchedByGate = !gateResult?.results.length || !(await takeSnapshot(workspace, proposal.after, fixtures)).changes.length;
      const pass = canCheck && gateResult?.ok && untouchedByGate;
      const failure = boundary.status === 'fail' ? boundary.summary : protectedChanged ? '审批前有受保护资产变化。'
        : missing.length ? '审批所需的提案文件缺失或没有新增变化：' + missing.join('、')
          : !untouchedByGate ? '审批判定命令修改了候选文件。' : !gateResult?.ok && canCheck ? '独立审批检查未通过。'
            : '未看到审核要求的提案产物。';
      gateCheck = check('proposal-gate', '独立审批门禁', pass, '审批前文件边界和批准条件符合已审核预期。', failure);
      if (!pass) await approve('blocked', failure, hash);
      else if (!native.confirmationPrompt) await approve('withheld', '按审核条件停在提案，未发送确认。', hash);
      else {
        approved = true;
        await approve('approved', '审批门禁通过，在同一原生会话发送已审核的确认输入。', hash);
        turn = await opencode.turn(native.confirmationPrompt);
        if (turn.answer?.info?.error) throw new Error(`OpenCode 原生确认轮次返回 ${turn.answer.info.error.name ?? '执行错误'}。`);
      }
    }
  } catch (error) {
    sessionError = error;
    turn = error.partialTurn ?? turn;
    if (usesApproval(testCase) && metadata.approvals.at(-1)?.status === 'pending') {
      await approve('blocked', '执行中断，评测未发送后续批准。');
    }
  } finally {
    await opencode?.close().catch((error) => { sessionError ??= error; });
  }

  const { after, changes } = await takeSnapshot(workspace, before, fixtures);
  const parts = toolParts(turn);
  const writes = observedWrites(workspace, parts);
  const { proof, nativeReads } = await collectProof({ workspace, before, after, declared: discovery, inventory, parts, key });
  const skills = proof.packs[0].skills;
  const verified = skills.filter(({ verified }) => verified);
  await saveEvidence(artifactDir, proofFile, proof);
  await recordSkillEvidence?.(proof);
  await saveEvidence(artifactDir, transcriptFile, summarizeTurn(turn, key));
  await writeFile(join(artifactDir, diffFile.file), redactOutput(diffFrom(before, after, changes), key));

  const missing = rules.expectedSkills.filter((name) => !verified.some((skill) => skill.name === name));
  const forbidden = rules.forbiddenSkills.filter((name) => skills.some((skill) => skill.name === name && skill.loaded)
    || parts.some(({ tool, state }) => tool === 'skill' && state?.input?.name === name && state?.status === 'completed'));
  const usableTurn = !sessionError && Boolean(turn?.answer);
  const skillSummary = `${verified.length} 项正文核验。` + (missing.length ? '缺少：' + missing.join('、') + '。' : '')
    + (forbidden.length ? '违反未触发预期：' + forbidden.join('、') + '。' : '');
  await report('skill', usableTurn ? missing.length || forbidden.length ? 'fail' : 'pass' : 'blocked', skillSummary, [proofFile, transcriptFile]);
  await report('agent', usableTurn ? 'pass' : 'error', sessionError ? redactOutput(sessionError.message, key)
    : usableTurn ? '原生会话完成，已保存回复和工具事件。' : '没有获得完整的原生模型回复。', [transcriptFile, diffFile, caseFile]);

  const altered = protect.filter((file) => changes.includes(file));
  await report('integrity', altered.length ? 'fail' : 'pass', altered.length ? '既有验收或规范资产发生变化：' + altered.slice(0, 8).join('、')
    : '已核对既有测试、依赖清单与项目原生规范。', [diffFile]);

  const chronology = chronologyChecks({ rules, changes, writes, skills, nativeReads, approved });
  const checks = [check('skills', 'Skill 正文与误触发', !missing.length && !forbidden.length, skillSummary, skillSummary),
    permissionCheck(rules, changes, writes, approved), ...chronology.checks, ...(gateCheck ? [gateCheck] : [])];
  const childSessions = completedChildSessions(turn, metadata.sessionId);
  if (rules.minChildSessions) {
    const summary = `实际完成 ${childSessions.length} 个原生子会话，预期至少 ${rules.minChildSessions} 个。`;
    checks.push(check('child-session-count', '确认子会话实际完成', childSessions.length >= rules.minChildSessions, summary, summary));
  }
  let verifyChanges = [];
  if (usableTurn && !altered.length && gateCheck?.status !== 'fail') {
    const verify = await executeChecks(commands.filter(({ phase, id }) => phase === 'verify' && !gateIds.has(id)));
    checks.push(...verify.results.map(({ id, status, summary }) => ({ id, status, summary,
      title: commands.find((command) => command.id === id).label })));
    if (verify.results.length) {
      ({ changes: verifyChanges } = await takeSnapshot(workspace, after, fixtures));
      if (verifyChanges.length) {
        const summary = '独立验收命令改变了候选文件：' + verifyChanges.slice(0, 8).join('、');
        await report('integrity', 'fail', summary, [diffFile]);
        checks.push({ id: 'verify-output-integrity', title: '验收副作用', status: 'fail', summary });
      }
    }
  }
  const evidence = { scenario: native.scenario, expected: native.expected, checks, changes, verifyChanges,
    writeAttempts: writes, firstWrite: chronology.firstWrite, reads: nativeReads, expectation: rules, childSessions };
  await saveEvidence(artifactDir, expectationFile, evidence);
  const failed = checks.filter(({ status }) => status !== 'pass');
  await report('native-expectation', usableTurn ? failed.length ? 'fail' : 'pass' : 'blocked', failed.length
    ? failed.map(({ summary }) => summary).join(' ') : '已审核的预期与实际证据均匹配。', [expectationFile]);

  metadata.verdict = !usableTurn ? 'blocked' : !failed.length && !altered.length ? 'pass' : 'fail';
  if (!usableTurn) return { skillEvidence: proof, blocker: '原生会话中断，已保存目前能够取得的证据。' };
  if (altered.length || gateCheck?.status === 'fail') return { skillEvidence: proof, blocker: '保护资产或审批边界未通过。' };
  return { skillEvidence: proof };
}
