import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { projectAgents } from './agents.mjs';
import { listProjectFiles } from './cases.mjs';
import { evaluateWorkspace } from './checks.mjs';
import { runDsh } from './dsh.mjs';
import { runOpenCode } from './opencode.mjs';
import { runProjectChecks } from './project-run.mjs';
import { redactLog } from './run-events.mjs';
import { isSampleEditable } from './task.mjs';

const diffLimit = 900_000;
const previewLimit = 180_000;
const artifact = (file, label) => ({ file, label });
const adapters = { opencode: runOpenCode, dsh: runDsh };
const builtinChecks = [
  ['skill', 'Skill 读取证据'], ['code', '代码规范'], ['backend', '后端启动'], ['frontend', '前端启动'],
  ['api', 'API 验证'], ['browser', '页面联调'], ['mutation', '测试辨别力'],
];

export function caseCheckTitles(testCase) {
  const fromCommands = (phase) => testCase.commands.filter((command) => command.phase === phase)
    .map(({ id, label }) => [id, label]);
  return [
    ['workspace', '项目快照'], ...fromCommands('setup'), ['agent', `${projectAgents[testCase.agent ?? 'opencode']} 产出`],
    ...(testCase.profile === 'sample' ? builtinChecks : [
      ...((testCase.skillProfile && testCase.skillProfile !== 'none') || testCase.scenario ? [['skill', 'Skill 加载与读取']] : []),
      ['integrity', '验收资产完整性'],
      ...(testCase.skillProfile === 'openspec' ? [['workflow', 'OpenSpec 变更与校验']] : []),
      ...fromCommands('verify'),
    ]),
  ];
}

function digest(content) {
  return createHash('sha256').update(content).digest('hex');
}

async function copyProject(testCase, workspace) {
  const original = await realpath(testCase.projectDir);
  if (relative(testCase.projectDir, original)) throw new Error('项目目录已移至其他位置，请重新生成用例。');
  const files = (await listProjectFiles(original))
    .filter((file) => testCase.profile !== 'sample' || !file.startsWith('.agents/'));
  const fingerprint = createHash('sha256');
  await mkdir(workspace, { recursive: true });
  for (const file of files) {
    const from = await realpath(join(original, file));
    if (relative(original, from).split(sep).join('/') !== file) throw new Error(`源文件位置已变更（${file}）。`);
    const to = join(workspace, file);
    await mkdir(dirname(to), { recursive: true });
    await copyFile(from, to);
    fingerprint.update(JSON.stringify([file, digest(await readFile(to))]) + '\n');
  }
  return { files, baselineSha256: fingerprint.digest('hex') };
}

async function snapshot(workspace) {
  const files = await listProjectFiles(workspace);
  const result = new Map();
  for (const file of files) {
    const bytes = await readFile(join(workspace, file));
    const text = bytes.length <= previewLimit && !bytes.includes(0) ? bytes.toString('utf8') : null;
    result.set(file, { sha256: digest(bytes), text });
  }
  return result;
}

function diffSnapshots(before, after) {
  const files = [...new Set([...before.keys(), ...after.keys()])].sort();
  const changes = files.filter((path) => before.get(path)?.sha256 !== after.get(path)?.sha256);
  let patch = '';
  for (const path of changes) {
    const old = before.get(path);
    const updated = after.get(path);
    const from = old ? `a/${path}` : '/dev/null';
    const to = updated ? `b/${path}` : '/dev/null';
    if (old?.text === null || updated?.text === null) {
      patch += `--- ${from}\n+++ ${to}\n文件过大或为二进制，已记录内容变化。\n`;
    } else {
      patch += createTwoFilesPatch(from, to, old?.text ?? '', updated?.text ?? '');
    }
    if (patch.length > diffLimit) {
      patch = patch.slice(0, diffLimit) + '\n后续代码差异已截断。\n';
      break;
    }
  }
  return { changes, patch: redactLog(patch || '没有代码变更。\n') };
}

