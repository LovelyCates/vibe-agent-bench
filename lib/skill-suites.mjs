import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { listProjectFiles } from './cases.mjs';
import { inspectNativeProject } from './native-case-draft.mjs';
import { buildSkillSuitePlan, suiteGapFor } from './skill-suite-catalog.mjs';
import { generateSuiteProposals } from './skill-suite-ai.mjs';
import { redactOutput } from './project-run.mjs';

const suiteId = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const fail = (status, message) => Object.assign(new Error(message), { status });

function reviewSignature({ title, prompt, expected, expectation, commands, confirmationPrompt, gateCommandIds, fixtureFiles }) {
  return JSON.stringify([
    title, prompt, expected, expectation?.writePolicy, expectation?.skillBeforeWrite ?? false, expectation?.requireChange ?? false,
    ...['expectedSkills', 'forbiddenSkills', 'paths', 'approvalFiles', 'postApprovalPaths', 'requiredReads'].map((key) => expectation?.[key] ?? []),
    confirmationPrompt ?? '', gateCommandIds ?? [], expectation?.minChildSessions ?? 0, fixtureFiles ?? [],
    (commands ?? []).map(({ id, label, phase, program, args, timeoutMs }) => [id, label, phase, program, args, timeoutMs]),
  ]);
}

function reviewedCriteria({ expectation, commands, gateCommandIds, confirmationPrompt }) {
  const { writePolicy, expectedSkills, forbiddenSkills, paths, requiredReads, requireChange, skillBeforeWrite,
    approvalFiles, postApprovalPaths, minChildSessions = 0 } = expectation;
  const result = [];
  if (expectedSkills.length) result.push(`OpenCode 工具返回正文并核验通过：${expectedSkills.join('、')}。`);
  if (forbiddenSkills.length) result.push(`会话没有读取这些 Skill：${forbiddenSkills.join('、')}。`);
  if (writePolicy === 'none') result.push('没有文件变更或越界写入尝试。');
  if (writePolicy === 'proposal-only') {
    result.push(`审批前只允许写入 ${paths.join('、')}。`);
    if (approvalFiles.length) result.push(`审批前产出 ${approvalFiles.join('、')}。`);
    result.push(confirmationPrompt ? '门禁通过后在同一会话发送确认。' : '会话停在首轮，无确认消息。');
    if (confirmationPrompt && postApprovalPaths.length) result.push(`确认后的实现范围限于 ${postApprovalPaths.join('、')}。`);
  }
  if (writePolicy === 'allow' && paths.length) result.push(`实现改动限于 ${paths.join('、')}。`);
  if (requireChange) result.push('候选工作区有符合范围的实际改动。');
  if (skillBeforeWrite) result.push('首次实现写入前，已完成必读 Skill 的正文核验。');
  if (requiredReads.length) result.push(`首次实现写入前，已核验所读规范：${requiredReads.join('、')}。`);
  if (minChildSessions) result.push(`独立核对至少 ${minChildSessions} 个成功的原生子会话。`);
  for (const { id, phase, label } of commands) {
    if (phase === 'verify') result.push(`${gateCommandIds.includes(id) ? '审批门禁' : '独立验收'}通过：${label}。`);
  }
  return result.length ? result : ['原生会话执行完成，评测台保留会话及工作区完整性证据。'];
}

function hydrateRow(row, member) {
  if (!row.caseId) return row;
  if (!member?.native) return { ...row, caseId: null, reason: '此场景的用例草稿不可用。' };
  const { native } = member;
  const actual = {
    title: member.title, prompt: member.prompt, expected: native.expected, expectation: native.expectation,
    expectedSkills: native.expectation.expectedSkills, forbiddenSkills: native.expectation.forbiddenSkills,
    commands: member.commands, gateCommandIds: native.gateCommandIds, confirmationPrompt: native.confirmationPrompt,
    fixtureFiles: native.fixtureFiles ?? [],
  };
  const criteria = reviewSignature(row) === reviewSignature(actual) ? row.criteria : reviewedCriteria(actual);
  return { ...row, ...actual, criteria, caseStatus: member.status, caseVersion: member.version };
}

function coveredSkills(skills, rows) {
  return skills.map(({ name, path }) => {
    const probes = rows.filter(({ expectedSkills }) => expectedSkills?.includes(name));
    return {
      name, path, sceneKeys: probes.map(({ key }) => key),
      runnableSceneKeys: probes.filter(({ caseId, reason }) => caseId && !reason).map(({ key }) => key),
      negativeSceneKeys: rows.filter(({ forbiddenSkills }) => forbiddenSkills?.includes(name)).map(({ key }) => key),
    };
  });
}

