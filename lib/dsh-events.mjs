import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { redactOutput } from './project-run.mjs';

function redactValue(value, secret) {
  if (typeof value === 'string') return redactOutput(value, secret);
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, secret));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    redactOutput(key, secret),
    /(?:api.?key|secret|password|authorization|credential|private.?key|access.?token|refresh.?token)$/iu.test(key)
      ? '[REDACTED]' : redactValue(entry, secret),
  ]));
}

export function redactDshEvent(line, secret) {
  try {
    return redactValue(JSON.parse(line), secret);
  } catch {
    return { type: 'diagnostic', text: redactOutput(line, secret) };
  }
}

export async function readDshCatalog(directory, sessionId) {
  if (!/^session-[a-f0-9-]{36}$/iu.test(sessionId ?? '')) return null;
  const projects = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const project of projects.filter((entry) => entry.isDirectory())) {
    const session = join(directory, project.name, sessionId);
    const files = await readdir(session, { withFileTypes: true }).catch(() => []);
    const journal = files.find((file) => file.isFile() && /^session(?:\.v[1-9]\d*)?\.jsonl$/u.test(file.name));
    if (!journal) continue;
    const input = createReadStream(join(session, journal.name));
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.includes('skill-catalog')) continue;
        const event = JSON.parse(line);
        const source = event.data?.source;
        if (event.type === 'user/message' && source?.kind === 'skill-catalog' && Array.isArray(source.entries)) {
          return new Set(source.entries.map(({ name }) => name));
        }
      }
    } finally {
      lines.close();
      input.destroy();
    }
  }
  return null;
}

function samePath(workspace, input, expected) {
  return typeof input === 'string' && input.length > 0 && relative(expected, resolve(workspace, input)) === '';
}

function skillResult(event, call, entries, workspace) {
  if (event.status !== 'completed' || typeof event.result !== 'string') return null;
  const { tool, input } = call;
  const entry = tool === 'skill' ? entries.get(input?.name)
    : tool === 'read' ? [...entries.values()].find(({ file }) => samePath(workspace, input?.file_path, file)) : null;
  if (!entry) return null;
  const { name, file, path, packId, token } = entry;
  let body;
  if (tool === 'skill') {
    if (!event.result.startsWith(`<skill_content name="${name}">\n`)) return null;
    body = /<skill_instructions>\r?\n([\s\S]*)/u.exec(event.result)?.[1];
  } else {
    const read = /^<path>([^\r\n]+)<\/path>\r?\n<type>file<\/type>\r?\n<content>\r?\n([\s\S]*)/u.exec(event.result);
    if (!read || !samePath(workspace, read[1], file)) return null;
    body = read[2];
  }
  return {
    name, path, packId, method: tool === 'skill' ? 'skill-tool' : 'file-read',
    bodyVerified: Boolean(token && body?.split(/<\/(?:skill_instructions|content)>/u, 1)[0].includes(token)),
    evidence: event.callId,
  };
}

export function trackDshRun(workspace, entries) {
  const state = { sessionId: null, finish: null, error: false, skillCalls: [] };
  const pending = new Map();
  const observe = (event) => {
    const phase = 'agent';
    if (event?.type === 'session' && !state.sessionId && typeof event.sessionId === 'string') {
      state.sessionId = event.sessionId;
      return { kind: 'step', phase, status: 'running', summary: 'DSH 已启动独立会话。' };
    }
    if (event?.type === 'error') {
      state.error = true;
      return { kind: 'notice', phase, status: 'error', summary: 'DSH 报告执行错误。', detail: event.message };
    }
    if (!state.sessionId || state.finish) return null;
    if (event.type === 'final' && event.sessionId === state.sessionId) {
      state.finish = event.reason?.kind ?? 'unknown';
      return { kind: 'step', phase, status: state.finish === 'completed' ? 'completed' : 'error',
        summary: 'DSH 会话已结束。', detail: event.text };
    }
    if (event.type === 'tool_call' && typeof event.callId === 'string') {
      pending.set(event.callId, event);
      return { kind: 'tool', phase, tool: event.tool, status: 'running', summary: `DSH 调用工具 ${event.tool}。`, detail: event.input };
    }
    if (event.type === 'tool_result' && pending.has(event.callId)) {
      const call = pending.get(event.callId);
      pending.delete(event.callId);
      const proof = skillResult(event, call, entries, workspace);
      if (proof) {
        state.skillCalls.push(proof);
        return { kind: 'tool', phase, tool: call.tool, checkId: 'skill', status: 'completed',
          summary: proof.bodyVerified ? `DSH 已验证读取 ${proof.name}。` : `DSH 返回 ${proof.name} 的工具结果。`, detail: proof.path };
      }
      return { kind: 'tool', phase, tool: call.tool, status: event.status === 'completed' ? 'completed' : 'error',
        summary: `DSH 工具 ${call.tool} 已返回。`, detail: event.result };
    }
    if (event.type === 'text') return { kind: 'message', phase, status: 'running', summary: 'DSH 输出', detail: event.text };
    return null;
  };
  return { state, observe };
}
