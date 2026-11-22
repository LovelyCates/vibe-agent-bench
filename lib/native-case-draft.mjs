import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, matchesGlob, posix, relative, sep } from 'node:path';
import { redactOutput } from './project-run.mjs';

const nativeScenarios = {
  'auto-trigger': 'Skill 自动触发',
  'analysis-only': '只分析不改代码',
  'approval-gate': '提案审批门禁',
  'code-standards': '代码规范落地',
};
const maxNativeFile = 512 * 1024;
const namePattern = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const workflowDocuments = /^(?:AGENTS|VIBE-WORKFLOW)\.md$|^\.opencode\/(?:agents?|commands?|plugins?|rules)\/.+/iu;
const configFile = /^(?:\.opencode\/)?opencode\.jsonc?$/iu;
const nativeSkill = /^(?:\.opencode\/skills?|\.agents\/skills)\//iu;
const defaultChange = 'bench-project-change';

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

function caseText(value, label, maximum, required = false) {
  if (typeof value !== 'string' || value.includes('\0') || value.length > maximum || (required && !value.trim())) {
    throw fail(`${label}${required ? '需要填写且' : ''}限 ${maximum} 字符。`);
  }
  return value.trim();
}

function nativePath(value) {
  if (typeof value !== 'string' || value.length > 320 || /[\\:*?"<>|\u0000-\u001f\u007f]/u.test(value)) return null;
  const path = value.trim().replace(/\/$/u, '');
  return path.split('/').every((part) => part && part !== '.' && part !== '..' && !/[ .]$/u.test(part)) ? path : null;
}

async function readNativeFile(projectDir, file, { optional = false } = {}) {
  const path = join(projectDir, file);
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > maxNativeFile) return null;
    const location = relative(projectDir, await realpath(path));
    if (isAbsolute(location) || location === '..' || location.startsWith('..' + sep) || location.split(sep).join('/') !== file) return null;
    return await readFile(path);
  } catch (error) {
    if (optional && ['ENOENT', 'ENOTDIR'].includes(error.code)) return null;
    throw error;
  }
}

function jsonc(data) {
  const stripped = data.toString('utf8').replace(/^\uFEFF/u, '')
    .replace(/"(?:[^"\\]|\\.)*"|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/gu, (token) => token.startsWith('/') ? ' ' : token)
    .replace(/"(?:[^"\\]|\\.)*"|,(?=\s*[}\]])/gu, (token) => token === ',' ? '' : token);
  try { return JSON.parse(stripped); } catch { return null; }
}

function metadata(contents) {
  const text = contents.toString('utf8').replace(/^\uFEFF/u, '');
  const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text)?.[1];
  const value = (name) => front?.match(new RegExp(`^${name}:[ \\t]*(.+)$`, 'mu'))?.[1].trim().replace(/^['"]|['"]$/gu, '');
  const name = value('name');
  if (!namePattern.test(name ?? '')) return null;
  const short = value('description');
  const description = /^[|>][-+]?$/u.test(short ?? '')
    ? front.match(/^description:[ \t]*[|>][-+]?\r?\n((?:[ \t]+[^\r\n]*(?:\r?\n|$))+)/mu)?.[1].replace(/\s+/gu, ' ').trim()
    : short;
  return { name, description: redactOutput(description ?? '').slice(0, 400) };
}

function standardReferences(path, contents, knownFiles) {
  const links = contents.toString('utf8').matchAll(/\[([^\]]+)\]\(([^)]+)\)/gu);
  return [...new Set([...links].flatMap(([, label, target]) => {
    if (!/(?:规范|约定|standards?|conventions?|style[ -]?guide|guidelines?)/iu.test(label)) return [];
    const location = nativePath(posix.normalize(posix.join(posix.dirname(path), target.split('#')[0])));
    return location && knownFiles.has(location) ? [location] : [];
  }))].slice(0, 8);
}

