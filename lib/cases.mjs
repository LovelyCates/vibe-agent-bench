import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, parse, relative, resolve } from 'node:path';
import ignore from 'ignore';
import { validProjectProgram } from './project-run.mjs';
import { findScenario, labelScenarioCommands } from './scenarios.mjs';
import { knownSkillProfile, listSkillProfiles, skillDirectory } from './skill-packs.mjs';
import { taskPrompt } from './task.mjs';

const caseId = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const commandId = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const programName = /^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,63}$/u;
const meaningfulScript = /^(?:test(?::[a-zA-Z0-9:_-]{1,80})?|lint|typecheck|type-check|check|build)$/u;
const controlChars = /[\u0000-\u001f\u007f]/u;
const sampleRequirement = '为后台任务列表增加状态筛选，覆盖默认列表、三种状态、空结果、非法参数和真实 HTTP 测试。';
const skippedEntries = new Set([
  '.git', '.hg', '.svn', '.aws', '.azure', '.codex', '.gnupg', '.kube', '.ssh',
  '.cache', '.gradle', '.next', '.nuxt', '.parcel-cache', '.svelte-kit', '.turbo',
  '.venv', '.vite', '.tox', '__pycache__', 'node_modules', 'bower_components',
  'vendor', 'venv', 'dist', 'build', 'target', 'out', 'coverage', 'test-results',
  'playwright-report', skillDirectory, '.bench-results', '.npmrc', '.pypirc', '.netrc', '.git-credentials',
  '.yarnrc', '.yarnrc.yml', 'auth.json', 'local.settings.json',
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519',
]);
const maxProjectFiles = 5_000;
const maxProjectEntries = 25_000;
const maxProjectBytes = 96 * 1024 * 1024;
const maxManifestBytes = 512 * 1024;
export const maxProjectFileBytes = 10 * 1024 * 1024;

