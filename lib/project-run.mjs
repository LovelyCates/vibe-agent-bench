import { execFile, spawn } from 'node:child_process';
import { access, constants, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

const isWindows = process.platform === 'win32';
const programName = /^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,63}$/u;
const shells = new Set(['bash', 'cmd', 'cscript', 'dash', 'fish', 'ksh', 'mshta', 'powershell', 'pwsh', 'sh', 'tcsh', 'wscript', 'zsh']);
const maxLineLength = 16_384;
const maxLogLength = 200_000;
const launchErrorCodes = /^[A-Z0-9_]{2,40}$/u;
const npmEntrypoints = {
  npm: ['node_modules/npm/bin/npm-cli.js'],
  npx: ['node_modules/npm/bin/npx-cli.js'],
  pnpm: ['node_modules/pnpm/bin/pnpm.mjs', 'node_modules/pnpm/bin/pnpm.cjs', '../../node/node_modules/pnpm/bin/pnpm.mjs'],
  yarn: ['node_modules/yarn/bin/yarn.js'],
};

export function redactOutput(value, knownSecret = '') {
  let text = stripVTControlCharacters(value);
  if (knownSecret) text = text.replaceAll(knownSecret, '[REDACTED]');
  return text
    .replace(/\b(?:sk-[\w-]{12,}|github_pat_[\w-]{12,}|gh[pousr]_[\w-]{12,}|xox[baprs]-[\w-]{12,}|(?:AKIA|ASIA)[A-Z0-9]{16})\b/gu, '[REDACTED]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/giu, '$1[REDACTED]')
    .replace(/(\bhttps?:\/\/)[^/@\s]+:[^/@\s]+@/giu, '$1[REDACTED]@')
    .replace(/(\b[\w-]*(?:api[_-]?key|auth[_-]?token|access[_-]?token|password|passwd|secret)["']?\s*[:=]\s*)(["'])([^"'\r\n]*)\2/giu, '$1$2[REDACTED]$2')
    .replace(/(\b[\w-]*(?:api[_-]?key|auth[_-]?token|access[_-]?token|password|passwd|secret)["']?\s*[:=]\s*)([^"'\s,;{}\[\]]+)/giu, '$1[REDACTED]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '');
}

export async function terminateProcessTree(child) {
  if (!child.pid) return;
  if (isWindows) {
    const system = process.env.SystemRoot ?? 'C:\\Windows';
    await new Promise((done) => {
      execFile(join(system, 'System32', 'taskkill.exe'), ['/pid', String(child.pid), '/t', '/f'], {
        timeout: 3000, windowsHide: true,
      }, done);
    });
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
  child.kill('SIGKILL');
}

export function validProjectProgram(program) {
  return typeof program === 'string' && programName.test(program)
    && !/\.(?:bat|cmd|ps1)$/iu.test(program) && !shells.has(program.toLowerCase().replace(/\.exe$/u, ''));
}

function validCommand(command) {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/u.test(command?.id ?? '')
    && typeof command.label === 'string' && command.label.trim().length > 0 && command.label.length <= 160
    && ['setup', 'verify'].includes(command.phase) && validProjectProgram(command.program)
    && Array.isArray(command.args) && command.args.length <= 128
    && command.args.every((arg) => typeof arg === 'string' && arg.length <= 4096 && !/[\u0000\r\n]/u.test(arg))
    && Number.isSafeInteger(command.timeoutMs) && command.timeoutMs > 0 && command.timeoutMs <= 900_000;
}

function searchDirectories(workspace) {
  return (process.env.PATH ?? '').split(delimiter).map((entry) => entry.trim().replace(/^"|"$/gu, ''))
    .filter((entry) => {
      if (!isAbsolute(entry)) return false;
      const rel = relative(workspace, entry);
      return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
    });
}

async function available(path) {
  if (!(await stat(path).catch(() => null))?.isFile()) return false;
  return isWindows || access(path, constants.X_OK).then(() => true, () => false);
}

async function commandInvocation(program, argv, pathEntries) {
  const basename = isWindows ? program.toLowerCase().replace(/\.exe$/u, '') : program;
  if (basename === 'node') return { executable: process.execPath, args: argv };
  if (isWindows && Object.hasOwn(npmEntrypoints, basename)) {
    const directories = new Set([dirname(process.execPath), ...pathEntries]);
    for (const directory of directories) {
      for (const entry of npmEntrypoints[basename]) {
        const path = resolve(directory, entry);
        if (await available(path)) return { executable: process.execPath, args: [path, ...argv] };
      }
      const executable = join(directory, `${basename}.exe`);
      if (await available(executable)) return { executable, args: argv };
    }
  } else {
    for (const directory of pathEntries) {
      const path = join(directory, isWindows ? `${basename}.exe` : program);
      if (await available(path)) return { executable: path, args: argv };
    }
  }
  return null;
}

function environment(directory, pathEntries) {
  const inherited = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => /^(?:systemroot|windir|systemdrive|comspec|pathext|programfiles|programfiles\(x86\)|programw6432|lang|lc_all)$/iu.test(key)));
  return {
    ...inherited,
    OPENSPEC_TELEMETRY: '0',
    PATH: [dirname(process.execPath), ...pathEntries].join(delimiter),
    HOME: directory,
    USERPROFILE: directory,
    APPDATA: join(directory, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(directory, 'AppData', 'Local'),
    TMPDIR: directory,
    TEMP: directory,
    TMP: directory,
    NO_COLOR: '1',
    CI: 'true',
    npm_config_cache: join(directory, 'npm-cache'),
    npm_config_userconfig: join(directory, 'user.npmrc'),
    npm_config_globalconfig: join(directory, 'global.npmrc'),
    npm_config_fund: 'false',
    npm_config_audit: 'false',
  };
}

async function* outputLines(stream) {
  stream.setEncoding('utf8');
  let pending = '';
  let oversized = false;
  for await (const chunk of stream) {
    const lines = chunk.split('\n');
    for (let index = 0; index < lines.length; index++) {
      const fragment = lines[index];
      oversized ||= pending.length + fragment.length > maxLineLength;
      if (!oversized) pending += fragment;
      if (index === lines.length - 1) break;
      yield oversized ? '（过长的输出行已省略）' : pending.replace(/\r$/u, '');
      pending = '';
      oversized = false;
    }
  }
  if (oversized) yield '（过长的输出行已省略）';
  else if (pending) yield pending;
}

async function execute({ invocation, workspace, env, timeoutMs, capture }) {
  const child = spawn(invocation.executable, invocation.args, {
    cwd: workspace, env, windowsHide: true, detached: !isWindows, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let spawnError;
  let timedOut = false;
  const closed = new Promise((done) => {
    child.once('error', (error) => { spawnError = error; });
    child.once('close', (code, signal) => done({ code, signal }));
  });
  const consume = async (stream) => {
    for await (const line of outputLines(child[stream])) await capture(line, stream);
  };
  let cleanup;
  const stop = () => cleanup ??= terminateProcessTree(child).catch(() => child.kill('SIGKILL')).finally(() => {
    child.stdout.destroy();
    child.stderr.destroy();
  });
  const timer = setTimeout(() => {
    timedOut = true;
    void stop();
  }, timeoutMs);
  try {
    const [result] = await Promise.all([closed, consume('stdout'), consume('stderr')]);
    return { ...result, spawnError, timedOut };
  } catch (error) {
    await stop();
    await closed;
    return { spawnError: error, timedOut };
  } finally {
    clearTimeout(timer);
    await cleanup;
  }
}

function resultStatus(result, command) {
  if (result.timedOut) return ['error', `命令超时（${command.timeoutMs} 毫秒）。`];
  if (result.spawnError) {
    const code = launchErrorCodes.test(result.spawnError.code ?? '') ? `（${result.spawnError.code}）` : '';
    return ['error', `无法执行 ${command.program}${code}。`];
  }
  if (result.signal) return ['error', `命令提前终止（${result.signal}）。`];
  if (result.code !== 0) return ['fail', `命令退出码为 ${result.code}。`];
  return ['pass', '命令成功完成。'];
}

export async function runProjectChecks({ workspace, artifactDir, stateDir, commands, report, onEvent = () => {} }) {
  if (!Array.isArray(commands) || !commands.every(validCommand)
    || new Set(commands.map(({ id }) => id)).size !== commands.length) {
    throw new Error('项目命令清单无效。');
  }
  if (commands.length === 0) return { ok: true, results: [] };
  const pathEntries = searchDirectories(workspace);
  const tempRoot = resolve(tmpdir());
  const directory = stateDir ? resolve(stateDir) : await mkdtemp(join(tempRoot, 'vibe-bench-checks-'));
  if (stateDir) await mkdir(directory, { recursive: true });
  const env = environment(directory, pathEntries);
  await Promise.all([mkdir(env.APPDATA, { recursive: true }), mkdir(env.LOCALAPPDATA, { recursive: true })]);
  const results = [];
  try {
    for (const command of commands) {
      const { id, label, phase, program, args, timeoutMs } = command;
      const display = redactOutput([program, ...args.map((arg) =>
        /^[\w./:=@-]+$/u.test(arg) ? arg : JSON.stringify(arg))].join(' '));
      const file = `project-command-${id}.log`;
      const artifacts = [{ file, label: `${redactOutput(label)}日志` }];
      await report(id, 'running', '正在运行已审核的项目命令。');
      await onEvent({ kind: 'command', phase, summary: redactOutput(label), detail: display.slice(0, 500), checkId: id });

      let output = '';
      let clipped = false;
      let liveCount = 0;
      let lastLive = 0;
      let latest;
      async function capture(raw, stream) {
        const line = redactOutput(raw).replaceAll('\r', ' ').trimEnd();
        output += `[${stream}] ${line}\n`;
        if (output.length > maxLogLength) {
          clipped = true;
          output = output.slice(output.indexOf('\n', output.length - maxLogLength) + 1);
        }
        if (!line.trim()) return;
        latest = { kind: 'command-output', phase, summary: line.slice(0, 500), checkId: id, stream };
        const now = Date.now();
        if (liveCount >= 79 || (liveCount >= 10 && now - lastLive < 500)) return;
        liveCount++;
        lastLive = now;
        const event = latest;
        latest = null;
        await onEvent(event);
      }
      const started = Date.now();
      const invocation = await commandInvocation(program, args, pathEntries);
      const result = invocation
        ? await execute({ invocation, workspace, env, timeoutMs, capture })
        : { spawnError: { code: 'ENOENT' } };
      if (latest) await onEvent(latest);
      const [status, summary] = resultStatus(result, command);
      await writeFile(join(artifactDir, file),
        `$ ${display}\n${clipped ? '（已省略较早的输出）\n' : ''}${output}\n${summary} 用时 ${Date.now() - started} 毫秒。\n`,
        'utf8');
      await report(id, status, summary, artifacts);
      results.push({ id, status, summary, artifacts });
    }
  } finally {
    if (!stateDir && dirname(directory) === tempRoot && basename(directory).startsWith('vibe-bench-checks-')) {
      await rm(directory, { recursive: true, force: true, maxRetries: 3 });
    }
  }
  return { ok: results.every(({ status }) => status === 'pass'), results };
}