export async function inspectNativeProject(projectDir, files) {
  const known = new Set(files);
  const configs = new Map();
  const skillRoots = [];
  const instructions = [];
  for (const file of files.filter((path) => configFile.test(path))) {
    const contents = await readNativeFile(projectDir, file);
    if (!contents) continue;
    configs.set(file, { path: file, sha256: sha256(contents) });
    const settings = jsonc(contents);
    const directory = posix.dirname(file);
    const local = (value) => {
      if (typeof value !== 'string' || value.startsWith('/') || value.startsWith('~') || value.includes('\\')) return null;
      return nativePath(posix.normalize(posix.join(directory, value)));
    };
    if (Array.isArray(settings?.skills?.paths)) skillRoots.push(...settings.skills.paths.map(local).filter(Boolean));
    if (Array.isArray(settings?.instructions)) {
      for (const value of settings.instructions) {
        const named = local(value);
        if (named && known.has(named)) instructions.push(named);
        else if (typeof value === 'string' && /[*?]/u.test(value) && !/[:\\\u0000-\u001f]/u.test(value) && !value.startsWith('/')) {
          const pattern = posix.normalize(posix.join(directory, value));
          if (!pattern.startsWith('../')) instructions.push(...files.filter((path) => matchesGlob(path, pattern)));
        }
      }
    }
  }
  const extraConfigs = [...new Set([...files.filter((path) => workflowDocuments.test(path)), ...instructions])].sort();
  for (const file of extraConfigs.slice(0, 200)) {
    const contents = await readNativeFile(projectDir, file);
    if (contents) configs.set(file, { path: file, sha256: sha256(contents) });
  }
  const skills = [];
  const candidates = files.filter((path) => path.endsWith('/SKILL.md') && (nativeSkill.test(path)
    || skillRoots.some((root) => path.startsWith(root + '/'))));
  for (const file of candidates.slice(0, 300)) {
    const contents = await readNativeFile(projectDir, file);
    if (!contents) continue;
    const entry = metadata(contents);
    if (!entry) continue;
    skills.push({ ...entry, path: file, sha256: sha256(contents), references: standardReferences(file, contents, known) });
  }
  for (const file of [...new Set(skills.flatMap(({ references }) => references))].sort()) {
    if (configs.has(file)) continue;
    const contents = await readNativeFile(projectDir, file);
    if (contents) configs.set(file, { path: file, sha256: sha256(contents) });
  }
  const inventory = {
    configs: [...configs.values()].sort((a, b) => a.path.localeCompare(b.path)),
    skills: skills.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path)),
  };
  return { ...inventory, digest: sha256(JSON.stringify(inventory)) };
}

export async function nativeDocumentLocks(projectDir, paths, files) {
  const known = new Set(files);
  return Promise.all(paths.map(async (path) => {
    const contents = known.has(path) && await readNativeFile(projectDir, path);
    if (!contents) throw fail('需要读取的项目文件不存在或不在快照范围，请核对项目相对路径。');
    return { path, sha256: sha256(contents) };
  }));
}

function suggestedTask(skill) {
  const context = `${skill?.name ?? ''} ${skill?.description ?? ''}`;
  if (/frontend|vue|页面|前端/iu.test(context)) return '在现有的可筛选列表为空时显示清晰的空状态，并提供一个可键盘操作的重置筛选入口。保持原有查询、分页和返回行为。';
  if (/backend|api|后端|接口/iu.test(context)) return '为现有的列表查询补充非法筛选值的校验，并补充覆盖合法和非法输入的回归测试。保持已有响应格式。';
  return '选择一个已有的数据列表功能，补充空结果的处理和对应的回归测试。保持其他已有行为。';
}