function caseError(status, message) {
  return Object.assign(new Error(message), { status });
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function field(value, label, limit, { required = true, singleLine = false } = {}) {
  if (typeof value !== 'string' || value.includes('\0') || (singleLine && controlChars.test(value))) {
    throw caseError(400, `${label}格式无效。`);
  }
  const text = value.trim();
  if ((required && !text) || text.length > limit) {
    throw caseError(400, `${label}需要${required ? '填写，且' : ''}限制在 ${limit} 字符内。`);
  }
  return text;
}

export function projectEntryExcluded(file) {
  if (controlChars.test(file) || file.includes('\\')) return true;
  return file.toLowerCase().split('/').some((name) =>
    skippedEntries.has(name)
    || /^(?:\.env|\.env[._-].*)$/u.test(name) && !/\.(?:example|sample|template)$/u.test(name)
    || /\.(?:pem|key|p12|pfx|ppk|jks|kdbx)$/u.test(name)
    || /^(?:secrets?|credentials?|tokens?|api[-_]?keys?)(?:[._-][\w.-]+)?$/u.test(name)
      && !/\.(?:[cm]?[jt]sx?|py|go|rs|md)$/u.test(name)
    || /^(?:.*[-_.])?(?:credentials|access[-_]?token|service[-_]?account|client[-_]?secret)[\w.-]*\.(?:json|ya?ml|toml|ini|txt)$/u.test(name)
  );
}

function ignoredByRules(file, rules) {
  let ignored = false;
  for (const { folder, matcher } of rules) {
    const decision = matcher.test(file.slice(folder.length));
    if (decision.ignored) ignored = true;
    if (decision.unignored) ignored = false;
  }
  return ignored;
}

async function readSmallFile(path) {
  try {
    const info = await lstat(path);
    if (info.isFile() && info.size <= maxManifestBytes) return await readFile(path, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return '';
}

export async function listProjectFiles(projectDir) {
  const files = [];
  const pending = [{ folder: '', rules: [] }];
  let totalBytes = 0;
  let seen = 0;
  while (pending.length) {
    const { folder, rules } = pending.pop();
    const localIgnore = await readSmallFile(join(projectDir, folder, '.gitignore'));
    const activeRules = localIgnore
      ? [...rules, { folder, matcher: ignore({ ignoreCase: process.platform === 'win32' }).add(localIgnore) }]
      : rules;
    for (const entry of await readdir(join(projectDir, folder), { withFileTypes: true })) {
      if (++seen > maxProjectEntries) {
        throw caseError(400, '项目目录条目过多，请选择项目子目录。');
      }
      const file = folder + entry.name;
      if (projectEntryExcluded(file) || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!ignoredByRules(file + '/', activeRules)) pending.push({ folder: file + '/', rules: activeRules });
        continue;
      }
      if (!entry.isFile() || ignoredByRules(file, activeRules)) continue;
      const info = await lstat(join(projectDir, file));
      if (!info.isFile() || info.size > maxProjectFileBytes) continue;
      totalBytes += info.size;
      if (files.length >= maxProjectFiles || totalBytes > maxProjectBytes) {
        throw caseError(400, '项目文件超出评测工作区容量，请选择项目子目录。');
      }
      files.push(file);
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

async function resolveProject(value) {
  const text = field(value, '项目目录', 4_096, { singleLine: true });
  const path = /^".*"$/u.test(text) ? text.slice(1, -1) : text;
  const driveRelative = process.platform === 'win32' && !/^[a-zA-Z]:[\\/]/u.test(path);
  if (!isAbsolute(path) || driveRelative) throw caseError(400, '请填写本机项目目录的绝对路径。');
  try {
    const actual = await realpath(path);
    if (actual === parse(actual).root || !(await lstat(actual)).isDirectory()) {
      throw caseError(400, '请选择一个项目文件夹。');
    }
    return actual;
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EINVAL'].includes(error.code)) {
      throw caseError(400, '找不到项目目录，或评测台无法读取该目录。');
    }
    throw error;
  }
}

function command(id, label, phase, program, args, timeoutMs = 120_000) {
  return { id, label, phase, program, args, timeoutMs };
}

function packageManager(manifest, files) {
  const declared = typeof manifest.packageManager === 'string' && /^(npm|pnpm|yarn|bun)@/u.exec(manifest.packageManager)?.[1];
  if (declared) return declared;
  if (files.has('pnpm-lock.yaml')) return 'pnpm';
  if (files.has('yarn.lock')) return 'yarn';
  if (files.has('bun.lock') || files.has('bun.lockb')) return 'bun';
  return 'npm';
}

function nodeCommands(manifest, files) {
  const program = packageManager(manifest, files);
  const hasDependencies = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']
    .some((key) => isRecord(manifest[key]) && Object.keys(manifest[key]).length > 0)
    || Boolean(manifest.workspaces);
  const scripts = isRecord(manifest.scripts) ? Object.entries(manifest.scripts) : [];
  const checks = scripts.filter(([name, script]) =>
    meaningfulScript.test(name) && typeof script === 'string' && script.trim()
    && !/^(?:echo(?:\s|$)|true\s*$|exit\s+0\s*$)/u.test(script.trim())
  );
  // Prefer the aggregate test script when a project also exposes component test scripts.
  const aggregate = checks.some(([name]) => name === 'test');
  const selected = checks.filter(([name]) => !aggregate || !name.startsWith('test:'))
    .sort(([a], [b]) => Number(!a.startsWith('test')) - Number(!b.startsWith('test')) || a.localeCompare(b))
    .slice(0, 12);
  const commands = selected.map(([name], index) => {
    const slug = name.replaceAll(':', '-').toLowerCase().slice(0, 48);
    const id = name.includes(':') ? `${program}-${slug}-${index + 1}` : `${program}-${slug}`;
    return command(id, `运行 ${name}`, 'verify', program, ['run', name]);
  });
  if (hasDependencies && program === 'npm') {
    const locked = files.has('package-lock.json') || files.has('npm-shrinkwrap.json');
    const args = [locked ? 'ci' : 'install', '--ignore-scripts', '--no-audit', '--no-fund'];
    commands.unshift(command('install', '安装项目依赖', 'setup', program, args, 300_000));
  } else if (hasDependencies && program === 'pnpm' && files.has('pnpm-lock.yaml')) {
    commands.unshift(command('install', '安装项目依赖', 'setup', program, ['install', '--frozen-lockfile', '--ignore-scripts'], 300_000));
  }
  return commands;
}

function sourceRank(file) {
  if (/^(?:readme|agents|contributing)(?:\.|$)/iu.test(file)) return 0;
  if (/^(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|pyproject\.toml|Cargo\.toml|go\.mod)$/u.test(file)) return 1;
  if (/(?:^|\/)(?:tests?|__tests__)(?:\/|$)|\.(?:test|spec)\.[\w]+$/iu.test(file)) return 2;
  if (/\.(?:[cm]?[jt]sx?|py|go|rs|java|cs|html|css|vue|svelte)$/u.test(file)) return 3;
  return 4;
}

async function describeProject(projectDir, profile) {
  let files;
  let manifest;
  try {
    files = await listProjectFiles(projectDir);
    if (files.includes('package.json')) {
      const contents = await readSmallFile(join(projectDir, 'package.json'));
      try {
        manifest = JSON.parse(contents.replace(/^\uFEFF/u, ''));
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
    }
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) {
      throw caseError(400, '扫描项目失败，请检查目录与文件的读取权限。');
    }
    throw error;
  }
  const knownProject = files.some((file) =>
    /\.(?:[cm]?[jt]sx?|py|go|rs|java|cs|html|css|vue|svelte)$/u.test(file)
    || /(?:^|\/)(?:go\.mod|Cargo\.toml|pyproject\.toml|setup\.py|pom\.xml|build\.gradle(?:\.kts)?|[^/]+\.(?:sln|csproj))$/u.test(file)
  );
  if (profile !== 'sample' && !knownProject && !isRecord(manifest)) {
    throw caseError(400, '此目录缺少可识别的项目清单或源代码，请选择项目根目录。');
  }
  const projectName = typeof manifest?.name === 'string' && /^(?:@[\w.-]+\/)?[\w.-]{1,120}$/u.test(manifest.name)
    ? manifest.name
    : basename(projectDir);
  const sourceFiles = files.slice().sort((a, b) => sourceRank(a) - sourceRank(b) || a.localeCompare(b)).slice(0, 80);
  let commands = [];
  if (profile !== 'sample') {
    const discovered = new Set(files);
    if (isRecord(manifest)) commands = nodeCommands(manifest, discovered);
    if (!commands.some((item) => item.phase === 'verify')) {
      const tests = files.filter((file) => file.length < 1_020 && /(?:^test\/.*|(?:^|\/)test(?:[-_.][^/]+)?|\.(?:test|spec))\.[cm]?js$/iu.test(file));
      if (tests.length && tests.length <= 24) {
        commands.push(command('node-test', '运行 Node.js 测试', 'verify', 'node', ['--test', ...tests.map((file) => './' + file)]));
      } else if (discovered.has('go.mod') && files.some((file) => file.endsWith('_test.go'))) {
        commands.push(command('go-test', '运行 Go 测试', 'verify', 'go', ['test', './...']));
      } else if (discovered.has('Cargo.toml') && files.some((file) => file.endsWith('.rs'))) {
        commands.push(command('cargo-test', '运行 Rust 测试', 'verify', 'cargo', ['test']));
      }
    }
  }
  return { projectName, sourceFiles, commands: validateCommands(commands) };
}

function draftPrompt({ profile, projectName, requirement, sourceFiles, commands }) {
  if (profile === 'sample') {
    return requirement === sampleRequirement ? taskPrompt : `${taskPrompt.trimEnd()}\n\n本用例补充需求\n${requirement}\n`;
  }
  const related = sourceFiles.filter((file) => sourceRank(file) < 4).slice(0, 20);
  const commandLines = commands.map(({ program, args }) => `- ${program} ${JSON.stringify(args)}`);
  return [
    `在「${projectName}」项目的独立工作副本中实现以下需求。`,
    '',
    requirement,
    '',
    '先阅读项目说明，定位与需求相关的实现和测试。遵循项目现有约定，补充能够验证本次行为的测试。',
    '保留原有验收测试、工具配置和清单。需要补充回归用例时，另建测试文件。',
    ...(related.length ? ['', '项目中可参考的文件', ...related.map((file) => `- ${JSON.stringify(file)}`)] : []),
    ...(commandLines.length ? ['', '评测台将从项目根目录执行这些命令，参数按数组逐项传入', ...commandLines] : []),
    '',
    '完成后说明改动、实际运行的验证命令和结果。',
  ].join('\n');
}

function validateCommands(value) {
  if (!Array.isArray(value) || value.length > 20) {
    throw caseError(400, '验收命令必须为数组，最多包含 20 条。');
  }
  const ids = new Set(['workspace', 'agent', 'integrity', 'skill', 'workflow']);
  return value.map((item, index) => {
    const row = `命令 ${index + 1}`;
    if (!isRecord(item) || typeof item.id !== 'string' || !commandId.test(item.id) || ids.has(item.id)) {
      throw caseError(400, `${row}需要唯一的标识。`);
    }
    ids.add(item.id);
    if (!['setup', 'verify'].includes(item.phase)) throw caseError(400, `${row}的阶段无效。`);
    if (typeof item.program !== 'string' || !programName.test(item.program) || !validProjectProgram(item.program)) {
      throw caseError(400, `${row}需要填写可执行程序名，各参数请单独填写。`);
    }
    if (!Array.isArray(item.args) || item.args.length > 64 || item.args.some((arg) =>
      typeof arg !== 'string' || arg.length > 1_024 || controlChars.test(arg)
    )) {
      throw caseError(400, `${row}的参数必须是字符串数组，每个参数限 1,024 字符。`);
    }
    if (!Number.isSafeInteger(item.timeoutMs) || item.timeoutMs < 1 || item.timeoutMs > 900_000) {
      throw caseError(400, `${row}的超时需要填写 1 到 900,000 毫秒。`);
    }
    return command(item.id, field(item.label, `${row}名称`, 100, { singleLine: true }), item.phase, item.program, [...item.args], item.timeoutMs);
  });
}

function substantiveVerification({ phase, program, args }) {
  if (phase !== 'verify') return false;
  const executable = program.toLowerCase().replace(/\.(?:exe|bat|cmd)$/u, '');
  if (['true', 'false', 'echo', 'ver', 'where', 'which', 'pwd', 'whoami'].includes(executable)) return false;
  if (args.length === 1 && ['-v', '--version', 'version', '-h', '--help', 'help'].includes(args[0])) return false;
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(executable)) {
    if (['ci', 'install', 'i', 'add', 'update', 'list', 'ls', 'init', 'config'].includes(args[0])) return false;
    if (['run', 'run-script'].includes(args[0]) && !args[1]?.trim()) return false;
  }
  return args.length > 0 || !['npm', 'pnpm', 'yarn', 'bun', 'node', 'python', 'python3', 'py'].includes(executable);
}

export async function openCases(storeDir, { defaultProject } = {}) {
  const root = resolve(storeDir);
  await mkdir(root, { recursive: true });
  const fixture = defaultProject ? await realpath(defaultProject) : null;
  const records = new Map();
  const writing = new Map();
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const id = entry.name.slice(0, -5);
    if (!entry.isFile() || !entry.name.endsWith('.json') || !caseId.test(id)) continue;
    try {
      const record = JSON.parse(await readFile(join(root, entry.name), 'utf8'));
      if (record?.id === id && Number.isSafeInteger(record.version)
        && ['draft', 'approved'].includes(record.status) && ['sample', 'generic'].includes(record.profile)
        && typeof record.updatedAt === 'string') records.set(id, record);
    } catch (error) {
      if (error.code !== 'ENOENT') console.error(`读取评测用例 ${id} 失败。`, error.message);
    }
  }

  async function persist(record) {
    const destination = join(root, record.id + '.json');
    const temporary = join(root, record.id + '.' + randomUUID() + '.tmp');
    try {
      await writeFile(temporary, JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
    records.set(record.id, record);
    return structuredClone(record);
  }

  return {
    list: () => [...records.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((record) => structuredClone(record)),
    get: (id) => structuredClone(records.get(id)),
    async create(body) {
      if (!isRecord(body)) throw caseError(400, '用例内容格式无效。');
      const projectDir = await resolveProject(body.projectDir);
      const profile = fixture && relative(fixture, projectDir) === '' ? 'sample' : 'generic';
      const scenario = findScenario(projectDir);
      const requirement = field(body.requirement ?? scenario?.requirement ?? '', '需求', 8_000, { required: profile !== 'sample' }) || sampleRequirement;
      if (body.title !== undefined) field(body.title, '标题', 120, { required: false, singleLine: true });
      const details = await describeProject(projectDir, profile);
      details.commands = labelScenarioCommands(scenario, details.commands);
      const title = body.title?.trim() || (profile === 'sample' ? '后台任务列表状态筛选' : scenario?.title ?? details.projectName.slice(0, 120));
      const skillProfile = (await listSkillProfiles()).some(({ id }) => id === scenario?.skillProfile) ? scenario.skillProfile : 'none';
      const now = new Date().toISOString();
      return persist({
        id: randomUUID(), version: 1, status: 'draft', title, projectDir, requirement,
        prompt: draftPrompt({ profile, requirement, ...details }), profile, skillProfile, ...(scenario && { scenario: scenario.id }), ...details,
        createdAt: now, updatedAt: now,
      });
    },
    async update(id, body) {
      const previous = writing.get(id);
      const operation = (async () => {
        if (previous) await previous.catch(() => {});
        const current = records.get(id);
        if (!current) throw caseError(404, '找不到该评测用例。');
        if (!isRecord(body) || !['save', 'approve'].includes(body.action) || !Number.isSafeInteger(body.version) || body.version < 1) {
          throw caseError(400, '请提供有效的用例版本及保存或审核操作。');
        }
        if (body.version !== current.version) throw caseError(409, '该用例已更新，请刷新后重试。');
        const title = field(body.title === undefined ? current.title : body.title, '标题', 120, { singleLine: true });
        const requireContent = body.action === 'approve';
        const requirement = field(body.requirement === undefined ? current.requirement : body.requirement, '需求', 8_000, { required: requireContent });
        const prompt = field(body.prompt === undefined ? current.prompt : body.prompt, 'OpenCode 提示词', 16_000, { required: requireContent });
        const commands = validateCommands(body.commands === undefined ? current.commands : body.commands);
        const skillProfile = body.skillProfile === undefined ? current.skillProfile ?? 'none' : body.skillProfile;
        if (!knownSkillProfile(skillProfile) || (current.profile === 'sample' && skillProfile !== 'none')) {
          throw caseError(400, '该用例的 Skill 配置无效。');
        }
        const approvedProfile = requireContent && (await listSkillProfiles()).find(({ id }) => id === skillProfile);
        if (requireContent && !approvedProfile) {
          throw caseError(400, '当前 Skill 包未安装，请先准备本地 Skill 库。');
        }
        if (current.profile === 'sample' && commands.length) {
          throw caseError(400, '内置样例使用固定的六项验收命令。');
        }
        if (requireContent && current.profile === 'generic' && !commands.some(substantiveVerification)) {
          throw caseError(400, '请至少填写一条可验证项目的验收命令再审核通过。');
        }
        return persist({
          ...current, title, requirement, prompt, commands, skillProfile,
          skillLocks: approvedProfile ? approvedProfile.packs.map(({ id, version, revision }) => ({ id, version, revision })) : undefined,
          version: current.version + 1,
          status: requireContent ? 'approved' : 'draft',
          updatedAt: new Date().toISOString(),
        });
      })();
      writing.set(id, operation);
      try {
        return await operation;
      } finally {
        if (writing.get(id) === operation) writing.delete(id);
      }
    },
  };
}
