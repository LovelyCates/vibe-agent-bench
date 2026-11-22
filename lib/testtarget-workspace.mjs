import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { listProjectFiles } from './cases.mjs';
import { runProjectChecks } from './project-run.mjs';

const toolFiles = ['.opencode/.tools/package.json', '.opencode/.tools/package-lock.json'];
const skillsRoot = '.opencode/skills/';
export const maskedSkill = 'frontend-implementation';
export const holdTest = 'workspace/frontend/src/data/__tests__/bench-acceptance-hold.spec.ts';
export const holdMarker = 'BENCH_ACCEPTANCE_HOLD';
const holdFixture = [
  "import { expect, it } from 'vitest'",
  '',
  "it('评测夹具仍处于发布暂缓状态', () => {",
  "  expect('approval-pending', 'BENCH_ACCEPTANCE_HOLD').toBe('approval-granted')",
  '})',
  '',
].join('\n');

export function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function readRegular(root, file) {
  const absolute = join(root, file);
  const path = await realpath(absolute);
  const relativePath = relative(root, path);
  if (isAbsolute(relativePath) || relativePath === '..' || relativePath.startsWith('..' + sep) || !(await lstat(absolute)).isFile()) {
    throw new Error('评测文件位置无效（' + file + '）。');
  }
  return readFile(path);
}

export async function readTree(root, paths) {
  const files = new Map();
  for (let offset = 0; offset < paths.length; offset += 64) {
    const window = paths.slice(offset, offset + 64);
    const buffers = await Promise.all(window.map((file) => readRegular(root, file)));
    for (const [index, file] of window.entries()) files.set(file, buffers[index]);
  }
  return files;
}

export async function testTargetSnapshot(directory) {
  const root = await realpath(directory).catch(() => null);
  if (!root || !(await lstat(root)).isDirectory()) throw new Error('找不到 TestTarget 项目根目录。');
  const paths = [...new Set([...(await listProjectFiles(root)), ...toolFiles])].sort();
  const files = await readTree(root, paths);
  for (const required of ['AGENTS.md', 'opencode.json', '.opencode/plugins/superpowers.js',
    skillsRoot + maskedSkill + '/SKILL.md', 'workspace/frontend/package-lock.json']) {
    if (!files.has(required)) throw new Error('TestTarget 缺少评测输入（' + required + '）。');
  }
  const hash = createHash('sha256');
  for (const [file, bytes] of files) hash.update(JSON.stringify([file, digest(bytes)]) + '\n');
  return { root, files, hash: hash.digest('hex') };
}

export async function stageFiles(workspace, entries) {
  const paths = new Set(entries.map(([file]) => dirname(join(workspace, file))));
  await Promise.all([...paths].map((path) => mkdir(path, { recursive: true })));
  for (let offset = 0; offset < entries.length; offset += 64) {
    await Promise.all(entries.slice(offset, offset + 64).map(([file, bytes]) => writeFile(join(workspace, file), bytes)));
  }
}

export async function stageTestTarget({ baseline, workspace, trial, artifactDir, report, onEvent }) {
  const entries = [...baseline.files].filter(([file]) => !trial.masked || !file.startsWith(skillsRoot + maskedSkill + '/'));
  if (trial.kind === 'failure') entries.push([holdTest, Buffer.from(holdFixture)]);
  await stageFiles(workspace, entries);
  await mkdir(join(workspace, '.opencode', '.agents'), { recursive: true });
  await symlink(join(workspace, '.opencode', 'skills'), join(workspace, '.opencode', '.agents', 'skills'), process.platform === 'win32' ? 'junction' : 'dir');
  const modules = ['.opencode/.tools', ...(trial.kind === 'pending' ? [] : ['workspace/frontend'])];
  const dependencySources = await Promise.all(modules.map(async (module) => {
    const source = join(baseline.root, module, 'node_modules');
    const info = await lstat(source).catch(() => null);
    if (!info?.isDirectory()) return 'missing';
    await cp(source, join(workspace, module, 'node_modules'), {
      recursive: true,
      filter: async (file) => {
        const name = relative(source, file);
        return !/(^|[\\/])(?:\.vite|\.vite-temp|\.cache)(?=[\\/]|$)/u.test(name) && !(await lstat(file)).isSymbolicLink();
      },
    });
    return 'local-dependencies';
  }));
  for (const [index, module] of modules.entries()) {
    if (dependencySources[index] !== 'missing') continue;
    const id = 'target-setup-' + index;
    const result = await runProjectChecks({
      workspace, artifactDir, onEvent,
      commands: [{ id, label: '恢复固定依赖 ' + module, phase: 'setup', program: 'npm',
        args: ['--prefix', module, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], timeoutMs: 180_000 }],
      report: (_id, status, summary) => report('workspace', 'running', summary),
    });
    if (!result.ok) throw new Error('无法恢复 TestTarget 依赖（' + module + '）。');
    dependencySources[index] = 'npm-ci';
  }
  return { files: new Map(entries), dependencies: Object.fromEntries(modules.map((name, index) => [name, dependencySources[index]])) };
}

export async function targetChanges(workspace, before) {
  const paths = [...new Set([...(await listProjectFiles(workspace)), ...toolFiles])].sort();
  const after = await readTree(workspace, paths);
  const changes = [...new Set([...before.keys(), ...after.keys()])].sort().filter((file) => {
    const old = before.get(file);
    const current = after.get(file);
    return !old || !current || !old.equals(current);
  });
  return { after, changes };
}

export function diffFrom(before, after, changes) {
  const patches = [];
  for (const file of changes.slice(0, 80)) {
    const old = before.get(file);
    const current = after.get(file);
    if (old?.includes(0) || current?.includes(0)) continue;
    if ((old?.length ?? 0) + (current?.length ?? 0) > 150_000) continue;
    patches.push(createTwoFilesPatch(old ? 'a/' + file : '/dev/null', current ? 'b/' + file : '/dev/null',
      old?.toString('utf8') ?? '', current?.toString('utf8') ?? ''));
  }
  return patches.join('') || '未记录文本改动。\n';
}
