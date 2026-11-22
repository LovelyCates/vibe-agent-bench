import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

export const nodeEnvironment = Object.fromEntries(Object.entries(process.env)
  .filter(([key]) => /^(path|systemroot|windir|temp|tmp|systemdrive)$/i.test(key)));

export function runNode(args, cwd, env = {}) {
  const isWindows = process.platform === "win32";
  const child = spawn(process.execPath, args, {
    cwd,
    detached: !isWindows,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...nodeEnvironment, ...env },
  });
  const state = { stdout: "", stderr: "", result: null };
  for (const key of ["stdout", "stderr"]) {
    child[key].setEncoding("utf8");
    child[key].on("data", (chunk) => {
      state[key] = (state[key] + chunk).slice(-1_000_000);
    });
  }
  const closed = new Promise((resolve) => {
    child.once("error", (error) => {
      state.result = { code: null, error: error.message };
      resolve(state.result);
    });
    child.once("close", (code, signal) => {
      state.result ??= { code, signal };
      resolve(state.result);
    });
  });
  function stop() {
    if (state.result || !child.pid) return;
    if (isWindows) {
      spawnSync("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
        timeout: 4000,
        stdio: "ignore",
        windowsHide: true,
      });
      child.kill("SIGKILL");
      return;
    }
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  return {
    state,
    close: async () => {
      stop();
      return closed;
    },
    async wait(timeoutMs) {
      const timer = new AbortController();
      const timeout = delay(timeoutMs, null, { signal: timer.signal }).catch(() => null);
      const result = await Promise.race([closed, timeout]);
      timer.abort();
      if (result) return result;
      stop();
      await closed;
      return { code: null, timedOut: true };
    },
  };
}

export async function readHttp(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
  const contentType = response.headers.get("content-type");
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, contentType, body };
}

export async function waitForService(processHandle, name) {
  const deadline = Date.now() + 8000;
  let lastFailure = "等待服务输出监听端口";
  while (Date.now() < deadline) {
    if (processHandle.state.result) {
      throw new Error(`服务提前退出 ${JSON.stringify(processHandle.state.result)}`);
    }
    const readyLines = processHandle.state.stdout.split("\n").slice(0, -1);
    for (const line of readyLines) {
      let ready;
      try {
        ready = JSON.parse(line);
      } catch {
        continue;
      }
      if (ready?.service !== name || !Number.isInteger(ready.port) || ready.port < 1 || ready.port > 65535) continue;
      const url = `http://127.0.0.1:${ready.port}`;
      try {
        const health = await readHttp(`${url}/health`);
        if (health.status === 200 && health.body?.service === name && health.body?.ready === true) {
          return { url, health };
        }
        lastFailure = `健康探针响应 ${JSON.stringify(health)}`;
      } catch (error) {
        lastFailure = error.message;
      }
    }
    await delay(100);
  }
  throw new Error(lastFailure);
}
