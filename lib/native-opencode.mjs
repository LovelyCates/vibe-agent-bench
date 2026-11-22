import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join, parse, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { redactOutput, terminateProcessTree } from './project-run.mjs';

const pinnedVersion = '1.19.6';
const windows = process.platform === 'win32';
const turnTimeoutMs = 900_000;
const exec = promisify(execFile);
const posixPath = (value) => value.replaceAll('\\', '/');
const includedEnvironment = /^(path|systemroot|windir|systemdrive|comspec|pathext|programfiles|programfiles\(x86\)|programw6432)$/iu;

async function nativeExecutable() {
  const configured = process.env.VIBE_BENCH_OPENCODE_BIN;
  if (configured) return resolve(configured);
  const platform = windows ? 'windows' : process.platform;
  const filename = windows ? 'opencode.exe' : 'opencode';
  for (const dependency of [`opencode-${platform}-${process.arch}`, 'opencode-ai']) {
    const path = fileURLToPath(new URL(`../node_modules/${dependency}/bin/${filename}`, import.meta.url));
    if ((await stat(path).catch(() => null))?.isFile()) return path;
  }
  return filename;
}

function editsFor(workspace, policy) {
  const edits = { '*': 'deny' };
  const prefixes = ['', posixPath(relative(parse(workspace).root, workspace)) + '/', posixPath(workspace) + '/'];
  if (policy) {
    for (const prefix of prefixes.slice(1)) edits[prefix + '*'] = 'allow';
    for (const prefix of prefixes) {
      for (const file of policy.protectedPaths) edits[prefix + file] = 'deny';
    }
    return edits;
  }
  for (const prefix of prefixes) {
    for (const directory of ['.opencode/openspec/changes', 'workspace/frontend/src']) {
      edits[`${prefix}${directory}/*`] = 'allow';
    }
    edits[`${prefix}.opencode/openspec/changes/archive/*`] = 'deny';
  }
  return edits;
}

function shellPermission(policy) {
  const bash = { '*': 'deny' };
  if (policy) {
    for (const launcher of policy.openSpecLaunchers) {
      for (const args of ['list', 'list --json', 'status *', 'instructions *', 'new change *', 'validate *', 'schemas', 'schemas --json', 'show *']) {
        bash[`${launcher} ${args}`] = 'allow';
      }
    }
    for (const { program, args, phase } of policy.commands) {
      if (phase !== 'verify' || !/^(?:npm|pnpm|yarn)$/u.test(program) || !args.every((arg) => /^[\w./:@-]+$/u.test(arg))) continue;
      const runAt = args.indexOf('run');
      if (runAt !== 0 && !(runAt === 2 && args[0] === '--prefix')) continue;
      if (!/^(?:test(?::[\w:-]+)?|type-check|typecheck|lint|check|build)$/u.test(args[runAt + 1] ?? '')) continue;
      for (const executable of [program, `${program}.cmd`]) bash[[executable, ...args].join(' ')] = 'allow';
    }
    return bash;
  }
  for (const args of ['list', 'list --json', 'status *', 'instructions *', 'new change *', 'validate *', 'schemas', 'schemas --json', 'show *']) {
    for (const script of ['.opencode/.tools/openspec.mjs', './.opencode/.tools/openspec.mjs']) {
      bash[`node ${script} ${args}`] = 'allow';
    }
  }
  for (const program of ['npm', 'npm.cmd']) {
    for (const path of ['', '--prefix workspace/frontend ']) {
      for (const args of ['run test:unit -- --run', 'run test:unit -- --run src/data/__tests__/bench-acceptance-hold.spec.ts',
        'run build', 'run type-check']) bash[`${program} ${path}${args}`] = 'allow';
    }
  }
  return bash;
}

