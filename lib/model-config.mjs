import { AsyncLocalStorage } from 'node:async_hooks';
import { readFile } from 'node:fs/promises';
import { projectApiKeyEnv, projectApiKeyFile } from './project-api-key.mjs';

const providers = {
  openai: { baseURL: 'https://api.openai.com/v1', model: 'gpt-6-luna', apiStyle: 'responses', reasoningEffort: 'medium' },
  deepseek: { baseURL: 'https://api.deepseek.com', model: 'deepseek-flash', apiStyle: 'chat-completions', reasoningEffort: null },
  compatible: { baseURL: '', model: '', apiStyle: 'chat-completions', reasoningEffort: null },
};
const efforts = new Set(['low', 'medium', 'high']);
const setting = (name) => process.env[name]?.trim() || '';
const runModel = new AsyncLocalStorage();

export function modelProfileDefaults(preset) {
  const { baseURL, model } = providers[preset];
  return { baseURL, model, allowNoApiKey: false };
}

function baseAddress(value) {
  if (typeof value !== 'string' || value.length > 2048 || !/^https?:\/\//iu.test(value.trim())
    || /[\s\\?#\x00-\x1f\x7f]/u.test(value.trim())) {
    throw new Error('请填写完整的 HTTP 或 HTTPS API 基础地址。');
  }
  let address;
  try {
    address = new URL(value.trim());
  } catch {
    throw new Error('请填写完整的 HTTP 或 HTTPS API 基础地址。');
  }
  if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password || address.search || address.hash) {
    throw new Error('API 基础地址仅使用 HTTP 或 HTTPS，账号和密钥应填写在各自的配置字段。');
  }
  if (/\/(?:chat\/completions|responses)\/*$/iu.test(address.pathname)) {
    throw new Error('请填写 API 基础地址，例如 http://model.intra:8000/v1。');
  }
  return address.href.replace(/\/+$/u, '');
}

export function normalizeModelConfig(preset, { baseURL: address, model: name, allowNoApiKey = false, reasoningEffort: effort } = {}) {
  const defaults = providers[preset];
  const baseURL = baseAddress(address);
  const model = typeof name === 'string' ? name.trim() : '';
  if (!model || model.length > 200 || /[\s{}\x00-\x1f\x7f]/u.test(model) || model === '__proto__') {
    throw new Error('请填写模型服务提供的模型 ID。');
  }
  const reasoningEffort = defaults.apiStyle === 'responses' ? effort || defaults.reasoningEffort : null;
  if (reasoningEffort && !efforts.has(reasoningEffort)) throw new Error('VIBE_BENCH_REASONING_EFFORT 可填 low、medium 或 high。');
  return {
    preset, baseURL, displayBaseURL: baseURL, model, apiStyle: defaults.apiStyle, reasoningEffort,
    allowNoApiKey: preset === 'compatible' && allowNoApiKey === true,
  };
}

export function getStartupModelConfig() {
  const preset = setting('VIBE_BENCH_PROVIDER').toLowerCase() || 'openai';
  if (!Object.hasOwn(providers, preset)) throw new Error('VIBE_BENCH_PROVIDER 可填 openai、deepseek 或 compatible。');
  return normalizeModelConfig(preset, {
    baseURL: setting('VIBE_BENCH_BASE_URL') || providers[preset].baseURL,
    model: setting('VIBE_BENCH_MODEL') || providers[preset].model,
    allowNoApiKey: /^(1|true)$/iu.test(setting('VIBE_BENCH_ALLOW_NO_API_KEY')),
    reasoningEffort: setting('VIBE_BENCH_REASONING_EFFORT'),
  });
}

export function withModelSnapshot(snapshot, callback) {
  return runModel.run(snapshot, callback);
}

export function getModelConfig() {
  const snapshot = runModel.getStore();
  if (snapshot?.error) throw snapshot.error;
  return snapshot?.config ?? getStartupModelConfig();
}

export async function getModelApiKey(config) {
  const snapshot = runModel.getStore();
  if (snapshot) return snapshot.config === config ? snapshot.key : null;
  return getStartupModelApiKey(config);
}

export async function getStartupModelApiKey(config) {
  const explicit = setting('VIBE_BENCH_API_KEY');
  if (explicit) return explicit;
  const origin = new URL(config.baseURL).origin;
  if (config.preset === 'deepseek' && origin === 'https://api.deepseek.com') return setting('DEEPSEEK_API_KEY') || null;
  if (config.preset !== 'openai' || origin !== 'https://api.openai.com') return null;
  const legacy = setting(projectApiKeyEnv);
  if (legacy) return legacy;
  const file = projectApiKeyFile();
  if (!file) return null;
  const contents = await readFile(file, 'utf8').catch((error) => {
    if (error.code !== 'ENOENT') throw new Error('无法读取本机 OpenAI 项目密钥文件。');
    return '';
  });
  return contents.trim() || null;
}