function verificationAssets(before, commands, scenario) {
  const fixed = new Set(['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', '.gitignore',
    'pyproject.toml', 'pytest.ini', 'vitest.config.js', 'vitest.config.ts', 'playwright.config.js', 'playwright.config.ts']);
  const referenced = commands.filter(({ phase }) => phase === 'verify').flatMap(({ args }) => args);
  for (const path of referenced) fixed.add(path.replaceAll('\\', '/').replace(/^\.\//u, ''));
  if (scenario === 'java-vue-status-filter') {
    for (const file of ['scripts/java-backend.mjs', 'eslint.config.mjs', 'vite.config.mjs', 'openspec/config.yaml']) fixed.add(file);
  }
  return [...before.keys()].filter((path) => fixed.has(path) || /(^|\/)(?:test|tests|__tests__)\//u.test(path) || /\.(?:spec|test)\.[^.]+$/u.test(path));
}

const scenarioOutputs = {
  'test:api': [artifact('api-contract.json', 'HTTP 请求与断言')],
  'test:browser': [artifact('task-board.png', '筛选页面截图'), artifact('task-board-empty.png', '空结果截图')],
  'test:regression': [artifact('regression.json', '缺陷注入结果')],
};

async function collectScenarioOutputs({ workspace, artifactDir, commands, getCheck, report }) {
  for (const command of commands) {
    const outputs = scenarioOutputs[command.args[1]] ?? [];
    const files = [];
    for (const output of outputs) {
      const path = join(workspace, '.bench-results', output.file);
      const actual = await realpath(path).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      });
      if (!actual || relative(path, actual)) continue;
      const file = await stat(actual);
      if (!file.isFile() || file.size > 5 * 1024 * 1024) continue;
      await copyFile(actual, join(artifactDir, output.file));
      files.push(output);
    }
    const check = getCheck(command.id);
    if (files.length) await report(command.id, check.status, check.summary, [...check.artifacts, ...files]);
  }
}

async function evaluateOpenSpec({ changes, after, workspace, artifactDir, stateDir, report, onEvent, getCheck }) {
  const prefix = 'openspec/changes/';
  const changedDocs = changes.filter((path) => path.startsWith(prefix) && after.get(path)?.text && path.endsWith('.md'));
  const groups = new Set(changedDocs.map((path) => path.slice(prefix.length).split('/')[0])
    .filter((name) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name) && name !== 'archive'));
  const change = [...groups].find((name) => {
    const folder = `${prefix}${name}/`;
    return ['proposal.md', 'design.md', 'tasks.md'].every((file) => after.get(folder + file)?.text)
      && changedDocs.some((path) => path.startsWith(`${folder}specs/`) && path.endsWith('/spec.md'));
  });
  if (!change) {
    await report('workflow', 'fail', '未发现同时包含提案、设计、任务及增量规范的 OpenSpec 变更。');
    return;
  }
  const documents = [];
  for (const [index, path] of changedDocs.filter((file) => file.startsWith(`${prefix}${change}/`)).slice(0, 15).entries()) {
    const file = `openspec-${index + 1}-${path.split('/').at(-1)}`;
    await writeFile(join(artifactDir, file), redactLog(after.get(path).text), 'utf8');
    documents.push(artifact(file, path.slice(`${prefix}${change}/`.length)));
  }
  const command = { id: 'workflow', label: 'OpenSpec CLI 校验', phase: 'verify', program: 'node',
    args: ['./node_modules/@fission-ai/openspec/bin/openspec.js', 'validate', change, '--strict'], timeoutMs: 90_000 };
  await runProjectChecks({ workspace, artifactDir, stateDir, commands: [command], report, onEvent });
  const check = getCheck('workflow');
  const tasks = [...after.get(`${prefix}${change}/tasks.md`).text.matchAll(/^\s*[-*]\s+\[([ xX])\]/gmu)];
  const done = tasks.filter((match) => match[1] !== ' ').length;
  const checklistOk = tasks.length > 0 && done === tasks.length;
  const summary = `OpenSpec CLI 严格校验通过（${change}），任务完成 ${done}/${tasks.length}。`;
  await report('workflow', check.status === 'pass' && !checklistOk ? 'fail' : check.status, check.status === 'pass' ? summary : check.summary,
    [...check.artifacts, ...documents]);
}

