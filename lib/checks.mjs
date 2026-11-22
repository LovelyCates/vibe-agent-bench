import { ESLint } from "eslint";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser, probeBrowser } from "./check-browser.mjs";
import { probeApi } from "./check-contract.mjs";
import { verifyMutation } from "./check-mutation.mjs";
import { runNode, waitForService } from "./check-process.mjs";

export const fixtureRoot = fileURLToPath(new URL("../fixture/", import.meta.url));
export const protectedFiles = [
  "README.md", "backend/server.mjs", "backend/seed.mjs", "backend/task-store.mjs", "frontend/server.mjs",
];

const testPattern = /^test\/.+\.test\.mjs$/;

async function scanFiles(root, path) {
  const actual = join(root, path);
  const info = await lstat(actual).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  if (!info) return [];
  if (info.isSymbolicLink()) throw new Error(`样例目录中包含符号链接 ${path}`);
  if (info.isFile()) return [path];
  if (!info.isDirectory()) throw new Error(`样例包含不支持的文件类型 ${path}`);
  const entries = await readdir(actual);
  const children = await Promise.all(entries.map((entry) => scanFiles(root, `${path}/${entry}`)));
  return children.flat();
}

async function changedTests(workspace, files) {
  const result = [];
  for (const file of files.filter((path) => testPattern.test(path))) {
    const baseline = await readFile(join(fixtureRoot, file)).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    if (!baseline || !(await readFile(join(workspace, file))).equals(baseline)) result.push(file);
  }
  return result;
}

async function inspectCode(workspace, files) {
  const common = ["console", "URL", "URLSearchParams", "AbortController", "AbortSignal", "fetch",
    "TextEncoder", "TextDecoder", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "structuredClone"];
  const globals = (names) => Object.fromEntries([...common, ...names].map((name) => [name, "readonly"]));
  const eslint = new ESLint({
    cwd: workspace,
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ["**/*.mjs", "**/*.js"],
        languageOptions: { ecmaVersion: "latest", sourceType: "module" },
        linterOptions: { noInlineConfig: true },
        rules: {
          eqeqeq: "error", "no-debugger": "error", "no-dupe-keys": "error", "no-undef": "error",
          "no-unused-vars": ["error", { args: "after-used", caughtErrors: "none" }],
          "no-unreachable": "error", "no-var": "error",
        },
      },
      { files: ["backend/**", "test/**", "frontend/server.mjs"],
        languageOptions: { globals: globals(["Buffer", "process", "global", "setImmediate", "clearImmediate"]) } },
      { files: ["frontend/**"], ignores: ["frontend/server.mjs"],
        languageOptions: { globals: globals(["document", "location", "window", "history", "HTMLElement", "Event"]) } },
    ],
  });
  const sources = files.filter((file) => /\.(mjs|js)$/.test(file));
  const results = await eslint.lintFiles(sources);
  return results.map(({ filePath, messages }) => ({ filePath, messages }));
}

async function start(name, workspace, env = {}) {
  const handle = runNode([`${name}/server.mjs`], workspace, { PORT: "0", ...env });
  try {
    return { handle, ready: await waitForService(handle, name) };
  } catch (error) {
    return { handle, error: error.message };
  }
}

