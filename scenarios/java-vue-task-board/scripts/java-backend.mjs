import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../backend/src/main/java/', import.meta.url));
const mainClass = 'ops.taskboard.TaskBoardServer';

export function compileBackend(classes, { lint = false } = {}) {
  const files = readdirSync(source, { recursive: true, withFileTypes: true })
    .filter((file) => file.isFile() && file.name.endsWith('.java'))
    .map((file) => join(file.parentPath, file.name))
    .sort();
  const compiler = spawnSync('javac', [
    '--release', '17', '-encoding', 'UTF-8', '-d', classes,
    ...(lint ? ['-Xlint:all', '-Werror'] : []),
    ...files,
  ], { stdio: 'inherit', windowsHide: true });

  if (compiler.error) throw compiler.error;
  if (compiler.status !== 0) throw new Error('Java 编译失败。');
}

export function spawnBackend(classes, port, options = {}) {
  return spawn('java', ['-cp', classes, mainClass, String(port)], { windowsHide: true, ...options });
}

export function stopBackend(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    // The Windows Java launcher may start the JVM as a separate process.
    spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore', timeout: 4_000, windowsHide: true,
    });
  }
  child.kill();
}

async function run(mode, port) {
  const classes = mkdtempSync(join(tmpdir(), 'task-board-classes-'));
  try {
    compileBackend(classes, { lint: mode === 'lint' });
    if (mode === 'lint') {
      console.log('Java compiler lint passed (-Xlint:all -Werror).');
      return;
    }
    const child = spawnBackend(classes, port ?? '8180', { stdio: 'inherit' });
    const stop = () => stopBackend(child);
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      process.exitCode = await new Promise((done, reject) => {
        child.once('error', reject);
        child.once('close', (code) => done(code ?? 0));
      });
    } finally {
      process.off('SIGTERM', stop);
      process.off('SIGINT', stop);
    }
  } finally {
    rmSync(classes, { recursive: true, force: true, maxRetries: 3 });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , mode, port] = process.argv;
  if (!['serve', 'lint'].includes(mode)) throw new Error('用法：node scripts/java-backend.mjs {serve [port]|lint}');
  await run(mode, port);
}