export function draftNativeCase(input, requirement, discovery, files) {
  if (!isRecord(input) || !Object.hasOwn(nativeScenarios, input.scenario)) throw fail('请选择有效的原生 OpenCode 用例类型。');
  const scenario = input.scenario;
  const approvalCase = scenario === 'approval-gate';
  const analysis = scenario === 'analysis-only';
  const standards = scenario === 'code-standards';
  const names = new Set(discovery.skills.map(({ name }) => name));
  const selected = input.targetSkill === undefined || input.targetSkill === '' ? discovery.skills.find(({ name }) => /(?:frontend|backend)[-\w]*(?:implementation|development)/u.test(name))
    ?? discovery.skills.find(({ name }) => /implementation|development|standards/u.test(name)) ?? discovery.skills[0]
    : discovery.skills.find(({ name }) => name === input.targetSkill);
  if (input.targetSkill && !selected) throw fail('所选 Skill 不在该项目的本地清单中。');
  const workflow = files.find((file) => /(?:^|\/)openspec\/config\.ya?ml$/iu.test(file))?.replace(/\/config\.ya?ml$/iu, '')
    ?? files.find((file) => /(?:^|\/)openspec\/changes\//iu.test(file))?.split('/changes/')[0];
  const planned = Boolean(!analysis && workflow && (approvalCase || (names.has('openspec-propose') && names.has('openspec-apply-change'))));
  const base = planned ? `${workflow}/changes/` : '';
  let changeId = defaultChange;
  for (let index = 2; planned && files.some((path) => path.startsWith(base + changeId + '/')); index++) changeId = `${defaultChange}-${index}`;
  const proposalPath = base ? base + changeId : null;
  const task = requirement || (analysis ? '说明项目中一个已有列表的筛选状态从界面到数据是怎么传递的，并指出相关文件。' : suggestedTask(selected));
  const prompt = analysis ? `${task}\n\n本轮只分析现有实现，汇报定位依据；请保持项目文件原样。`
    : planned ? `${task}\n\n请按项目流程先准备变更提案，变更标识为 ${changeId}。看完方案后我会再回复。`
      : approvalCase ? `${task}\n\n请先在回复中给出方案，等我确认后再实施。`
      : `${task}\n\n沿用项目已有的代码约定，说明实现以及实际运行的检查。`;
  const expectedSkills = analysis ? [] : approvalCase ? (names.has('openspec-propose') ? ['openspec-propose'] : [])
    : [...new Set([...(selected ? [selected.name] : []), ...(planned && names.has('openspec-propose') ? ['openspec-propose'] : [])])];
  const confirmationPrompt = planned && !approvalCase
    ? '确认刚才的提案。请完成实现，运行与本次修改相关的检查，并如实汇报结果。' : '';
  return {
    title: nativeScenarios[scenario], requirement: task, prompt,
    native: {
      scenario,
      expected: analysis ? '解释现有流程并标出定位依据。保留所有项目文件。'
        : approvalCase ? (planned ? '等待提案确认，允许准备提案文件。应用代码、配置和测试保持原样。'
          : '给出方案并等待确认。保留所有项目文件。')
          : standards ? '先读取项目规范，再修改应用代码。独立验证命令通过。'
            : '根据自然语言命中相关 Skill。项目 Skill 正文应有原生工具证据。',
      expectation: {
        expectedSkills,
        forbiddenSkills: analysis && input.targetSkill && selected ? [selected.name] : approvalCase && names.has('openspec-apply-change') ? ['openspec-apply-change'] : [],
        writePolicy: analysis || (approvalCase && !planned) ? 'none' : planned ? 'proposal-only' : 'allow',
        paths: proposalPath ? [proposalPath] : [],
        skillBeforeWrite: standards,
        requireChange: standards,
        approvalFiles: workflow && proposalPath ? ['proposal.md', 'design.md', 'tasks.md'].map((file) => `${proposalPath}/${file}`) : [],
        postApprovalPaths: [],
        requiredReads: standards && selected?.references.length ? selected.references.slice(0, 1) : [],
      },
      confirmationPrompt,
      gateCommandIds: [],
      discovery,
    },
  };
}

function listField(value, label, parse) {
  if (!Array.isArray(value) || value.length > 24) throw fail(`${label}最多填写 24 项。`);
  const items = value.map(parse);
  if (items.some((item) => !item)) throw fail(`${label}包含无效值。`);
  return [...new Set(items)];
}

export const nativeFixtureDirectory = '.vibe-bench-fixtures';

export function normalizeNativeFixtures(fixtures = []) {
  if (!Array.isArray(fixtures) || fixtures.length > 3) throw fail('测试数据文件最多 3 份。');
  const names = new Set();
  return fixtures.map((fixture) => {
    const { name, content } = fixture ?? {};
    if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,58}\.(?:json|md|txt)$/u.test(name)
      || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])\./u.test(name) || names.has(name)
      || typeof content !== 'string' || !content.trim() || content.includes('\0') || content.length > 4096) {
      throw fail('测试数据只接受小型 JSON、Markdown 或文本文件，文件名须唯一。');
    }
    names.add(name);
    if (name.endsWith('.json')) {
      try { JSON.parse(content); } catch { throw fail('测试数据文件必须是有效 JSON。'); }
    }
    return { name, content };
  });
}