export async function evaluateWorkspace({ workspace, artifactDir, report }) {
  await mkdir(artifactDir, { recursive: true });
  async function record(file, label, data) {
    await mkdir(dirname(join(artifactDir, file)), { recursive: true });
    await writeFile(join(artifactDir, file), `${JSON.stringify(data, null, 2)}\n`, "utf8");
    return { file, label };
  }

  await report("code", "running", "检查样例完整性和代码规范。", []);
  let files = [];
  const integrity = [];
  let integrityOk = false;
  try {
    files = (await Promise.all(["backend", "frontend", "test"].map((path) => scanFiles(workspace, path)))).flat().sort();
    for (const file of protectedFiles) {
      const original = await readFile(join(fixtureRoot, file));
      const candidatePath = join(workspace, file);
      const info = await lstat(candidatePath).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
      const candidate = info?.isFile() && await readFile(candidatePath);
      integrity.push({ file, unchanged: Boolean(candidate && original.equals(candidate)) });
    }
    integrityOk = integrity.every(({ unchanged }) => unchanged);
    const diagnostics = await inspectCode(workspace, files);
    const warnings = diagnostics.reduce((count, { messages }) => count + messages.length, 0);
    const evidence = await record("code.json", "ESLint 诊断与文件完整性", { integrity, diagnostics });
    const passed = integrityOk && warnings === 0;
    const summary = passed ? `受保护文件完整，${diagnostics.length} 个源码文件通过 ESLint。`
      : `受保护文件${integrityOk ? "完整" : "存在改动"}，ESLint 报告 ${warnings} 条问题。`;
    await report("code", passed ? "pass" : "fail", summary, [evidence]);
  } catch (error) {
    const evidence = await record("code.json", "代码检查错误", { integrity, error: error.message });
    await report("code", "error", error.message, [evidence]);
  }
  if (!integrityOk) {
    for (const id of ["backend", "frontend", "api", "browser", "mutation"]) {
      await report(id, "blocked", "样例基础文件完整性验证未通过。", []);
    }
    return;
  }

  const services = [];
  function recordService(name, file, result) {
    return record(file, `${name === "backend" ? "后端" : "前端"}启动日志`, {
      ...result.handle.state, readiness: result.ready, error: result.error,
    });
  }
  async function service(id, env, checkId = id) {
    const result = await start(id, workspace, env);
    const file = `${checkId}.json`;
    services.push({ id, file, result });
    const evidence = await recordService(id, file, result);
    return { ...result, evidence };
  }

  try {
    await report("backend", "running", "启动后端并检查健康接口。", []);
    const backend = await service("backend");
    await report("backend", backend.ready ? "pass" : "fail", backend.ready
      ? `后端健康接口返回 HTTP ${backend.ready.health.status}。` : backend.error, [backend.evidence]);

    await report("frontend", "running", "启动前端并检查健康接口。", []);
    const frontend = await service("frontend", { BACKEND_URL: backend.ready?.url ?? "http://127.0.0.1:1" });
    await report("frontend", frontend.ready ? "pass" : "fail", frontend.ready
      ? `前端健康接口返回 HTTP ${frontend.ready.health.status}。` : frontend.error, [frontend.evidence]);

    if (backend.ready) {
      await report("api", "running", "向后端发起 API 契约请求。", []);
      const trace = [];
      const failed = await probeApi(backend.ready.url, trace);
      const evidence = await record("api.json", "API 请求与断言", { trace, failed });
      await report("api", failed ? "fail" : "pass", failed ? `${trace.length} 项 API 契约检查中 ${failed} 项失败。`
        : "默认列表、三个状态、响应结构和非法值通过验证。", [evidence]);
    } else {
      await report("api", "blocked", "后端未通过启动检查。", []);
    }

    if (frontend.ready && backend.ready) {
      await report("browser", "running", "真实浏览器校验筛选请求、页面行和空结果。", []);
      const trace = [];
      const artifacts = [];
      let browser;
      let error;
      let status = "pass";
      try {
        browser = await launchBrowser();
        await probeBrowser(browser, { baseUrl: frontend.ready.url, artifactDir, trace, artifacts });
        const emptyBackend = await service("backend", { TASK_SEED: "without-completed" }, "browser-empty-backend");
        artifacts.push(emptyBackend.evidence);
        if (!emptyBackend.ready) throw new Error(emptyBackend.error);
        const emptyFrontend = await service("frontend", { BACKEND_URL: emptyBackend.ready.url }, "browser-empty-frontend");
        artifacts.push(emptyFrontend.evidence);
        if (!emptyFrontend.ready) throw new Error(emptyFrontend.error);
        await probeBrowser(browser, { baseUrl: emptyFrontend.ready.url, empty: true, artifactDir, trace, artifacts });
      } catch (failure) {
        error = failure.message;
        status = browser ? "fail" : "error";
      } finally {
        if (browser) await browser.close();
      }
      artifacts.unshift(await record("browser.json", "浏览器网络与 DOM 记录", { trace, error }));
      await report("browser", status, error ? "真实浏览器联调未通过，请查看网络与 DOM 记录。"
        : "真实浏览器验证了状态切换、恢复全部和空结果。", artifacts);
    } else {
      await report("browser", "blocked", "前后端均需通过启动检查。", []);
    }
  } finally {
    await Promise.all(services.map(async ({ id, file, result }) => {
      await result.handle.close();
      await recordService(id, file, result);
    }));
  }

  await report("mutation", "running", "在两个临时副本内验证 Agent 测试。", []);
  const trace = {};
  let outcome;
  try {
    outcome = await verifyMutation(workspace, await changedTests(workspace, files), trace);
  } catch (error) {
    trace.error = error.message;
    outcome = ["error", "变异评测执行时出现异常。"];
  }
  const evidence = await record("mutation.json", "缺陷复现与测试日志", trace);
  await report("mutation", ...outcome, [evidence]);
}
