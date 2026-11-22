import { exec, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const capture = promisify(execFile);
const shell = promisify(exec);
const destination = fileURLToPath(new URL('../skill-packs/', import.meta.url));
const openSpecIntegrity = 'sha512-GQv1xU4uLrTVJ6MfOKNIxo/BgEk+e8C/XBmjTfzd/W3LNh4v2UMAsfTdn8mjHdjDA/KjfGstwUhZedQW4hdcZQ==';
const openSpecEntrypoint = 'node_modules/@fission-ai/openspec/bin/openspec.js';
const packs = [
  {
    id: 'superpowers', title: 'Superpowers', role: 'workflow', version: 'v7.0.2',
    repository: 'obra/superpowers', revision: '22f0b463e7a5e579904dd6211a520321035526f7',
    directory: 'skills',
  },
  {
    id: 'openspec', title: 'OpenSpec', role: 'workflow', version: '2.1.1',
    repository: 'Fission-AI/OpenSpec', revision: '0c737dc1b543249b38b0f4716816fcf493d894dd',
    projectTemplate: 'openspec/project',
    cli: { package: '@fission-ai/openspec', version: '2.1.1', entrypoint: openSpecEntrypoint, integrity: openSpecIntegrity },
  },
  {
    id: 'java-development', title: 'Java Development', role: 'standard', version: 'f10fdb8b2660',
    repository: 'github/awesome-copilot', revision: 'f10fdb8b2660ce85c98f220b2f1ca24653768a5c',
    files: [
      'skills/java-development/SKILL.md',
      'skills/java-development/references/build-and-dependencies.md',
      'skills/java-development/references/modern-java.md',
      'skills/java-development/references/quality-and-packaging.md',
    ],
  },
  {
    id: 'vue-best-practices', title: 'Vue Best Practices', role: 'standard', version: '19.1.0',
    repository: 'vuejs-ai/skills', revision: '198f0cd8f7f9c0a3d9b566ccc16de6677519ee78',
    directory: 'skills/vue-best-practices',
  },
];

async function download(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (response.ok) return Buffer.from(await response.arrayBuffer());
      await response.body?.cancel();
      throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      if (attempt === 3) throw new Error(`Could not download ${url}`, { cause: error });
      await delay(attempt * 500);
    }
  }
}

async function save(root, path, content) {
  const file = join(root, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
}

function rawUrl(pack, path) {
  return `https://raw.githubusercontent.com/${pack.repository}/${pack.revision}/${path}`;
}

async function copyUpstreamDirectory(pack, target, temporary) {
  const archive = join(temporary, `${pack.id}.tar.gz`);
  const archiveUrl = `https://codeload.github.com/${pack.repository}/tar.gz/${pack.revision}`;
  await writeFile(archive, await download(archiveUrl));
  const root = `${pack.repository.split('/')[1]}-${pack.revision}/`;
  const { stdout } = await capture('tar', ['-tf', archive], { timeout: 30_000 });
  const files = stdout.split(/\r?\n/u)
    .filter((path) => path.startsWith(`${root}${pack.directory}/`) && !path.endsWith('/'));
  if (!files.some((path) => path.endsWith('/SKILL.md'))) throw new Error(`No skills found for ${pack.id}`);

  for (let offset = 0; offset < files.length; offset += 8) {
    await Promise.all(files.slice(offset, offset + 8).map(async (path) => {
      const name = path.slice(root.length);
      if (!name.split('/').every((segment) => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(segment))) {
        throw new Error(`Unexpected archive path ${path}`);
      }
      const { stdout: content } = await capture('tar', ['-xOf', archive, path], {
        encoding: 'buffer', timeout: 30_000,
      });
      await save(target, name, content);
    }));
  }
}

async function generateOpenSpec(pack, target, temporary) {
  const install = join(temporary, 'openspec-install');
  const project = join(temporary, 'openspec-project');
  const home = join(temporary, 'openspec-home');
  await Promise.all([mkdir(install), mkdir(project), mkdir(home)]);
  await save(install, 'package.json', JSON.stringify({
    private: true,
    dependencies: { [pack.cli.package]: pack.cli.version },
  }));
  await shell('npm install --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org', {
    cwd: install, timeout: 180_000, windowsHide: true,
  });
  const lock = JSON.parse(await readFile(join(install, 'package-lock.json'), 'utf8'));
  const pinnedPackage = lock.packages[`node_modules/${pack.cli.package}`];
  if (pinnedPackage?.version !== pack.cli.version || pinnedPackage?.integrity !== pack.cli.integrity) {
    throw new Error('The installed OpenSpec package does not match the pinned npm release.');
  }

  const command = join(install, pack.cli.entrypoint);
  const systemEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => (
    /^(path|systemroot|windir|systemdrive|comspec|pathext|programfiles|programfiles\(x86\)|programw6432)$/iu.test(key)
  )));
  const env = {
    ...systemEnvironment,
    HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
    XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'),
    XDG_CACHE_HOME: join(home, 'cache'), CI: '1', NO_COLOR: '1', OPENSPEC_TELEMETRY: '0',
  };
  const { stdout } = await capture(process.execPath, [command, '--version'], { cwd: project, env, timeout: 15_000 });
  if (stdout.trim() !== pack.version) throw new Error(`Unexpected OpenSpec version: ${stdout.trim()}`);
  await capture(process.execPath, [command, 'init', '--tools', 'opencode', '--scope', 'project',
    '--profile', 'core', '--no-animation'], { cwd: project, env, timeout: 30_000 });
  const skills = join(project, '.agents', 'skills');
  for (const directory of await readdir(skills, { withFileTypes: true })) {
    if (directory.isDirectory()) await cp(join(skills, directory.name), join(target, 'skills', directory.name), { recursive: true });
  }
  await cp(join(project, 'openspec'), join(target, 'project', 'openspec'), { recursive: true });
}

