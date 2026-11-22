import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTwoFilesPatch } from 'diff';
import { projectAgents } from './agents.mjs';
import { caseCheckTitles, executeProjectCase } from './case-executor.mjs';
import { evaluateWorkspace } from './checks.mjs';
import { requestAdvice, runCodex } from './codex.mjs';
import { runDsh } from './dsh.mjs';
import { withModelSnapshot } from './model-config.mjs';
import { executeNativeProjectCase, nativeCaseCheckTitles } from './native-project-case.mjs';
import { runOpenCode } from './opencode.mjs';
import { eventJournal, readRunJournal, redactLog } from './run-events.mjs';
import { isSampleEditable, skillPath, taskPrompt } from './task.mjs';
import { executeTestTarget, targetCheckTitles, testTargetTrials } from './testtarget.mjs';
import { testTargetSnapshot } from './testtarget-workspace.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = join(root, 'fixture');
const reference = join(root, 'reference');
const adapters = { codex: runCodex, opencode: runOpenCode, dsh: runDsh };
const agentNames = { codex: 'Codex', ...projectAgents };
const trialPlan = [
  { mode: 'codex', skillMode: 'with' },
  { mode: 'codex', skillMode: 'without' },
  { mode: 'opencode', skillMode: 'without' },
  { mode: 'opencode', skillMode: 'with' },
];
const checkTitles = {
  agent: 'Agent 产出',
  skill: 'Skill 读取证据',
  code: '代码规范',
  backend: '后端启动',
  frontend: '前端启动',
  api: 'API 验证',
  browser: '页面联调',
  mutation: '测试辨别力',
};

const diffArtifact = { file: 'candidate.diff', label: '代码差异' };
const trialArtifacts = [
  { file: 'trial-config.json', label: '对照条件与输入摘要' },
  { file: 'task-prompt.txt', label: '原始任务提示词' },
];
const activeStatuses = new Set(['queued', 'running']);
const incompleteStatuses = new Set(['pending', 'running']);
const terminalSummaries = new Map([
  ['completed', '评测结束，验收结果与证据已保存。'],
  ['error', '评测异常终止。'],
]);
const interruptedSummary = '评测台进程中断。可以发起一轮新的评测。';
const pendingExperimentFile = /^\.experiment-([0-9a-f-]{36})\.pending\.json(\.tmp)?$/u;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const persistedGroupId = (run) => run.experimentId ?? run.testTarget?.suiteId ?? run.skillSuite?.batchId;

async function snapshot(directory, folder = '', files = new Map()) {
  for (const entry of await readdir(join(directory, folder), { withFileTypes: true })) {
    const relative = folder ? `${folder}/${entry.name}` : entry.name;
    const path = join(directory, relative);
    if (entry.isDirectory()) {
      await snapshot(directory, relative, files);
      continue;
    }
    if (files.size >= 300) throw new Error('样例工作区文件数超出 300 个。');
    if (!entry.isFile()) {
      files.set(relative, null);
      continue;
    }
    if ((await lstat(path)).size > 512 * 1024) throw new Error(`文件超出 512 KiB (${relative})。`);
    files.set(relative, await readFile(path));
  }
  return files;
}

function getChanges(before, after) {
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  return paths.filter((path) => {
    const original = before.get(path);
    const candidate = after.get(path);
    return Buffer.isBuffer(original) && Buffer.isBuffer(candidate) ? !original.equals(candidate) : original !== candidate;
  });
}