export function validateNativeCase(input, original, commands, approve) {
  if (!isRecord(input) || input.scenario !== original.scenario || !isRecord(input.expectation)) {
    throw fail('原生工作流用例配置无效。');
  }
  const { expectation } = input;
  const names = new Set(original.discovery.skills.map(({ name }) => name));
  const knownSkill = (name) => names.has(name) ? name : null;
  const expectedSkills = listField(expectation.expectedSkills, '必须读取的 Skill', knownSkill);
  const forbiddenSkills = listField(expectation.forbiddenSkills, '不能读取的 Skill', knownSkill);
  if (expectedSkills.some((name) => forbiddenSkills.includes(name))) throw fail('同一 Skill 不能同时设为必须读取与不能读取。');
  const paths = listField(expectation.paths, '允许写入的路径', nativePath);
  const approvalFiles = listField(expectation.approvalFiles ?? [], '提案文件', nativePath);
  const postApprovalPaths = listField(expectation.postApprovalPaths ?? [], '确认后允许写入的路径', nativePath);
  const requiredReads = listField(expectation.requiredReads ?? [], '写入前需要读取的文件', nativePath);
  const expected = caseText(input.expected, '预期结果', 8_000, approve);
  const confirmationPrompt = caseText(input.confirmationPrompt ?? '', '确认输入', 8_000);
  const { writePolicy, skillBeforeWrite } = expectation;
  const requireChange = expectation.requireChange ?? false;
  const minChildSessions = expectation.minChildSessions ?? original.expectation.minChildSessions ?? 0;
  if (!Number.isInteger(minChildSessions) || minChildSessions < 0 || minChildSessions > 5) {
    throw fail('子会话验收数量需要填写 0 到 5。');
  }
  const fixtureFiles = normalizeNativeFixtures(original.fixtureFiles);
  if (!['none', 'proposal-only', 'allow'].includes(writePolicy) || typeof skillBeforeWrite !== 'boolean' || typeof requireChange !== 'boolean') {
    throw fail('请选择有效的写入策略和证据条件。');
  }
  if (approve && writePolicy === 'proposal-only' && !paths.length) throw fail('提案阶段必须填写允许写入的项目相对路径。');
  if (approve && writePolicy !== 'proposal-only' && (approvalFiles.length || confirmationPrompt || postApprovalPaths.length)) {
    throw fail('确认和提案文件证据需要使用提案写入策略。');
  }
  if (approve && approvalFiles.some((file) => !paths.some((prefix) => file === prefix || file.startsWith(prefix + '/')))) {
    throw fail('每个提案文件都必须位于提案阶段允许写入的路径下。');
  }
  if (approve && writePolicy === 'none' && (requireChange || skillBeforeWrite || requiredReads.length)) throw fail('禁止写入和写入时序预期不能同时启用。');
  if (approve && (skillBeforeWrite || requiredReads.length) && !requireChange) throw fail('验证写入时序时请同时要求实现改动。');
  if (approve && skillBeforeWrite && !expectedSkills.length) throw fail('验证 Skill 读取先后时至少选择一个必须读取的 Skill。');
  if (approve && input.scenario === 'auto-trigger' && !expectedSkills.length) throw fail('自动触发用例至少需要选择一个应读取的项目 Skill。');
  const verifyIds = new Set(commands.filter(({ phase }) => phase === 'verify').map(({ id }) => id));
  const gateCommandIds = listField(input.gateCommandIds ?? [], '提案门禁命令', (id) => verifyIds.has(id) ? id : null);
  if (approve && writePolicy !== 'proposal-only' && gateCommandIds.length) throw fail('提案门禁命令需要使用提案写入策略。');
  return {
    scenario: original.scenario, expected, confirmationPrompt, gateCommandIds,
    expectation: { expectedSkills, forbiddenSkills, writePolicy, paths, skillBeforeWrite, requireChange, approvalFiles, postApprovalPaths, requiredReads,
      ...(minChildSessions ? { minChildSessions } : {}) },
    ...(fixtureFiles.length ? { fixtureFiles } : {}),
    discovery: original.discovery,
  };
}

export async function inspectNativePackages(projectDir, files) {
  const known = new Set(files);
  const packages = [];
  const candidates = files.filter((file) => /(?:^|\/)package\.json$/u.test(file)
    && !/(?:^|\/)(?:assets?|docs?|examples?|fixtures?|packages-vendored)(?:\/|$)/u.test(file));
  for (const file of candidates.slice(0, 20)) {
    const contents = await readNativeFile(projectDir, file);
    const manifest = contents && jsonc(contents);
    if (!isRecord(manifest) || !isRecord(manifest.scripts)) continue;
    const directory = posix.dirname(file);
    const lockFile = (name) => known.has(posix.join(directory, name));
    packages.push({ directory, manifest, locked: lockFile('package-lock.json') || lockFile('npm-shrinkwrap.json'), pnpm: lockFile('pnpm-lock.yaml') });
  }
  return packages;
}
