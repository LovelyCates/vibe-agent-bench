import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openCases } from './lib/cases.mjs';
import { readRunEvents, redactLog } from './lib/run-events.mjs';
import { openRuns } from './lib/runs.mjs';
import { scenarios } from './lib/scenarios.mjs';
import { listSkillProfiles, matchesSkillLocks } from './lib/skill-packs.mjs';

const root = fileURLToPath(new URL('./', import.meta.url));
const defaultProject = join(root, 'fixture');
const htmlType = 'text/html; charset=utf-8';
const cssType = 'text/css; charset=utf-8';
const jsType = 'text/javascript; charset=utf-8';
const webFiles = {
  '/benchmark': ['index.html', htmlType],
  '/styles.css': ['styles.css', cssType],
  '/app.js': ['app.js', jsType],
  '/workbench.css': ['workbench.css', cssType],
  '/workbench.js': ['workbench.js', jsType],
  '/workbench-highlight.js': ['workbench-highlight.js', jsType],
  '/workbench-highlight.css': ['workbench-highlight.css', cssType],
  '/workbench-mascot.webp': ['workbench-mascot.webp', 'image/webp'],
};
const imageTypes = new Map([['.png', 'image/png'], ['.webp', 'image/webp'], ['.jpg', 'image/jpeg']]);

function json(response, code, body) {
  response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

async function bodyOf(request) {
  let body = '';
  request.setEncoding('utf8');
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 128 * 1024) return null;
  }
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

async function serveArtifact(response, directory, file) {
  try {
    const base = await realpath(directory);
    const path = await realpath(resolve(base, file));
    const fromBase = relative(base, path);
    if (!fromBase || fromBase === '..' || fromBase.startsWith(`..${sep}`) || isAbsolute(fromBase)) return false;
    const info = await stat(path);
    if (!info.isFile()) return false;
    response.writeHead(200, {
      'Content-Type': imageTypes.get(extname(path)) ?? 'text/plain; charset=utf-8',
      'Content-Length': info.size,
    });
    const stream = createReadStream(path);
    stream.on('error', (error) => response.destroy(error));
    stream.pipe(response);
    return true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return false;
  }
}