async function collectSkills(root, pack) {
  const skillsDir = join(root, pack.id, 'skills');
  const skills = [];
  for (const dir of await readdir(skillsDir, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const path = posix.join(pack.id, 'skills', dir.name, 'SKILL.md');
    const bytes = await readFile(join(root, path));
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(bytes.toString('utf8'))?.[1];
    const name = /^name:\s*([a-z0-9-]+)\s*$/mu.exec(frontmatter ?? '')?.[1];
    if (name !== dir.name) throw new Error(`Unexpected skill name in ${path}`);
    skills.push({ name, path, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  if (!skills.length) throw new Error(`No skills found for ${pack.id}`);
  return skills.sort((first, second) => first.name.localeCompare(second.name, 'en'));
}

async function fetchPack(pack, root, temporary) {
  const target = join(root, pack.id);
  const license = posix.join(pack.id, 'LICENSE');
  await save(root, license, await download(rawUrl(pack, 'LICENSE')));
  if (pack.files) {
    await Promise.all(pack.files.map(async (path) => save(target, path, await download(rawUrl(pack, path)))));
  } else if (pack.directory) {
    await copyUpstreamDirectory(pack, target, temporary);
  } else {
    await generateOpenSpec(pack, target, temporary);
  }
  const { directory, files, ...entry } = pack;
  return {
    ...entry,
    source: `https://github.com/${pack.repository}/tree/${pack.revision}`,
    license: 'MIT', licensePath: license,
    skills: await collectSkills(root, pack),
  };
}

const temporaryRoot = await realpath(tmpdir());
const temporary = await mkdtemp(join(temporaryRoot, 'vibe-skill-packs-'));
try {
  const staging = join(temporary, 'packs');
  const outcomes = await Promise.allSettled(packs.map((pack) => fetchPack(pack, staging, temporary)));
  const errors = outcomes.filter(({ status }) => status === 'rejected');
  if (errors.length) throw new AggregateError(errors.map(({ reason }) => reason), 'Could not download skill packs.');
  const entries = outcomes.map(({ value }) => value);
  await mkdir(destination, { recursive: true });
  await cp(staging, destination, { recursive: true, force: true });
  await save(destination, 'catalog.json', `${JSON.stringify(entries, null, 2)}\n`);
  for (const pack of entries) {
    const label = pack.skills.length === 1 ? 'skill' : 'skills';
    console.log(`${pack.title} ${pack.version}: ${pack.skills.length} ${label}`);
  }
} finally {
  const path = relative(temporaryRoot, resolve(temporary));
  if (path.startsWith('vibe-skill-packs-') && !path.includes(sep)) {
    await rm(temporary, { recursive: true, force: true, maxRetries: 3 });
  }
}