async function recordTrialInputs(run, artifactDir, before) {
  const baseline = createHash('sha256');
  for (const [file, content] of [...before.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (file === skillPath) continue;
    baseline.update(JSON.stringify([file, content?.length ?? null]));
    if (content) baseline.update(content);
  }
  const trial = {
    experimentId: run.experimentId,
    agent: run.mode,
    skillMode: run.skillMode,
    skillPresentAtStart: before.has(skillPath),
    baselineSha256: baseline.digest('hex'),
    promptSha256: createHash('sha256').update(taskPrompt).digest('hex'),
  };
  await writeFile(join(artifactDir, 'trial-config.json'), JSON.stringify(trial, null, 2) + '\n');
  await writeFile(join(artifactDir, 'task-prompt.txt'), taskPrompt);
}

function renderDiff(changes, before, after) {
  return changes.map((path) => createTwoFilesPatch(
    before.has(path) ? `a/${path}` : '/dev/null',
    after.has(path) ? `b/${path}` : '/dev/null',
    before.get(path)?.toString('utf8') ?? '',
    after.get(path) === null ? '[非普通文件]\n' : after.get(path)?.toString('utf8') ?? '',
  )).join('');
}

function blockPending(run, summary) {
  for (const check of run.checks) {
    if (incompleteStatuses.has(check.status)) Object.assign(check, { status: 'blocked', summary });
  }
}

export async function openRuns(runsDir, { captureModel, testTargetDir } = {}) {
  await mkdir(runsDir, { recursive: true });
  const runs = new Map();
  const writes = new Map();
  let active = false;

  async function writeSnapshot(path, data) {
    await writeFile(`${path}.tmp`, data);
    await rename(`${path}.tmp`, path);
  }

  function save(run) {
    const path = join(runsDir, run.id, 'run.json');
    const data = JSON.stringify(run, null, 2);
    const writing = (writes.get(run.id) ?? Promise.resolve()).catch(() => {}).then(() => writeSnapshot(path, data));
    writes.set(run.id, writing);
    return writing.finally(() => {
      if (writes.get(run.id) === writing) writes.delete(run.id);
    });
  }

  async function rollbackAdmission(ids, marker) {
    await Promise.all(ids.map((id) => rm(join(runsDir, id), { recursive: true, force: true, maxRetries: 3 })));
    if (marker) {
      await rm(`${marker}.tmp`, { force: true });
      await rm(marker, { force: true });
    }
  }

  async function restoreFinalEvent(run, summary, interrupted) {
    const directory = join(runsDir, run.id);
    const { events: previous, needsSeparator } = await readRunJournal(directory);
    if (!interrupted && !previous.length) return;
    const terminal = previous.findLast(({ kind, phase, status }) => kind === 'run' && phase === 'run' && terminalSummaries.has(status));
    if (terminal?.status === run.status) return;
    const emit = eventJournal(directory, previous.at(-1)?.seq ?? 0, { separateFirstLine: needsSeparator });
    await emit({ kind: 'run', phase: 'run', status: run.status, summary });
  }

  const entries = await readdir(runsDir, { withFileTypes: true });
  const uncommitted = new Set();
  for (const entry of entries) {
    const match = entry.isFile() && entry.name.match(pendingExperimentFile);
    if (!match || !uuid.test(match[1])) continue;
    const [, experimentId, temporary] = match;
    const marker = join(runsDir, entry.name);
    try {
      if (temporary) {
        await rm(marker, { force: true });
        continue;
      }
      uncommitted.add(experimentId);
      const ids = JSON.parse(await readFile(marker, 'utf8'));
      if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length
        || !ids.every((id) => typeof id === 'string' && uuid.test(id))) {
        throw new Error('实验的待提交记录无效。');
      }
      await Promise.all(ids.map(async (id) => {
        const data = await readFile(join(runsDir, id, 'run.json'), 'utf8').catch((error) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        if (data === null) return;
        const run = JSON.parse(data);
        if (run?.id !== id || persistedGroupId(run) !== experimentId) throw new Error(`运行 ${id} 不属于该实验。`);
      }));
      await rollbackAdmission(ids, marker);
    } catch (error) {
      console.error(`恢复实验 ${experimentId} 失败。`, redactLog(error.message));
    }
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/u.test(entry.name)) continue;
    let run;
    try {
      run = JSON.parse(await readFile(join(runsDir, entry.name, 'run.json'), 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') console.error(`读取运行 ${entry.name} 失败。`, error.message);
      continue;
    }
    if (run?.id !== entry.name || !Array.isArray(run.checks) || !run.advice || uncommitted.has(persistedGroupId(run))) continue;
    if (!run.skillEvidence && run.checks.some((check) => check.id === 'skill' && check.artifacts?.some(({ file }) => file === 'skill-proof.json'))) {
      const file = join(runsDir, entry.name, 'artifacts', 'skill-proof.json');
      const proof = await readFile(file, 'utf8').then((value) => JSON.parse(value)).catch(() => null);
      if (Array.isArray(proof?.packs)) run.skillEvidence = proof;
    }
    const interrupted = activeStatuses.has(run.status);
    let persisted = true;
    if (interrupted) {
      run.status = 'error';
      run.finishedAt = new Date().toISOString();
      blockPending(run, interruptedSummary);
      if (incompleteStatuses.has(run.advice.status)) Object.assign(run.advice, { status: 'blocked', summary: interruptedSummary });
      await save(run).catch((error) => {
        persisted = false;
        console.error(run.id, redactLog(error.message));
      });
    }
    if (persisted && terminalSummaries.has(run.status)) {
      const summary = interrupted ? interruptedSummary : terminalSummaries.get(run.status);
      await restoreFinalEvent(run, summary, interrupted).catch((error) => console.error(run.id, redactLog(error.message)));
    }
    runs.set(run.id, run);
  }

  async function finish(run, status, onEvent) {
    const terminal = { ...run, status, finishedAt: new Date().toISOString() };
    let summary = terminalSummaries.get(status);
    let kind = 'run';
    try {
      await save(terminal);
    } catch (error) {
      console.error(run.id, redactLog(error.stack));
      terminal.status = 'error';
      summary = '无法保存评测结果。';
      try {
        await save(terminal);
      } catch (failure) {
        console.error(run.id, redactLog(failure.stack));
        kind = 'notice';
      }
    }
    Object.assign(run, terminal);
    await onEvent({ kind, phase: 'run', status: run.status, summary }).catch((error) => console.error(run.id, redactLog(error.message)));
  }

  async function execute(run, artifactDir, testCase, nativeBaseline) {
    const onEvent = eventJournal(join(runsDir, run.id));
    const phases = new Map((testCase?.commands ?? []).map(({ id, phase }) => [id, phase]));
    const getCheck = (id) => run.checks.find((item) => item.id === id);
    let tempRoot, temp;
    let finalStatus = 'error';
    async function report(id, status, summary, artifacts) {
      const check = getCheck(id);
      if (!check) throw new Error(`未知的验收项 ${id}`);
      const now = new Date();
      if (status === 'running' && !check.startedAt) check.startedAt = now.toISOString();
      if (!incompleteStatuses.has(status) && !check.finishedAt) {
        check.finishedAt = now.toISOString();
        if (check.startedAt) check.durationMs = now.getTime() - Date.parse(check.startedAt);
      }
      Object.assign(check, { status, summary: redactLog(summary) });
      if (artifacts) check.artifacts = artifacts;
      await save(run);
      const phase = id === 'workspace' ? 'workspace' : ['agent', 'skill'].includes(id) ? 'agent' : phases.get(id) ?? 'verify';
      await onEvent({ kind: 'check', phase, checkId: id, status, summary: check.summary,
        durationMs: check.durationMs, artifacts: check.artifacts });
    }

    async function blockUnfinished(summary) {
      for (const check of run.checks.filter(({ status }) => incompleteStatuses.has(status))) {
        await report(check.id, 'blocked', summary);
      }
    }

    try {
      await onEvent({ kind: 'run', phase: 'run', status: 'queued', summary: '评测任务已入队。' });
      run.status = 'running';
      run.startedAt = new Date().toISOString();
      await save(run);
      await onEvent({ kind: 'run', phase: 'run', status: 'running', summary: '评测任务开始执行。' });
      tempRoot = await realpath(tmpdir());
      temp = await mkdtemp(join(tempRoot, 'vibe-bench-'));
      const workspace = join(temp, 'candidate');
      if (run.testTarget) {
        await executeTestTarget({ run, baseline: await nativeBaseline, workspace, artifactDir, report, getCheck, onEvent });
        run.testTarget.verdict ??= 'fail';
      } else if (testCase) {
        const executeCase = testCase.native ? executeNativeProjectCase : executeProjectCase;
        const result = await executeCase({ testCase, run, workspace, artifactDir, report, onEvent, getCheck,
          recordSkillEvidence: (evidence) => {
            run.skillEvidence = evidence;
            return save(run);
          },
        });
        if (result.skillEvidence) run.skillEvidence = result.skillEvidence;
        if (result.blocker) await blockUnfinished(result.blocker);
      } else {
        await executeFixture(run, workspace, artifactDir, report, onEvent, blockUnfinished);
      }
      await blockUnfinished('评测未生成该项的判定。');
      if (run.nativeCase) run.nativeCase.verdict ??= run.checks.every(({ status }) => ['pass', 'skipped'].includes(status)) ? 'pass' : 'fail';

      if (run.mode !== 'demo' && (!run.testTarget || run.testTarget.trialId.startsWith('order-'))) {
        run.advice = { status: 'running', summary: '正在根据当轮证据生成建议。', items: [], artifacts: [] };
        await save(run);
        await onEvent({ kind: 'phase', phase: 'advice', status: 'running', summary: run.advice.summary });
        const scenario = run.nativeCase ? { title: redactLog(run.caseTitle), expected: redactLog(run.nativeCase.expected) }
          : run.testTarget ? { title: run.testTarget.title, condition: run.testTarget.condition } : undefined;
        run.advice = await requestAdvice({ checks: run.checks, artifactDir, scenario,
          onRetry: () => onEvent({ kind: 'notice', phase: 'advice', status: 'running', summary: '审阅服务连接中断，正在重试。' }),
        });
      } else {
        run.advice = { status: run.testTarget ? 'skipped' : 'blocked',
          summary: run.testTarget ? '专项用例的判定由独立验收和原生会话证据完成。' : '演示只运行确定性检查。', items: [], artifacts: [] };
      }
      await onEvent({ kind: 'phase', phase: 'advice', status: run.advice.status, summary: run.advice.summary, artifacts: run.advice.artifacts });
      finalStatus = 'completed';
    } catch (error) {
      const summary = `评测流程中断（${redactLog(error.message)}）`;
      if (run.testTarget) run.testTarget.verdict ??= 'blocked';
      if (run.nativeCase) run.nativeCase.verdict ??= 'blocked';
      console.error(run.id, redactLog(error.stack));
      await blockUnfinished(summary).catch(() => blockPending(run, summary));
      if (incompleteStatuses.has(run.advice.status)) run.advice = { status: 'blocked', summary, items: [], artifacts: [] };
      await onEvent({ kind: 'notice', phase: 'run', status: 'error', summary }).catch(console.error);
    } finally {
      if (temp && dirname(resolve(temp)) === tempRoot && basename(temp).startsWith('vibe-bench-')) {
        void rm(temp, { recursive: true, force: true, maxRetries: 3 }).catch((error) => {
          console.error(run.id, `评测临时目录清理失败（${error.code ?? 'UNKNOWN'}）。`);
        });
      }
      await finish(run, finalStatus, onEvent);
    }
  }

  async function executeFixture(run, workspace, artifactDir, report, onEvent, blockUnfinished) {
    const hasSkill = run.skillMode === 'with';
    await cp(fixture, workspace, {
      recursive: true,
      filter: (source) => hasSkill || relative(fixture, source) !== '.agents',
    });
    let skillToken = null;
    if (hasSkill) {
      skillToken = `skill-read-${randomBytes(16).toString('hex')}`;
      const skillFile = join(workspace, skillPath);
      const skill = await readFile(skillFile, 'utf8');
      const populated = skill.replace('@@BENCH_SKILL_TOKEN@@', skillToken);
      if (populated === skill) throw new Error('样例 Skill 缺少本轮读取标记的占位符。');
      await writeFile(skillFile, populated);
    }
    const before = await snapshot(workspace);

    let eligible = true;
    if (run.mode === 'demo') {
      await cp(reference, workspace, { recursive: true });
      await report('agent', 'blocked', '演示使用固定参考实现。');
      await report('skill', 'blocked', 'Skill 读取证据在真实 Agent 评测中采集。');
    } else {
      await recordTrialInputs(run, artifactDir, before);
      const result = await adapters[run.mode]({ workspace, artifactDir, skillToken, skillMode: run.skillMode, report, onEvent });
      eligible = result.ok;
      run.skillEvidence = result.skillEvidence;
    }

    const after = await snapshot(workspace);
    const changes = getChanges(before, after);
    await writeFile(join(artifactDir, diffArtifact.file), renderDiff(changes, before, after) || '没有代码变更。\n');
    const agentCheck = run.checks.find((check) => check.id === 'agent');
    const agentArtifacts = [...agentCheck.artifacts, ...(run.mode === 'demo' ? [] : trialArtifacts), diffArtifact];
    if (run.mode !== 'demo' && eligible && changes.length === 0) {
      await report('agent', 'fail', `${agentNames[run.mode]} 完成轮次，工作区没有代码变更。`, agentArtifacts);
      await blockUnfinished('工作区没有实现变更。');
      return;
    }
    await report('agent', agentCheck.status, agentCheck.summary, agentArtifacts);
    const violations = changes.filter((path) => after.get(path) === null || !isSampleEditable(path));
    if (violations.includes(skillPath)) {
      const check = run.checks.find((item) => item.id === 'skill');
      await report('skill', 'fail', '工作区中的 Skill 文件在运行期间发生变化。', check.artifacts);
    }
    if (violations.length) {
      await report('code', 'fail', `发现允许范围外的变更（${violations.join('、')}）。`, [diffArtifact]);
      await blockUnfinished('代码变更超出样例允许的范围。');
    } else if (eligible) {
      await evaluateWorkspace({ workspace, artifactDir, report });
    } else {
      await blockUnfinished(`${agentNames[run.mode]} 未成功完成，缺少可验收的提交。`);
    }
  }

  async function executeGroup(group, caseInputs) {
    // Run one trial per Agent at a time. The two lanes reverse the Skill order.
    const native = group[0]?.testTarget;
    const nativeBaseline = native ? testTargetSnapshot(testTargetDir) : undefined;
    // The same immutable input map is used by every independently staged workspace.
    nativeBaseline?.catch(() => {});
    const lanes = native ? group.map((run) => [run])
      : group[0]?.skillSuite || group.length === 1 ? [group] : Object.keys(adapters).map((mode) => group.filter((run) => run.mode === mode));
    try {
      await Promise.all(lanes.map(async (lane) => {
        for (const run of lane) {
          await execute(run, join(runsDir, run.id, 'artifacts'), caseInputs.get(run.id), nativeBaseline)
            .catch((error) => console.error(run.id, error));
        }
      }));
    } finally {
      active = false;
    }
  }

  async function enqueue(plan, { experimentId = null, testTargetSuiteId, skillSuite } = {}) {
    if (active) return null;
    const createdAt = new Date().toISOString();
    const caseInputs = new Map();
    const group = plan.map(({ mode, skillMode, trial, testCase }) => {
      const id = randomUUID();
      if (testCase) caseInputs.set(id, testCase);
      const titles = trial ? targetCheckTitles(trial.id) : testCase?.native ? nativeCaseCheckTitles(testCase)
        : testCase ? caseCheckTitles(testCase) : Object.entries(checkTitles);
      return {
        id, mode, skillMode, experimentId, skillEvidence: null,
        ...(testCase && { caseId: testCase.id, caseVersion: testCase.version, caseTitle: testCase.title,
          skillProfile: testCase.skillProfile ?? 'none', scenario: testCase.scenario ?? null }),
        ...(testCase?.native && { nativeCase: { scenario: testCase.native.scenario, expected: testCase.native.expected, approvals: [] } }),
        ...(trial && { testTarget: { trialId: trial.id, title: trial.title, condition: trial.condition, suiteId: testTargetSuiteId, approvals: [] } }),
        ...(skillSuite && { skillSuite }),
        status: 'queued', createdAt, startedAt: null, finishedAt: null,
        checks: titles.map(([id, title]) => ({ id, title, status: 'pending', summary: '', artifacts: [] })),
        advice: { status: 'pending', summary: '', items: [], artifacts: [] },
      };
    });
    const groupId = persistedGroupId(group[0]);
    const marker = groupId && join(runsDir, `.experiment-${groupId}.pending.json`);
    const created = [];
    let model;
    active = true;
    try {
      if (captureModel && plan.some(({ mode }) => mode !== 'demo')) model = await captureModel();
      if (testTargetSuiteId && (model?.config?.preset !== 'deepseek' || !model.key)) {
        throw Object.assign(new Error('请在模型配置中启用 DeepSeek 并保存密钥后再运行 TestTarget。'), { status: 409 });
      }
      if (caseInputs.size && model && (model.error || (!model.key && !model.config?.allowNoApiKey))) {
        throw Object.assign(new Error('运行这条用例需要模型。请打开顶部「模型配置」，保存可用的模型后再运行。'), { status: 409 });
      }
      // The marker keeps an incomplete group out of history even if the process stops mid-write.
      if (marker) await writeSnapshot(marker, JSON.stringify(group.map(({ id }) => id)));
      for (const run of group) {
        const directory = join(runsDir, run.id);
        await mkdir(directory);
        created.push(run.id);
        await mkdir(join(directory, 'artifacts'));
        await save(run);
      }
      if (marker) await rm(marker);
    } catch (error) {
      await rollbackAdmission(created, marker).catch((failure) => console.error(redactLog(failure.stack)));
      active = false;
      throw error;
    }
    for (const run of group) runs.set(run.id, run);
    void withModelSnapshot(model, () => executeGroup(group, caseInputs)).catch(console.error);
    return group;
  }

  return {
    list: () => [...runs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    get: (id) => runs.get(id),
    async createCase(testCase) {
      const group = await enqueue([{ mode: testCase.agent ?? 'opencode', skillMode: testCase.profile === 'sample' ? 'without' : null, testCase }]);
      return group?.[0] ?? null;
    },
    async createSkillSuite(caseId, cases) {
      const batchId = randomUUID();
      const group = await enqueue(cases.map((testCase) => ({ mode: 'opencode', skillMode: null, testCase })),
        { skillSuite: { caseId, batchId } });
      return group ? { batchId, runs: group } : null;
    },
    async create(mode, skillMode) {
      const group = await enqueue([{ mode, skillMode: mode === 'demo' ? null : skillMode }]);
      return group?.[0] ?? null;
    },
    async createExperiment() {
      const id = randomUUID();
      const group = await enqueue(trialPlan, { experimentId: id });
      return group ? { id, runs: group } : null;
    },
    async createTestTarget({ suiteId = randomUUID(), trialIds = testTargetTrials.map(({ id }) => id) } = {}) {
      const selected = testTargetTrials.filter(({ id }) => trialIds.includes(id));
      if (!uuid.test(suiteId) || !selected.length || selected.length !== trialIds.length) throw new Error('TestTarget 批次配置无效。');
      const group = await enqueue(selected.map((trial) => ({ mode: 'opencode', skillMode: null, trial })), { testTargetSuiteId: suiteId });
      return group ? { suiteId, runs: group } : null;
    },
  };
}