function runConfiguration(workspace, modelConfig, keyFile, policy) {
  const { preset, model, baseURL, reasoningEffort, apiStyle } = modelConfig;
  const responses = apiStyle === 'responses';
  const selection = `${preset}/${model}`;
  const reviewerNames = policy ? policy.subagents : ['code-reviewer'];
  return {
    autoupdate: false, share: 'disabled', snapshot: false, formatter: false, lsp: false,
    enabled_providers: [preset], model: selection, small_model: selection,
    ...(policy?.skillPaths.length && { skills: { paths: policy.skillPaths.map(posixPath) } }),
    provider: {
      [preset]: {
        npm: responses ? '@ai-sdk/openai' : '@ai-sdk/openai-compatible',
        options: { baseURL, ...(keyFile && { apiKey: `{file:${posixPath(keyFile)}}` }) },
        whitelist: [model],
        models: {
          [model]: {
            reasoning: responses || preset === 'deepseek' || Boolean(reasoningEffort),
            tool_call: true,
            ...(preset === 'deepseek' && { interleaved: { field: 'reasoning_content' } }),
            ...(reasoningEffort && {
              options: { reasoningEffort },
              variants: { [reasoningEffort]: { reasoningEffort } },
            }),
          },
        },
      },
    },
    permission: {
      '*': 'deny', read: 'allow', glob: 'allow', grep: 'allow', list: 'allow', todowrite: 'allow',
      external_directory: 'deny', skill: 'allow', question: 'allow',
      task: { '*': 'deny', ...Object.fromEntries(reviewerNames.map((name) => [name, 'allow'])) },
      edit: editsFor(workspace, policy), bash: shellPermission(policy),
    },
    agent: Object.fromEntries(reviewerNames.map((name) => [name, {
      mode: 'subagent', model: selection,
      permission: { ...(policy && { '*': 'deny', read: 'allow', glob: 'allow', grep: 'allow', list: 'allow', skill: 'allow' }),
        edit: 'deny', bash: 'deny', task: 'deny', external_directory: 'deny' },
    }])),
  };
}

async function environment(stateDir, workspace, modelConfig, key, password, policy) {
  const home = join(stateDir, 'home');
  const temporary = join(stateDir, 'temp');
  const roaming = join(home, 'AppData', 'Roaming');
  const local = join(home, 'AppData', 'Local');
  await Promise.all([roaming, local, temporary].map((path) => mkdir(path, { recursive: true })));
  const keyFile = key ? join(stateDir, 'provider-key') : null;
  if (keyFile) await writeFile(keyFile, key, { mode: 0o600 });
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => includedEnvironment.test(name)));
  const pathKey = Object.keys(inherited).find((name) => name.toLowerCase() === 'path') ?? 'PATH';
  inherited[pathKey] = [dirname(process.execPath), inherited[pathKey]].filter(Boolean).join(delimiter);
  return {
    ...inherited,
    HOME: home, USERPROFILE: home, APPDATA: roaming, LOCALAPPDATA: local,
    TMPDIR: temporary, TEMP: temporary, TMP: temporary,
    XDG_CONFIG_HOME: join(stateDir, 'config'), XDG_DATA_HOME: join(stateDir, 'data'),
    XDG_STATE_HOME: join(stateDir, 'state'), XDG_CACHE_HOME: join(stateDir, 'cache'),
    OPENCODE_TEST_HOME: home, OPENCODE_TEST_MANAGED_CONFIG_DIR: join(stateDir, 'managed'),
    OPENCODE_DISABLE_DEFAULT_PLUGINS: '1', OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
    OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_DISABLE_SHARE: '1', OPENSPEC_TELEMETRY: '0', CI: 'true',
    OPENCODE_CLIENT: 'cli', OPENCODE_SERVER_USERNAME: 'bench', OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(runConfiguration(workspace, modelConfig, keyFile, policy)),
  };
}

function redacted(value, secrets) {
  if (typeof value === 'string') return secrets.reduce((text, secret) => redactOutput(text, secret), value);
  if (Array.isArray(value)) return value.map((entry) => redacted(entry, secrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, redacted(entry, secrets)]));
  }
  return value;
}

function boundedSignal(signal, ms) {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
}