export async function executeProjectCase({ testCase, workspace, artifactDir, report, onEvent, getCheck, recordSkillEvidence = () => {} }) {
  await report('workspace', 'running', '从所选项目复制隔离工作区。');
  let files;
  try {
    const snapshot = await copyProject(testCase, workspace);
    ({ files } = snapshot);
    await writeFile(join(artifactDir, 'case-input.json'), JSON.stringify({
      caseId: testCase.id, version: testCase.version, title: testCase.title, requirement: testCase.requirement,
      projectDir: testCase.projectDir, profile: testCase.profile, scenario: testCase.scenario ?? null,
      agent: testCase.agent ?? 'opencode',
      skillProfile: testCase.skillProfile ?? 'none', skillLocks: testCase.skillLocks, commands: testCase.commands, ...snapshot,
    }, null, 2) + '\n');
    await writeFile(join(artifactDir, 'task-prompt.txt'), testCase.prompt);
  } catch (error) {
    await report('workspace', 'error', `无法准备项目快照（${redactLog(error.message)}）`);
    return { blocker: '项目快照准备失败。' };
  }
  const inputs = [artifact('case-input.json', '审查版本与起始文件'), artifact('task-prompt.txt', '送给 Agent 的任务')];
  await report('workspace', 'pass', `已复制 ${files.length} 个文件到临时工作区。`, inputs);

  const commands = testCase.commands;
  const stateDir = join(dirname(workspace), 'command-state');
  if (commands.some(({ phase }) => phase === 'setup')) {
    const setup = await runProjectChecks({ workspace, artifactDir, stateDir, commands: commands.filter(({ phase }) => phase === 'setup'), report, onEvent });
    if (!setup.ok) return { blocker: '准备命令未通过。' };
  }
  const before = await snapshot(workspace);
  const sample = testCase.profile === 'sample';
  const agent = testCase.agent ?? 'opencode';
  const agentName = projectAgents[agent];
  const protectedFiles = sample ? [] : verificationAssets(before, commands, testCase.scenario);
  if (testCase.scenario && (testCase.skillProfile ?? 'none') === 'none') {
    await report('skill', 'pass', '本轮为无配置 Skill 对照，原生 Skill 工具未开放。');
  }
  const result = await adapters[agent]({ workspace, artifactDir, skillToken: null, skillMode: 'without', report, protectedFiles,
    prompt: testCase.prompt, onEvent, projectCase: sample ? undefined : { ...testCase, protectedFiles } });
  if (result.skillEvidence) await recordSkillEvidence(result.skillEvidence);
  const after = await snapshot(workspace);
  const { changes, patch } = diffSnapshots(before, after);
  await writeFile(join(artifactDir, 'candidate.diff'), patch);
  const agentCheck = getCheck('agent');
  const agentArtifacts = [...agentCheck.artifacts, artifact('candidate.diff', '代码差异')];
  await report('agent', result.ok && !changes.length ? 'fail' : agentCheck.status,
    result.ok ? `${agentName} 已结束，记录 ${changes.length} 个变化文件。` : agentCheck.summary, agentArtifacts);
  if (!result.ok) return { skillEvidence: result.skillEvidence, blocker: `${agentName} 未成功完成实现。` };
  if (!changes.length) return { skillEvidence: result.skillEvidence, blocker: '工作区没有实现变更。' };

  if (sample) {
    const violations = changes.filter((path) => !isSampleEditable(path));
    if (violations.length) {
      await report('code', 'fail', `发现允许范围外的变更（${violations.join('、')}）。`, [artifact('candidate.diff', '代码差异')]);
      return { skillEvidence: result.skillEvidence, blocker: '代码变更超出样例允许的范围。' };
    }
    await evaluateWorkspace({ workspace, artifactDir, report });
  } else {
    const altered = protectedFiles.filter((path) => before.get(path).sha256 !== after.get(path)?.sha256);
    await writeFile(join(artifactDir, 'verification-assets.json'), JSON.stringify({ altered }, null, 2) + '\n');
    await report('integrity', altered.length ? 'fail' : 'pass', altered.length
      ? `原有验收资产发生变化（${altered.join('、')}）。` : '原有项目测试、清单与执行脚本保持一致。',
    [artifact('verification-assets.json', '验收资产校验')]);
    if (altered.length) return { blocker: '原有验收资产发生变化。' };
    if (testCase.skillProfile === 'openspec') {
      await evaluateOpenSpec({ changes, after, workspace, artifactDir, stateDir, report, onEvent, getCheck });
    }
    const verify = commands.filter(({ phase }) => phase === 'verify');
    if (testCase.scenario === 'java-vue-status-filter') {
      const outputDir = join(workspace, '.bench-results');
      const physicalDir = await realpath(outputDir).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      });
      if (physicalDir && relative(outputDir, physicalDir)) throw new Error('验收输出目录解析到了其他位置。');
      for (const { file } of Object.values(scenarioOutputs).flat()) {
        await rm(join(outputDir, file), { force: true });
      }
    }
    await runProjectChecks({ workspace, artifactDir, stateDir, commands: verify, report, onEvent });
    if (testCase.scenario === 'java-vue-status-filter') {
      await collectScenarioOutputs({ workspace, artifactDir, commands: verify, getCheck, report });
    }
  }
  return { skillEvidence: result.skillEvidence };
}
