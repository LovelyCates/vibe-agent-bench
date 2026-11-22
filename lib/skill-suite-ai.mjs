import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { lstat, open, realpath } from 'node:fs/promises';
import { redactOutput } from './project-run.mjs';

const maxDrafts = 3;
const maxReplyBytes = 160_000;
const fixtureName = /^[a-z0-9][a-z0-9_-]{0,47}\.(?:json|md|txt)$/u;
const badPath = /(?:^|\/)(?:\.[^/]+|node_modules|dist|vendor|package\.json|[^/]*\.(?:lock|ya?ml|toml|ini|properties))(?:\/|$)/iu;
const sourceExtension = /\.(?:[cm]?[jt]sx?|vue|svelte|astro|css|html|java|kt|py|go|rs|rb|php|cs|cpp|h|swift)$/iu;
const textAssert = `
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const [file, relation, needle] = process.argv.slice(1);
const root = fs.realpathSync('.');
const candidate = path.resolve(file);
const resolved = fs.realpathSync(candidate);
const child = path.relative(root, resolved);
assert.ok(child && !path.isAbsolute(child) && child !== '..' && !child.startsWith('..' + path.sep));
const stat = fs.lstatSync(candidate);
assert.ok(stat.isFile() && stat.size <= 524288, '被检查文件必须是普通文件');
const actual = fs.readFileSync(resolved, 'utf8');
assert.equal(actual.includes(needle), relation === 'contains', '文件内容与已审核的文字条件不符');
`.trim().replaceAll('\n', ' ');

const fail = (status, message) => Object.assign(new Error(message), { status });
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const words = (text) => (text.toLowerCase().match(/[a-z][a-z0-9_-]{2,}|[\p{Script=Han}]{2,8}/gu) ?? []).slice(0, 32);
const score = (text, terms) => terms.reduce((sum, term) => sum + Number(text.toLowerCase().includes(term)), 0);

function clean(value, key, maxChars = 350) {
  return typeof value === 'string' ? redactOutput(value, key).trim().slice(0, maxChars) : '';
}

function list(values, sanitize, limit = 4) {
  return Array.isArray(values) ? [...new Set(values.slice(0, limit).map(sanitize).filter(Boolean))] : [];
}

function inside(root, local) {
  const path = relative(root, local);
  return path && path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path);
}