export async function openSkillSuites(directory, { cases }) {
  const root = resolve(directory);
  await mkdir(root, { recursive: true });
  const suites = new Map();
  const building = new Map();
  const proposing = new Set();
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const id = entry.name.slice(0, -5);
    if (!entry.isFile() || !entry.name.endsWith('.json') || !suiteId.test(id)) continue;
    try {
      const suite = JSON.parse(await readFile(join(root, entry.name), 'utf8'));
      if (suite?.id === id && suite.parentCaseId === id && Array.isArray(suite.rows)
        && Array.isArray(suite.groups) && Array.isArray(suite.discovery?.skills)) suites.set(id, suite);
    } catch (error) {
      if (error.code !== 'ENOENT') console.error(`读取 Skill 场景清单 ${id} 失败。`);
    }
  }

  const parentFor = (id) => cases.get(id)?.skillSuite?.parentCaseId ?? id;
  function get(id) {
    const suite = suites.get(parentFor(id));
    if (!suite) return null;
    const rows = suite.rows.map((row) => {
      const current = hydrateRow(row, row.caseId ? cases.get(row.caseId) : undefined);
      const gap = current.gap ?? suiteGapFor(current);
      return gap ? { ...current, gap } : current;
    });
    return structuredClone({ ...suite, rows, coverage: coveredSkills(suite.discovery.skills, rows) });
  }

  async function persist(suite) {
    const destination = join(root, suite.id + '.json');
    const temporary = join(root, `${suite.id}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(suite, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
    suites.set(suite.id, suite);
  }

  async function generate(id, { projectDir, files, discovery }, createDrafts) {
    if (!discovery.skills.length) throw fail(400, '项目里没有发现可审核的 OpenCode Skill。');
    const { groups, rows: plan } = buildSkillSuitePlan(discovery, files);
    const rows = await createDrafts(plan);
    await persist({ id, parentCaseId: id, projectDir, discovery, groups, rows, createdAt: new Date().toISOString() });
    return get(id);
  }

  async function prepareParent(id) {
    const parent = cases.get(id);
    if (!parent) throw fail(404, '找不到这个项目用例。');
    if (parent.profile === 'sample') throw fail(400, '请选择要审核 Skill 的本地项目。');
    const projectDir = await realpath(parent.projectDir).catch((error) => {
      if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) throw fail(400, '项目目录不可读取。');
      throw error;
    });
    if (relative(parent.projectDir, projectDir)) throw fail(409, '项目路径已变更，请按当前路径创建用例。');
    const files = await listProjectFiles(projectDir);
    const discovery = await inspectNativeProject(projectDir, files);
    return { projectDir, files, discovery };
  }

  async function build(id) {
    const prepared = await prepareParent(id);
    return generate(id, prepared, (plan) => cases.createSuiteDrafts(id, plan, prepared));
  }

  function proposalMessage(body, row, gap, key) {
    if (body.message !== undefined && typeof body.message !== 'string') throw fail(400, '请用文字描述要补的场景。');
    const message = body.message?.trim() || (row && (gap?.aiPrompt || row.prompt)) || '';
    if (!message || message.length > 1800 || message.includes('\0')) throw fail(400, '请输入要补的场景，最多 1800 字。');
    return redactOutput(message, key);
  }

  async function proposeFromRequest(caseId, body, snapshot) {
    const id = parentFor(caseId);
    const current = suites.get(id);
    if (!current || !cases.get(id)) throw fail(404, '找不到测试用例组。');
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail(400, '请描述要补的测试场景。');
    const row = body.rowKey === undefined ? null : current.rows.find(({ key }) => body.rowKey === key);
    if (body.rowKey !== undefined && (!row || row.caseId || !row.reason)) throw fail(400, '请选择一个暂时不能运行的用例。');
    const gap = row ? row.gap ?? suiteGapFor(row) : null;
    const message = proposalMessage(body, row, gap, snapshot?.key);
    if (proposing.has(id)) throw fail(409, '此组用例正在生成，请稍后再试。');
    proposing.add(id);
    try {
      const prepared = await prepareParent(id);
      if (!prepared.discovery.skills.length) throw fail(400, '项目里没有发现可审核的 OpenCode Skill。');
      const requestKey = createHash('sha256').update(JSON.stringify([row?.key, message, prepared.discovery.digest, prepared.files])).digest('hex').slice(0, 16);
      const previous = current.aiRequests?.find(({ key }) => requestKey === key);
      if (previous) return { suite: get(id), summary: previous.summary };
      const { proposals, analysis, steps } = await generateSuiteProposals({ prepared, message, row, gap, snapshot, prefix: requestKey });
      return await cases.createSuiteDrafts(id, proposals, prepared, async (drafts) => {
        const proposalKeys = drafts.map(({ key }) => key);
        const runnable = drafts.filter(({ caseId }) => caseId).length;
        const pending = drafts.length - runnable;
        const summary = [runnable ? `新增 ${runnable} 条待审核用例` : '', pending ? `记录 ${pending} 条尚缺条件的方案` : ''].filter(Boolean).join('，') + '。';
        const repair = { summary, analysis, steps, proposalKeys, createdAt: new Date().toISOString() };
        const groups = current.groups.some(({ id }) => id === 'ai-proposals') ? current.groups : [...current.groups, { id: 'ai-proposals', title: '补充的测试用例' }];
        const rows = current.rows.map((item) => item.key === row?.key ? { ...item, repair } : item);
        await persist({ ...current, groups, discovery: prepared.discovery, rows: [...rows, ...drafts],
          aiRequests: [...(current.aiRequests ?? []), { key: requestKey, summary }] });
        return { suite: get(id), summary };
      });
    } finally {
      proposing.delete(id);
    }
  }

  return {
    get,
    has: (id) => suites.has(id),
    proposeFromRequest,
    async createFromProject(body) {
      let stagedId;
      try {
        return await cases.createSuiteRoot(body, (parent, prepared, createDrafts) => {
          stagedId = parent.id;
          return generate(parent.id, prepared, createDrafts);
        });
      } catch (error) {
        if (stagedId) {
          suites.delete(stagedId);
          await rm(join(root, stagedId + '.json'), { force: true }).catch(() => {});
        }
        throw error;
      }
    },
    async create(id) {
      const parent = parentFor(id);
      if (!suiteId.test(parent ?? '')) throw fail(404, '找不到这个项目用例。');
      if (suites.has(parent)) return get(parent);
      if (building.has(parent)) return building.get(parent);
      const operation = build(parent);
      building.set(parent, operation);
      try {
        return await operation;
      } finally {
        building.delete(parent);
      }
    },
  };
}