async function sourcePreview(response, testCase, file) {
  if (!file || !testCase.sourceFiles.includes(file)) return json(response, 404, { error: '这份文件未列入当前用例。' });
  let content;
  try {
    const base = await realpath(testCase.projectDir);
    if (relative(testCase.projectDir, base)) return json(response, 404, { error: '项目目录已移至其他位置。' });
    const path = await realpath(resolve(base, file));
    if (relative(base, path).split(sep).join('/') !== file) return json(response, 404, { error: '源文件位置已变更。' });
    const info = await stat(path);
    if (!info.isFile() || info.size > 256 * 1024) return json(response, 413, { error: '仅预览不超过 256 KiB 的文本文件。' });
    content = await readFile(path);
  } catch (error) {
    if (!['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) throw error;
    return json(response, 404, { error: '当前无法读取该源文件。' });
  }
  if (content.includes(0)) return json(response, 415, { error: '当前文件为二进制。' });
  return json(response, 200, { file, content: redactLog(content.toString('utf8')) });
}

export async function startServer({ port = Number(process.env.PORT ?? 4317), runsDir = join(root, 'runs'), casesDir = join(root, 'cases') } = {}) {
  const [runs, cases] = await Promise.all([openRuns(resolve(runsDir)), openCases(resolve(casesDir), { defaultProject })]);
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'");
    try {
      const actualPort = server.address().port;
      const host = request.headers.host;
      const expectedPort = actualPort === 80 ? '' : `:${actualPort}`;
      if (host !== `127.0.0.1${expectedPort}` && host !== `localhost${expectedPort}`) {
        return json(response, 403, { error: '请通过本机地址访问评测台。' });
      }
      const { pathname, searchParams } = new URL(request.url, 'http://127.0.0.1');
      const method = request.method;
      const caseRoute = pathname.match(/^\/api\/cases\/([0-9a-f-]{36})(?:\/(source|run))?$/u);
      if (method === 'GET' && (pathname === '/' || Object.hasOwn(webFiles, pathname))) {
        const linkedRun = runs.get(searchParams.get('run'));
        const olderReport = searchParams.has('experiment') || (linkedRun && !linkedRun.caseId);
        const [file, type] = pathname === '/' ? [olderReport ? 'index.html' : 'workbench.html', htmlType] : webFiles[pathname];
        const content = await readFile(join(root, 'web', file));
        response.writeHead(200, { 'Content-Type': type });
        return response.end(content);
      }
      if (method === 'GET' && pathname === '/api/cases') {
        return json(response, 200, { cases: cases.list(), defaultProject, scenarios, skillProfiles: await listSkillProfiles() });
      }
      if (method === 'GET' && caseRoute && caseRoute[2] !== 'run') {
        const testCase = cases.get(caseRoute[1]);
        if (!testCase) return json(response, 404, { error: '找不到该评测用例。' });
        if (caseRoute[2] === 'source') return await sourcePreview(response, testCase, searchParams.get('file'));
        return json(response, 200, { case: testCase });
      }
      if (pathname === '/api/runs' && method === 'GET') return json(response, 200, { runs: runs.list() });
      const createRun = method === 'POST' && ['/api/runs', '/api/experiments'].includes(pathname);
      const createCase = method === 'POST' && pathname === '/api/cases';
      const updateCase = method === 'PUT' && caseRoute && !caseRoute[2];
      const startCase = method === 'POST' && caseRoute?.[2] === 'run';
      if (createRun || createCase || updateCase || startCase) {
        if (request.headers.origin && request.headers.origin !== `http://${host}`) {
          return json(response, 403, { error: '请从评测台页面发起运行。' });
        }
        const contentType = request.headers['content-type']?.split(';')[0]?.trim();
        if (contentType !== 'application/json') return json(response, 415, { error: '请求需要 JSON。' });
        const body = await bodyOf(request);
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          return json(response, 400, { error: '请求需要 JSON 对象。' });
        }
        if (createCase) return json(response, 201, { case: await cases.create(body) });
        if (updateCase) return json(response, 200, { case: await cases.update(caseRoute[1], body) });
        if (startCase) {
          const testCase = cases.get(caseRoute[1]);
          if (!testCase) return json(response, 404, { error: '找不到该评测用例。' });
          if (testCase.version !== body.version || testCase.status !== 'approved') {
            return json(response, 409, { error: '请先审查并通过当前版本。' });
          }
          const selected = (await listSkillProfiles()).find(({ id }) => id === (testCase.skillProfile ?? 'none'));
          if (!selected || !matchesSkillLocks(selected.packs, testCase.skillLocks)) {
            return json(response, 409, { error: '本机 Skill 包与已审核版本不同，请重新审查配置。' });
          }
          const run = await runs.createCase(testCase);
          if (!run) return json(response, 409, { error: '已有评测或对照实验正在执行。' });
          return json(response, 202, { run });
        }
        if (pathname === '/api/experiments') {
          const experiment = await runs.createExperiment();
          if (!experiment) return json(response, 409, { error: '已有评测或对照实验正在执行。' });
          return json(response, 202, experiment);
        }
        const mode = body?.mode;
        const skillMode = body.skillMode ?? 'with';
        if (mode !== 'codex' && mode !== 'opencode' && mode !== 'demo') {
          return json(response, 400, { error: '请选择 Codex、OpenCode 或演示。' });
        }
        if (skillMode !== 'with' && skillMode !== 'without') {
          return json(response, 400, { error: '请选择有 Skill 或无 Skill。' });
        }
        const run = await runs.create(mode, skillMode);
        if (!run) return json(response, 409, { error: '已有评测或对照实验正在执行。' });
        return json(response, 202, { run });
      }
      const eventRoute = pathname.match(/^\/api\/runs\/([0-9a-f-]{36})\/events$/u);
      if (eventRoute && method === 'GET') {
        const run = runs.get(eventRoute[1]);
        if (!run) return json(response, 404, { error: '找不到这次运行。' });
        const cursor = searchParams.get('after') ?? '0';
        const after = Number(cursor);
        if (!/^\d+$/u.test(cursor) || !Number.isSafeInteger(after)) return json(response, 400, { error: '无效的事件序号。' });
        const events = await readRunEvents(join(runsDir, run.id), after);
        return json(response, 200, { events, lastSeq: events.at(-1)?.seq ?? after, status: run.status });
      }
      const match = pathname.match(/^\/api\/runs\/([0-9a-f-]{36})(?:\/artifacts\/(.+))?$/u);
      if (match && method === 'GET') {
        const [, id, encoded] = match;
        const run = runs.get(id);
        if (!run) return json(response, 404, { error: '找不到这次运行。' });
        if (!encoded) return json(response, 200, { run });
        let file;
        try {
          file = decodeURIComponent(encoded);
        } catch {
          return json(response, 400, { error: '证据路径无效。' });
        }
        const artifacts = [...run.checks.flatMap((check) => check.artifacts), ...(run.advice.artifacts ?? [])];
        if (artifacts.some((artifact) => artifact.file === file)) {
          const directory = join(runsDir, id, 'artifacts');
          if (await serveArtifact(response, directory, file)) return;
        }
        return json(response, 404, { error: '找不到这份证据。' });
      }
      return json(response, 404, { error: '找不到此页面。' });
    } catch (error) {
      if (response.headersSent) return response.destroy(error);
      if ([400, 404, 409].includes(error.status)) return json(response, error.status, { error: error.message });
      console.error(redactLog(error.stack));
      return json(response, 500, { error: '评测台内部错误。' });
    }
  });
  await new Promise((ready, failed) => {
    server.once('error', failed);
    server.listen(port, '127.0.0.1', ready);
  });
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const { url } = await startServer();
  console.log(`Vibe Coding Agent 评测台 ${url}`);
}
