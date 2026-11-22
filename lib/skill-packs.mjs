import { createHash, randomBytes } from 'node:crypto';
import { cp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const registry = fileURLToPath(new URL('../skill-packs/', import.meta.url));
export const skillDirectory = '.bench-skills';
const allowedNames = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const standards = ['java-development', 'vue-best-practices'];
const profiles = [
  { id: 'none', title: '无配置 Skill', packIds: [], description: '仅使用原项目文件及任务提示词。' },
  { id: 'standards', title: 'Java / Vue 规范', packIds: standards, description: '使用 Java 与 Vue 工程规范作为编码参考。' },
  { id: 'superpowers', title: 'Superpowers + Java / Vue', packIds: ['superpowers', ...standards], description: '提供工程设计、测试优先和完成复核流程。' },
  { id: 'openspec', title: 'OpenSpec + Java / Vue', packIds: ['openspec', ...standards], description: '先记录变更提案、设计、规范与任务，再实现并校验。Java + Vue 场景的准备命令会安装 OpenSpec CLI。' },
];

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function knownSkillProfile(value) {
  return profiles.some(({ id }) => id === value);
}

export function matchesSkillLocks(packs, locks) {
  if (locks === undefined) return true;
  return Array.isArray(locks) && locks.length === packs.length && packs.every((pack) => pack && locks.some(
    (locked) => locked?.id === pack.id && locked.version === pack.version && locked.revision === pack.revision,
  ));
}

async function catalog() {
  try {
    const source = JSON.parse(await readFile(join(registry, 'catalog.json'), 'utf8'));
    return new Map((Array.isArray(source) ? source : source.packs).map((pack) => [pack.id, pack]));
  } catch (error) {
    if (error.code === 'ENOENT') return new Map();
    throw error;
  }
}

export async function listSkillProfiles() {
  const packs = await catalog();
  return profiles.filter(({ packIds }) => packIds.every((id) => packs.has(id))).map((profile) => ({
    ...profile,
    packs: profile.packIds.map((id) => {
      const { title, role, version, revision, source, skills } = packs.get(id);
      return { id, title, role, version, revision, source, skills: skills.map(({ name }) => name) };
    }),
  }));
}

export async function prepareSkills(workspace, id, locks) {
  const profile = profiles.find((entry) => entry.id === id);
  if (!profile || !profile.packIds.length) return null;
  const packs = await catalog();
  if (!matchesSkillLocks(profile.packIds.map((packId) => packs.get(packId)), locks)) {
    throw new Error('Skill 版本已变更，请重新审核用例。');
  }
  const mount = join(workspace, skillDirectory);
  const entries = new Map();
  const sources = [];
  for (const packId of profile.packIds) {
    const pack = packs.get(packId);
    if (!pack || !Array.isArray(pack.skills) || !pack.skills.length) throw new Error(`Skill 包 ${packId} 未安装或清单无效。`);
    const source = join(registry, packId);
    if (relative(source, await realpath(source))) throw new Error(`Skill 包 ${packId} 位于非预期位置。`);
    await cp(source, join(mount, packId), { recursive: true, errorOnExist: true, force: false });
    for (const { name, path, sha256: pinnedSha256 } of pack.skills) {
      if (!allowedNames.test(name) || entries.has(name) || !path.startsWith(`${packId}/`) || relative(registry, resolve(registry, path)).split(sep).join('/') !== path) {
        throw new Error(`Skill 包 ${packId} 包含无效或重复的 Skill。`);
      }
      const file = join(mount, path);
      if (relative(file, await realpath(file)) || !(await stat(file)).isFile()) throw new Error(`Skill 文件位置非预期（${name}）。`);
      const body = await readFile(file);
      const fingerprint = sha256(body);
      if (pinnedSha256 && fingerprint !== pinnedSha256) throw new Error(`Skill 文件摘要与固定版本不符（${name}）。`);
      const token = `bench-skill-read-${randomBytes(14).toString('hex')}`;
      const staged = Buffer.concat([body, Buffer.from(`\n\n<!-- ${token} -->\n`)]);
      await writeFile(file, staged);
      entries.set(name, { name, packId, file, path: `${skillDirectory}/${path}`, token, sha256: fingerprint, stagedSha256: sha256(staged) });
    }
    sources.push({ id: pack.id, title: pack.title, role: pack.role, version: pack.version, revision: pack.revision, source: pack.source });
  }

  const instructionPath = join(mount, 'RUN-WORKFLOW.md');
  const notes = [
    '适用领域的已配置工程规范请用原生 skill 工具加载。无需暂停向用户确认，按审核通过的任务和现有测试继续。',
    ...(id === 'superpowers' ? ['本轮采用 Superpowers 原生 Skill。加载并执行适合此变更的设计、测试优先及完成核验流程。现有审核需求视为已确认。使用当前项目副本，避免创建 Git worktree 或提交。'] : []),
    ...(id === 'openspec' ? ['本轮采用 OpenSpec。先加载 openspec-propose、生成可验证的变更文档，再加载 openspec-apply-change 并实现。同一轮完成，保留 openspec/changes 中的文档及任务状态以便审核。请直接运行已安装的 openspec CLI，例如 openspec list --json。'] : []),
  ];
  await writeFile(instructionPath, notes.join('\n') + '\n');
  const openspecBin = id === 'openspec' ? join(workspace, 'node_modules', '.bin') : null;
  if (openspecBin && !(await stat(join(openspecBin, process.platform === 'win32' ? 'openspec.cmd' : 'openspec')).catch(() => null))?.isFile()) {
    throw new Error('找不到项目内的 OpenSpec CLI。请先审核并运行锁定依赖的准备命令。');
  }
  return { profile: id, paths: sources.map(({ id: packId }) => join(mount, packId, 'skills')),
    instructions: instructionPath, sources, entries, openspecBin };
}

export function skillInventory(context, output) {
  const skills = JSON.parse(output);
  if (!Array.isArray(skills)) throw new Error('OpenCode 返回的 Skill 清单格式有误。');
  const listed = new Map(skills.map(({ name, location }) => [name, location]));
  return [...context.entries.values()].map(({ name, file, packId, path, sha256: fingerprint }) => ({
    name, packId, path, sha256: fingerprint, discovered: typeof listed.get(name) === 'string' && !relative(file, listed.get(name)),
  }));
}

export function verifySkillEvent(context, event) {
  const { part } = event ?? {};
  const { status, input, metadata, output } = part?.state ?? {};
  if (!context || event?.type !== 'tool_use' || part.type !== 'tool' || event.sessionID !== part.sessionID
    || status !== 'completed' || part.tool !== 'skill' || typeof output !== 'string') return null;
  const entry = context.entries.get(input?.name);
  if (!entry || metadata?.name !== entry.name || typeof metadata?.dir !== 'string' || relative(dirname(entry.file), metadata.dir)
    || !output.startsWith(`<skill_content name="${entry.name}">`)) return null;
  return { name: entry.name, packId: entry.packId, path: entry.path, bodyVerified: output.includes(entry.token), evidence: part.callID ?? part.id };
}

export async function buildSkillEvidence(context, inventory, events) {
  if (!context) return null;
  const skills = await Promise.all(inventory.map(async (item) => {
    const entry = context.entries.get(item.name);
    const current = await readFile(entry.file).catch(() => null);
    const calls = events.filter(({ name }) => name === item.name);
    return { ...item, unchanged: Boolean(current && sha256(current) === entry.stagedSha256), loaded: calls.length > 0,
      verified: calls.some(({ bodyVerified }) => bodyVerified), calls };
  }));
  return { profile: context.profile, packs: context.sources.map((source) => ({ ...source, skills: skills.filter(({ packId }) => packId === source.id) })) };
}