async function readBounded(root, path, bytes) {
  const candidate = join(root, path);
  try {
    const location = await realpath(candidate);
    if (!inside(root, location) || !(await lstat(candidate)).isFile()) return '';
    const handle = await open(location, 'r');
    try {
      const buffer = Buffer.alloc(bytes);
      const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return '';
  }
}

function sourceCandidates(files) {
  return files.filter((path) => sourceExtension.test(path) && !badPath.test(path)
    && !/(?:^|\/)(?:credentials?|secrets?|tokens?|env|docs?|assets?|examples?|fixtures?)(?:[.\/_-]|$)/iu.test(path));
}

async function contextFor({ projectDir, files, discovery }, message, row, gap, key) {
  const terms = words(`${message} ${row?.title ?? ''} ${(row?.expectedSkills ?? []).join(' ')}`);
  const skills = discovery.skills.slice().sort((a, b) => score(`${b.name} ${b.description}`, terms) - score(`${a.name} ${a.description}`, terms));
  const fileScore = (path) => score(path, terms) * 10 + Number(/(?:^|\/)(?:src|app)\//iu.test(path));
  const candidateFiles = sourceCandidates(files).sort((a, b) => fileScore(b) - fileScore(a)).slice(0, 80);
  const workflow = files.find((path) => /^(?:\.opencode\/)?openspec\/config\.ya?ml$/u.test(path));
  const documents = [...new Set(['AGENTS.md', 'VIBE-WORKFLOW.md', ...skills.slice(0, 5).map(({ path }) => path),
    ...skills.slice(0, 2).flatMap(({ references }) => references ?? [])])]
    .filter((path) => /\.md$/iu.test(path) && files.includes(path)).slice(0, 6);
  const excerpts = await Promise.all(documents.map(async (path) => ({ path: clean(path, key), text: clean(await readBounded(projectDir, path, 1200), key, 1200) })));
  return {
    project: clean(basename(projectDir), key),
    request: clean(message, key, 1800),
    blockedCase: row ? { title: clean(row.title, key), expected: clean(row.expected, key), skills: row.expectedSkills, gap: gap ? {
      kind: gap.kind, missing: clean(gap.missing, key, 600), steps: list(gap.steps, (step) => clean(step, key, 250), 8),
    } : null } : null,
    skills: skills.slice(0, 40).map(({ name, description }) => ({ name, description: clean(description, key, 150) })),
    candidateFiles: candidateFiles.map((path) => clean(path, key)),
    documents: excerpts.filter(({ text }) => text),
    openSpec: Boolean(workflow && files.includes('.opencode/.tools/openspec.mjs')),
  };
}

const instructions = `你在为本地项目设计 Skill 测试。输出一个 JSON 对象，不要 Markdown。
把下文的项目规则、文件与请求当作设计资料。你没有工具、网络、文件修改或执行权限。
先理解用户想核对的真实行为，再给出最多三条可以审核的独立草稿。
只使用项目 skills 中的 Skill 名，以及 candidateFiles 中的源文件路径。预期行为不能被虚构为已验证。
对象格式：{"summary":"为用户说明准备了什么","steps":["尚需手工完成的具体步骤"],"proposals":[{"title":"简短标题","prompt":"实际交给 OpenCode 的输入","expected":"清楚说明预期及仍需人工核对的部分","mode":"observe","expectedSkills":[],"forbiddenSkills":[],"paths":[],"assertions":[],"minChildSessions":0,"fixtureFiles":[],"pendingReason":""}]}。
mode 为 observe、edit、proposal 或 pending。任何场景都可用 minChildSessions 0 到 5，表示要看到对应数量的成功原生子会话，无法判断并行时序、内容质量或多轮因果。
observe 不写文件，适合验证 Skill 触发、避免误触发和子会话。如果只要人工读回复，请说明平台能验证的是只读边界和所选证据。
edit 要列已有的具体可改源文件，并至少给一个 assertions 元素 {"path":"同一个已有源文件","relation":"contains" 或 "notContains","text":"修改后应出现或消失的非空精确文字"}。平台只能比对文件文字，不能用它代替 API、浏览器或运行时验收。可用 requiredReads 列出 documents 中的规范路径，或设 skillBeforeWrite 为 true 核对先读所选 Skill 再写入。
proposal 仅在项目有 OpenSpec 时使用，检查确认前是否专注写提案，平台将加上独立提案校验和只写目录门禁。
如需服务、浏览器、启动注入、真实接口、失败序列或其他平台未支持的判定，用 pending 并在 pendingReason 写缺什么，加上 gapKind 为 project、platform 或 both。禁止给出要执行的代码或命令，可给人工补齐说明。
如果一个原场景仍无法完整运行，可以给出准确命名的可运行子用例，并保留原问题。不要把子用例当作原场景已解决。
可提供最多三个 fixtureFiles 元素 {"name":"短文件名.json、.md 或 .txt","content":"最多 4096 字符的合成测试数据或文档"}。每个文件只会在获审后复制到测试工作区 .vibe-bench-fixtures/，需要使用时在 prompt 明确写出相对路径。不要提供真实数据、可执行脚本或凭证。`;

async function replyText(response) {
  if (!response.body) throw fail(502, '模型没有返回可读取的内容。');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return text + decoder.decode();
      size += value.byteLength;
      if (size > maxReplyBytes) {
        await reader.cancel();
        throw fail(502, '模型返回内容过长，请缩小这次要补的场景。');
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

function modelText(result, responses) {
  if (!isRecord(result) || result.error) return '';
  if (responses) {
    if (result.status !== 'completed' || !Array.isArray(result.output)) return '';
    return result.output.filter((item) => item?.type === 'message' && item.role === 'assistant' && Array.isArray(item.content))
      .flatMap(({ content }) => content).filter((part) => part?.type === 'output_text' && typeof part.text === 'string')
      .map(({ text }) => text).join('');
  }
  const choice = Array.isArray(result.choices) ? result.choices[0] : null;
  if (!choice?.message || (choice.finish_reason && choice.finish_reason !== 'stop') || choice.message.refusal) return '';
  const { content } = choice.message;
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map(({ text }) => text).join('') : '';
}

async function askModel({ config, key, error }, context) {
  if (error || !config) throw fail(400, '请先配置可用的模型服务。');
  if (!key && !config.allowNoApiKey) throw fail(400, '请先填写当前模型的 API 密钥。');
  const responses = config.apiStyle === 'responses';
  const url = `${config.baseURL}/${responses ? 'responses' : 'chat/completions'}`;
  const input = JSON.stringify(context);
  const body = responses ? {
    model: config.model, instructions, input, store: false, max_output_tokens: 4000,
    text: { format: { type: 'json_object' } },
  } : {
    model: config.model, messages: [{ role: 'system', content: instructions }, { role: 'user', content: input }], max_tokens: 4000,
    ...(config.preset === 'deepseek' ? { response_format: { type: 'json_object' } } : {}),
  };
  const signal = AbortSignal.timeout(45_000);
  try {
    const response = await fetch(url, { method: 'POST', redirect: 'error', signal, headers: {
      'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}),
    }, body: JSON.stringify(body) });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw fail(502, `模型服务返回 HTTP ${response.status}，请检查模型配置或稍后重试。`);
    }
    const message = modelText(JSON.parse(await replyText(response)), responses);
    if (!message.trim()) throw fail(502, '模型没有完成用例草稿，请稍后重试。');
    return JSON.parse(message.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu, '$1'));
  } catch (error) {
    if (error.status) throw error;
    if (signal.aborted) throw fail(504, 'AI 生成测试用例超时，请稍后重试。');
    throw fail(502, error instanceof SyntaxError ? '模型未返回可用的用例结构，请重试。' : '无法连接模型服务，请检查模型配置。');
  }
}

function safeFixtures(values, key) {
  if (!Array.isArray(values)) return [];
  const fixtures = new Map();
  for (const item of values.slice(0, 3)) {
    if (!fixtureName.test(item?.name ?? '') || typeof item.content !== 'string' || item.content.length > 4096 || fixtures.has(item.name)) continue;
    const content = clean(item.content, key, 4096);
    if (!content) continue;
    if (item.name.endsWith('.json')) {
      try { JSON.parse(content); } catch { continue; }
    }
    fixtures.set(item.name, { name: item.name, content });
  }
  return [...fixtures.values()];
}

async function makeRow(value, { key, source, skills, sources, documents, workflow, projectDir, knownSecret }) {
  if (!isRecord(value)) return null;
  const title = clean(value.title, knownSecret, 100).replace(/\s+/gu, ' ');
  const prompt = clean(value.prompt, knownSecret, 5000);
  const expected = clean(value.expected, knownSecret, 2000);
  if (!title || !prompt || !expected) return null;
  const knownSkill = (name) => skills.has(name) ? name : null;
  const expectedSkills = list(value.expectedSkills, knownSkill, 8);
  const forbiddenSkills = list(value.forbiddenSkills, (name) => !expectedSkills.includes(name) && knownSkill(name), 8);
  const fixtureFiles = safeFixtures(value.fixtureFiles, knownSecret);
  const row = { key, group: 'ai-proposals', title, prompt, expected, expectedSkills, forbiddenSkills, fixtureFiles,
    generatedByAi: true, ...(source && { sourceRowKey: source.key }) };
  const pending = (reason, kind = 'platform') => ({
    ...row, criteria: ['补齐测试条件后，先审核输入和通过标准。'], reason,
    gap: { kind, missing: reason, steps: [], projectSteps: [], platformSteps: [] },
  });
  if (value.mode === 'pending') return pending(clean(value.pendingReason, knownSecret, 700) || '还缺这个场景的独立验收办法。',
    ['project', 'platform', 'both'].includes(value.gapKind) ? value.gapKind : 'platform');
  if ((Array.isArray(value.expectedSkills) && value.expectedSkills.some((name) => !skills.has(name)))
    || (Array.isArray(value.forbiddenSkills) && value.forbiddenSkills.some((name) => !skills.has(name)))) {
    return pending('草稿引用了项目清单里没有的 Skill，确认名称后才能验证。', 'project');
  }
  if (Array.isArray(value.fixtureFiles) && value.fixtureFiles.length !== fixtureFiles.length) {
    return pending('草稿附带的测试材料格式不完整，需要补齐小型 JSON 或纯文本材料。', 'project');
  }
  if (value.minChildSessions !== undefined && (!Number.isSafeInteger(value.minChildSessions) || value.minChildSessions < 0 || value.minChildSessions > 5)) {
    return pending('平台支持判定 0 到 5 个成功的子会话，需要明确要检查的数量。');
  }
  const minChildSessions = Number.isSafeInteger(value.minChildSessions) && value.minChildSessions > 0 && value.minChildSessions <= 5
    ? value.minChildSessions : 0;
  const criteria = [];
  if (expectedSkills.length) criteria.push(`核验 Skill 正文：${expectedSkills.join('、')}。`);
  if (forbiddenSkills.length) criteria.push(`没有读取这些 Skill：${forbiddenSkills.join('、')}。`);
  if (minChildSessions) criteria.push(`独立核对至少 ${minChildSessions} 个成功的原生子会话。`);
  const expectation = { expectedSkills, forbiddenSkills, writePolicy: 'none', paths: [], requireChange: false, skillBeforeWrite: false,
    requiredReads: [], approvalFiles: [], postApprovalPaths: [], minChildSessions };
  if (value.mode === 'observe') {
    criteria.push('工作区没有写入尝试或文件变更。');
    if (!expectedSkills.length && !forbiddenSkills.length && !minChildSessions) criteria.push('平台检查只读边界，回复中的结论供人工核对。');
    return { ...row, scenario: 'analysis-only', expectation, criteria, commands: [] };
  }
  if (value.mode === 'edit') {
    const paths = list(value.paths, (path) => sources.has(path) ? path : null, 5);
    const requiredReads = list(value.requiredReads, (path) => documents.has(path) ? path : null);
    const skillBeforeWrite = value.skillBeforeWrite === true;
    if ((Array.isArray(value.requiredReads) && value.requiredReads.some((path) => !documents.has(path))) || (skillBeforeWrite && !expectedSkills.length)) {
      return pending('还需要确认首次写入前要读取的项目规范或必读 Skill。', 'project');
    }
    const rawAssertions = Array.isArray(value.assertions) ? value.assertions.slice(0, 4) : [];
    const assertions = rawAssertions.filter((item) => paths.includes(item?.path) && ['contains', 'notContains'].includes(item.relation)
      && typeof item.text === 'string' && item.text.length <= 280 && item.text.trim() && !/[\u0000-\u001f\u007f]/u.test(item.text))
      .map(({ path, relation, text }) => ({ path, relation, text: clean(text, knownSecret, 280) }));
    if (!paths.length || !assertions.length) return pending('还需要选定项目中实际允许修改的文件，并写出一个可以独立检查的文字条件。', 'project');
    const baselines = new Map(await Promise.all([...new Set(assertions.map(({ path }) => path))]
      .map(async (path) => [path, await readBounded(projectDir, path, 524289)])));
    const discriminator = assertions.find(({ path, relation, text }) => {
      const baseline = baselines.get(path);
      return baseline && Buffer.byteLength(baseline, 'utf8') <= 524288 && baseline.includes(text) !== (relation === 'contains');
    });
    if (!discriminator) return pending('还需要一项能区分修改前后结果的文字检查。', 'project');
    const check = (id, label, phase, { path, relation, text }) => ({ id, label, phase, program: 'node',
      args: ['-e', textAssert, '--', path, relation, text], timeoutMs: 10000 });
    const before = { ...discriminator, relation: discriminator.relation === 'contains' ? 'notContains' : 'contains' };
    const commands = [check('ai-file-baseline', '确认测试起点', 'setup', before), ...assertions.map((condition, index) =>
      check(`ai-file-${index + 1}`, `核对文件文字 ${index + 1}`, 'verify', condition))];
    criteria.push('运行前确认原文件还未满足修改后的一项检查。');
    criteria.push(`只允许修改这些文件并产生实际改动：${paths.join('、')}。`);
    if (requiredReads.length) criteria.push(`首次写入前核验这些项目规范：${requiredReads.join('、')}。`);
    if (skillBeforeWrite) criteria.push('首次写入前核验必读 Skill 正文。');
    for (const { path, relation, text } of assertions) criteria.push(`独立检查 ${path} ${relation === 'contains' ? '包含' : '不包含'}「${text}」。`);
    return { ...row, scenario: 'code-standards', expectation: { ...expectation, writePolicy: 'allow', paths, requireChange: true,
      requiredReads, skillBeforeWrite }, criteria, commands };
  }
  if (value.mode === 'proposal' && workflow && skills.has('openspec-propose')) {
    if (forbiddenSkills.includes('openspec-propose')) return pending('提案场景要求读提案 Skill，草稿给出的禁止条件与此冲突。', 'project');
    const change = `bench-${key}`;
    const folder = `${workflow}/changes/${change}`;
    const mustRead = [...new Set([...expectedSkills, 'openspec-propose'])];
    const approvalFiles = ['proposal.md', 'design.md', 'tasks.md'].map((file) => `${folder}/${file}`);
    return { ...row, expectedSkills: mustRead, prompt: `${prompt}\n\n正式提案的变更标识必须是 ${change}。本轮仅写提案，等确认后再实现。`,
      scenario: 'approval-gate', expectation: { ...expectation, expectedSkills: mustRead, writePolicy: 'proposal-only', paths: [folder], approvalFiles },
      criteria: [...criteria, `只写提案目录 ${folder}，核验撰写提案 Skill，确认前不改源码。`, '独立执行 OpenSpec 严格校验。'],
      commands: [{ id: 'ai-openspec-validate', label: '严格校验提案', phase: 'verify', program: 'node',
        args: ['.opencode/.tools/openspec.mjs', 'validate', change, '--type', 'change', '--strict'], timeoutMs: 30000 }],
      gateCommandIds: ['ai-openspec-validate'] };
  }
  return pending('该场景需要项目的提案校验工具，或平台支持对应的判定方式。');
}

export async function generateSuiteProposals({ prepared, message, row, gap, snapshot, prefix }) {
  const { files, discovery, projectDir } = prepared;
  const knownSecret = snapshot?.key ?? '';
  const context = await contextFor(prepared, message, row, gap, knownSecret);
  const plan = await askModel(snapshot ?? {}, context);
  if (!isRecord(plan) || !Array.isArray(plan.proposals)) throw fail(502, '模型未返回可审核的用例草稿，请重试。');
  const skills = new Set(discovery.skills.map(({ name }) => name));
  const sources = new Set(sourceCandidates(files));
  const documents = new Set(context.documents.map(({ path }) => path).filter((path) => files.includes(path)));
  const config = files.find((file) => /^(?:\.opencode\/)?openspec\/config\.ya?ml$/u.test(file));
  const workflow = config && files.includes('.opencode/.tools/openspec.mjs') ? config.slice(0, config.lastIndexOf('/')) : null;
  const steps = list(plan.steps, (step) => clean(step, knownSecret, 300), 5);
  const proposals = (await Promise.all(plan.proposals.slice(0, maxDrafts).map((value, i) => makeRow(value, {
    key: `ai-${prefix}-${i + 1}`, source: row, skills, sources, documents, workflow, projectDir, knownSecret,
  })))).filter(Boolean).map((draft) => draft.gap ? { ...draft, gap: { ...draft.gap, steps } } : draft);
  if (!proposals.length) throw fail(502, '模型未返回可审核的用例草稿，请重试。');
  return { proposals, analysis: clean(plan.summary, knownSecret, 700), steps };
}
