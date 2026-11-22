import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const maxLiveOutput = 500;

export function redactLog(value) {
  return String(value ?? '')
    .replace(/\x1b\[[\d;?]*[A-Za-z]/gu, '')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}/gu, '[REDACTED]')
    .replace(/(\bBearer\s+)[A-Za-z0-9_.-]{12,}/giu, '$1[REDACTED]');
}

export async function readRunEvents(directory, after = 0) {
  let data;
  try {
    data = await readFile(join(directory, 'events.jsonl'), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const events = [];
  for (const line of data.split('\n')) {
    if (!line) continue;
    try {
      const event = JSON.parse(line);
      if (event.seq > after) events.push(event);
    } catch {
      // A concurrent reader can see the trailing line before it is complete.
    }
  }
  return events;
}

export function eventJournal(directory, initialSequence = 0) {
  let sequence = initialSequence;
  let output = 0;
  let writes = Promise.resolve();
  return function emit(event) {
    if (event.kind === 'command-output') {
      output++;
      if (output > maxLiveOutput + 1) return writes;
      if (output === maxLiveOutput + 1) {
        event = { kind: 'notice', phase: event.phase, summary: '后续连续输出请查看对应步骤的完整证据。' };
      }
    }
    const entry = {
      ...event,
      summary: redactLog(event.summary).slice(0, 450),
      seq: ++sequence,
      at: new Date().toISOString(),
    };
    if (event.detail !== undefined) {
      const detail = typeof event.detail === 'string' ? event.detail : JSON.stringify(event.detail, null, 2);
      entry.detail = redactLog(detail).slice(0, 6_000);
    }
    const line = JSON.stringify(entry) + '\n';
    writes = writes.catch(() => {}).then(() => appendFile(join(directory, 'events.jsonl'), line, 'utf8'));
    return writes;
  };
}
