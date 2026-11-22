import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { compileBackend, spawnBackend, stopBackend } from '../../scripts/java-backend.mjs';

export async function startBackend() {
  const classes = await mkdtemp(join(tmpdir(), 'task-board-test-'));
  let child;
  let closed;

  const stop = async () => {
    stopBackend(child);
    await closed;
    await rm(classes, { recursive: true, force: true, maxRetries: 3 });
  };

  try {
    compileBackend(classes);
    child = spawnBackend(classes, 0, { stdio: ['ignore', 'pipe', 'pipe'] });
    let startupError = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { startupError = (startupError + chunk).slice(-8_000); });
    closed = new Promise((done) => {
      child.once('error', (error) => { startupError = error.message; });
      child.once('close', (code, signal) => done({ code, signal }));
    });
    const lines = createInterface({ input: child.stdout });
    try {
      const ready = new Promise((done) => {
        lines.on('line', (line) => {
          const match = /^TASK_BOARD_READY (http:\/\/127\.0\.0\.1:\d+)$/u.exec(line);
          if (match) done(match[1]);
        });
      });
      const url = await Promise.race([
        ready,
        closed.then(() => null),
        delay(15_000, null, { ref: false }),
      ]);
      if (!url) throw new Error(`Java 服务未开始监听。${startupError}`);
      console.log(`Java HTTP 服务已启动于 ${url}`);
      return { url, stop };
    } finally {
      lines.close();
      child.stdout.resume();
    }
  } catch (error) {
    await stop();
    throw error;
  }
}