async function waitForAddress(child, signal, scrub) {
  let pending = '';
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-3500);
  });
  return new Promise((ready, fail) => {
    function onOutput(chunk) {
      pending = (pending + chunk).slice(-6000);
      const address = pending.match(/http:\/\/127\.0\.0\.1:(\d+)/u)?.[0];
      if (address) finish(null, address);
    }
    function onExit(code) {
      finish(new Error(`OpenCode 服务提前退出（${code ?? '未知'}）${stderr.trim() ? `。 ${scrub(stderr.trim()).slice(-500)}` : '。'}`));
    }
    function onAbort() {
      finish(new Error('OpenCode 服务启动超时或已取消。'));
    }
    function finish(error, address) {
      child.stdout.off('data', onOutput);
      child.stdout.resume();
      child.off('close', onExit);
      child.off('error', finish);
      signal.removeEventListener('abort', onAbort);
      if (error) fail(error);
      else ready(address);
    }
    child.stdout.on('data', onOutput);
    child.once('close', onExit);
    child.once('error', finish);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

export async function openNativeOpenCode({ workspace, stateDir, config, key, signal, policy, onEvent = () => {} }) {
  if (signal?.aborted) throw signal.reason;
  const executable = await nativeExecutable();
  const password = randomBytes(24).toString('base64url');
  const credentials = Buffer.from(`bench:${password}`).toString('base64');
  const secrets = [key, password, credentials].filter(Boolean);
  const scrub = (value) => redacted(value, secrets);
  const env = await environment(stateDir, workspace, config, key, password, policy);
  const removeKey = () => key ? unlink(join(stateDir, 'provider-key')).catch(() => {}) : undefined;
  try {
    const { stdout } = await exec(executable, ['--version'], { cwd: workspace, env, timeout: 10000, windowsHide: true });
    if (stdout.trim() !== pinnedVersion) throw new Error(`原生评测要求 OpenCode ${pinnedVersion}。`);
  } catch (error) {
    await removeKey();
    throw new Error(scrub(error.message));
  }
  const child = spawn(executable, ['serve', '--hostname', '127.0.0.1', '--port', '0'], {
    cwd: workspace, env, detached: !windows, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const controller = new AbortController();
  const lifetime = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const toolStates = new Map();
  let closed = false;
  let eventStream;

  async function close() {
    if (closed) return;
    closed = true;
    controller.abort();
    try {
      if (child.pid && child.exitCode === null && child.signalCode === null) await terminateProcessTree(child);
      await eventStream?.catch(() => {});
    } finally {
      await removeKey();
    }
  }

  try {
    const origin = await waitForAddress(child, boundedSignal(lifetime, 25000), scrub);
    child.on('error', () => {});
    function call(path, { body, method = body === undefined ? 'GET' : 'POST', timeout = 20000, event = false,
      requestSignal = lifetime } = {}) {
      return fetch(origin + path, {
        method,
        headers: {
          Authorization: `Basic ${credentials}`,
          'x-opencode-directory': encodeURIComponent(workspace),
          ...(body !== undefined && { 'Content-Type': 'application/json' }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        redirect: 'error',
        signal: event ? lifetime : boundedSignal(requestSignal, timeout),
      });
    }
    async function json(path, options) {
      const response = await call(path, options);
      if (!response.ok) {
        const detail = scrub((await response.text()).slice(0, 900));
        throw new Error(`OpenCode 返回 HTTP ${response.status}。 ${detail}`);
      }
      const body = await response.text();
      return body ? JSON.parse(body) : null;
    }
    const health = await json('/global/health');
    if (health?.healthy !== true) throw new Error('OpenCode 服务健康检查失败。');
    const session = await json('/session', { body: { title: 'TestTarget 原生评测' }, timeout: 90000 });
    const id = session.id;
    if (typeof id !== 'string' || !/^ses_[\w-]+$/u.test(id)) throw new Error('OpenCode 未返回有效会话 ID。');
    let turnRunning = false;
    let lastUserId;
    let sessionError;

    const emit = (fields) => onEvent(scrub({ phase: 'agent', ...fields }));
    const stream = await call('/event', { event: true });
    if (!stream.ok || !stream.body) throw new Error('无法订阅 OpenCode 原生事件。');
    eventStream = (async () => {
      const lines = createInterface({ input: Readable.fromWeb(stream.body), crlfDelay: Infinity });
      for await (const line of lines) {
        if (!line.startsWith('data:')) continue;
        let event;
        try { event = JSON.parse(line.slice(5)); } catch { continue; }
        const { type, properties: data } = event;
        const part = data?.part;
        if (type === 'session.error' && data?.sessionID === id) {
          sessionError = data.error;
        } else if (type === 'message.part.updated' && part?.type === 'tool') {
          const status = part.state?.status;
          if (toolStates.get(part.id) === status || status === 'pending') continue;
          toolStates.set(part.id, status);
          const name = part.state?.input?.name;
          await emit({
            kind: 'tool', status: status === 'completed' ? 'completed' : status === 'error' ? 'error' : 'running',
            summary: `OpenCode ${status === 'completed' ? '完成' : status === 'error' ? '工具异常' : '调用'} ${part.tool}${typeof name === 'string' ? ` · ${name}` : ''}`,
            detail: { sessionId: part.sessionID, tool: part.tool, callId: part.callID,
              ...(part.state?.metadata?.sessionId && { childSessionId: part.state.metadata.sessionId }) },
          });
        } else if (type === 'permission.asked' || type === 'question.asked') {
          const permission = type === 'permission.asked';
          await emit({ kind: 'step', status: 'blocked',
            summary: permission ? '工具权限请求等待处理。' : 'Agent 发出了澄清问题。',
            detail: { sessionId: data?.sessionID, requestId: data?.id,
              ...(permission ? { permission: data?.permission } : { questions: data?.questions }) } });
          if (typeof data?.id === 'string') {
            // Scripted cases supply continuation explicitly. An unexpected interactive pause is recorded.
            const route = permission ? `/permission/${encodeURIComponent(data.id)}/reply` : `/question/${encodeURIComponent(data.id)}/reject`;
            const rejected = await json(route, { method: 'POST', timeout: 3000,
              ...(permission && { body: { reply: 'reject' } }) }).then(() => true, () => false);
            await emit({ kind: 'step', status: rejected ? 'completed' : 'error',
              summary: permission ? (rejected ? '评测脚本已拒绝工具权限请求。' : '拒绝工具权限请求失败。')
                : (rejected ? '评测脚本已关闭非预期的澄清问题。' : '关闭澄清问题失败。'),
              detail: { sessionId: data.sessionID, requestId: data.id } });
          }
        }
      }
    })();
    void eventStream.catch(() => {});
    await emit({ kind: 'step', status: 'completed', summary: '已启动 OpenCode 原生会话。', detail: { sessionId: id, version: pinnedVersion } });

    async function waitForTurn(requestSignal) {
      const options = { requestSignal };
      for (;;) {
        requestSignal.throwIfAborted();
        const statuses = await json('/session/status', options);
        if (!statuses[id] || statuses[id].type === 'idle') {
          const messages = await json(`/session/${id}/message`, options);
          const user = messages.findLast(({ info }) => info?.role === 'user');
          if (user && user.info.id !== lastUserId) {
            const answer = messages.findLast(({ info }) => info?.role === 'assistant' && info.parentID === user.info.id);
            if (answer && (answer.info.error || (answer.info.time?.completed
              && answer.info.finish && !['tool-calls', 'unknown'].includes(answer.info.finish)))) {
              lastUserId = user.info.id;
              return { messages, answer };
            }
          }
          if (sessionError) throw new Error(sessionError.data?.message ?? sessionError.name ?? 'OpenCode 会话异常。');
        }
        await delay(1500, undefined, { signal: requestSignal });
      }
    }

    async function captureInterruptedTurn() {
      const signal = AbortSignal.timeout(3000);
      const options = { requestSignal: signal };
      const [messages, sessions] = await Promise.all([
        json(`/session/${id}/message`, options).catch(() => null),
        json(`/session/${id}/children`, options).catch(() => []),
      ]);
      if (!messages?.length) return null;
      const children = await Promise.all((sessions ?? []).map(async (childSession) => ({
        session: childSession,
        messages: await json(`/session/${encodeURIComponent(childSession.id)}/message`, options).catch(() => []),
      })));
      return scrub({ messages, children });
    }

    return {
      id,
      async inventory() {
        return scrub(await json('/skill', { timeout: 90000 }));
      },
      async turn(prompt) {
        if (closed) throw new Error('OpenCode 会话已结束。');
        if (turnRunning) throw new Error('OpenCode 同一会话只能执行一轮输入。');
        turnRunning = true;
        sessionError = undefined;
        const turnDeadline = AbortSignal.timeout(turnTimeoutMs);
        const requestSignal = AbortSignal.any([lifetime, turnDeadline]);
        try {
          await json(`/session/${id}/prompt_async`, { body: {
            ...(!policy && { agent: 'build' }), model: { providerID: config.preset, modelID: config.model },
            ...(config.reasoningEffort && { variant: config.reasoningEffort }),
            parts: [{ type: 'text', text: prompt }],
          }, requestSignal });
          // Native turns may take longer than the underlying fetch headers deadline.
          const { messages, answer } = await waitForTurn(requestSignal);
          const sessions = await json(`/session/${id}/children`, { requestSignal });
          const children = await Promise.all(sessions.map(async (childSession) => ({
            session: childSession, messages: await json(`/session/${encodeURIComponent(childSession.id)}/message`, { requestSignal }),
          })));
          return scrub({ messages, children, answer });
        } catch (error) {
          await json(`/session/${id}/abort`, { method: 'POST', timeout: 3000 }).catch(() => {});
          const explanation = turnDeadline.aborted ? `单轮执行超过 ${turnTimeoutMs / 1000} 秒。` : scrub(error.message);
          const failure = new Error(`OpenCode 原生轮次未完成。 ${explanation}`);
          failure.partialTurn = await captureInterruptedTurn();
          throw failure;
        } finally {
          turnRunning = false;
        }
      },
      close,
    };
  } catch (error) {
    await close();
    throw new Error(scrub(error.message));
  }
}
