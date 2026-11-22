import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { getStartupModelApiKey, getStartupModelConfig, modelProfileDefaults, normalizeModelConfig } from './model-config.mjs';

const editablePresets = ['deepseek', 'compatible'];
const startupPreset = 'startup';
const emptyState = { version: 0, active: startupPreset, profiles: {} };

function userConfigDirectory() {
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'VibeAgentBench');
  }
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'VibeAgentBench');
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'vibe-agent-bench');
}

export class ModelSettingsError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const userError = (message, status) => new ModelSettingsError(message, status);

function validKey(value) {
  return typeof value === 'string' && /^[\x21-\x7e]{1,4096}$/u.test(value);
}

function normalizedProfile(preset, values) {
  if (!editablePresets.includes(preset)) throw userError('请选择 DeepSeek 或内网兼容服务。');
  if (Object.hasOwn(values, 'allowNoApiKey') && typeof values.allowNoApiKey !== 'boolean') {
    throw userError('免密选项需要布尔值。');
  }
  try {
    return normalizeModelConfig(preset, values);
  } catch (error) {
    throw userError(error.message);
  }
}

function readState(raw) {
  const { version, active, profiles } = JSON.parse(raw);
  if (!Number.isSafeInteger(version) || version < 1 || !profiles || typeof profiles !== 'object' || Array.isArray(profiles)
    || (active !== startupPreset && !Object.hasOwn(profiles, active))) {
    throw new Error('Invalid model settings');
  }
  for (const [preset, profile] of Object.entries(profiles)) {
    normalizedProfile(preset, profile);
    if (Object.hasOwn(profile, 'key') && profile.key !== null && !validKey(profile.key)) {
      throw new Error('Invalid saved key');
    }
  }
  return { version, active, profiles };
}

function startupSettings() {
  try {
    return { config: getStartupModelConfig() };
  } catch (error) {
    return { error };
  }
}

function sameOrigin(first, second) {
  return new URL(first.baseURL).origin === new URL(second.baseURL).origin;
}

async function inheritedKey(config, startup) {
  if (startup.config?.preset === config.preset && sameOrigin(startup.config, config)) {
    return getStartupModelApiKey(startup.config);
  }
  if (config.preset === 'deepseek' && new URL(config.baseURL).origin === 'https://api.deepseek.com') {
    return process.env.DEEPSEEK_API_KEY?.trim() || null;
  }
  return null;
}

function publicModel(config, key, saved = false) {
  return {
    ...config,
    saved,
    keyConfigured: Boolean(key),
    ready: Boolean(config.baseURL && config.model && (key || config.allowNoApiKey)),
  };
}

export async function openModelSettings(directory = userConfigDirectory()) {
  const folder = resolve(directory);
  const file = join(folder, 'credentials-vibe-bench-models.json');
  let state = emptyState;
  let settingsError = null;
  let writeQueue = Promise.resolve();

  try {
    state = readState(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') settingsError = '本机模型配置文件无法读取。可以在此重新保存配置。';
  }

  async function persist(next) {
    const temporary = join(folder, `credentials-vibe-bench-models-${randomUUID()}.tmp`);
    try {
      await mkdir(folder, { recursive: true, mode: 0o700 });
      await writeFile(temporary, JSON.stringify(next, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      await rename(temporary, file);
    } catch {
      await rm(temporary, { force: true }).catch(() => {});
      throw userError('无法保存本机模型配置，请检查用户配置目录的写入权限。', 500);
    }
    state = next;
    settingsError = null;
  }

  async function profileSnapshot(preset, entry, startup) {
    const config = normalizedProfile(preset, entry);
    const key = Object.hasOwn(entry, 'key') ? entry.key : await inheritedKey(config, startup);
    return { config, key };
  }

  async function startupSnapshot(startup) {
    if (startup.error) return startup;
    try {
      return { config: startup.config, key: await getStartupModelApiKey(startup.config) };
    } catch (error) {
      return { config: startup.config, error };
    }
  }

  async function view() {
    const current = state;
    const startup = startupSettings();
    const initial = await startupSnapshot(startup);
    const initialPublic = initial.config ? publicModel(initial.config, initial.key) : null;
    const entries = await Promise.all(editablePresets.map(async (preset) => {
      const saved = current.profiles[preset];
      if (!saved && initialPublic?.preset === preset) return [preset, initialPublic];
      const values = saved ?? modelProfileDefaults(preset);
      if (!values.baseURL) return [preset, publicModel({ preset, ...values }, null)];
      const { config, key } = await profileSnapshot(preset, values, startup);
      return [preset, publicModel(config, key, Boolean(saved))];
    }));
    const profiles = Object.fromEntries(entries);
    const activeSource = current.active === startupPreset ? startupPreset : 'saved';
    const active = activeSource === startupPreset ? initialPublic : profiles[current.active];

    return {
      ...active, activePreset: active?.preset ?? null, activeSource, version: current.version,
      profiles, startup: initialPublic, settingsError,
      activeError: activeSource === startupPreset ? initial.error?.message ?? null : null,
    };
  }

  async function candidate(body) {
    const { preset, apiKey, clearApiKey } = body;
    const config = normalizedProfile(preset, body);
    if (apiKey !== undefined && (typeof apiKey !== 'string' || (apiKey !== '' && !validKey(apiKey.trim())))) {
      throw userError('API 密钥格式无效。');
    }
    if (clearApiKey !== undefined && typeof clearApiKey !== 'boolean') throw userError('清除密钥选项需要布尔值。');
    const entered = apiKey?.trim();
    if (clearApiKey && entered) throw userError('清除密钥时请留空 API 密钥输入框。');

    const saved = state.profiles[preset];
    const startup = startupSettings();
    const original = saved ?? (startup.config?.preset === preset ? startup.config : modelProfileDefaults(preset));
    let key;
    if (clearApiKey) key = null;
    else if (entered) key = entered;
    else if (original.baseURL && sameOrigin(config, original) && saved && Object.hasOwn(saved, 'key')) key = saved.key;
    else if (original.baseURL && !sameOrigin(config, original)) key = null;

    const values = { baseURL: config.baseURL, model: config.model, allowNoApiKey: config.allowNoApiKey };
    if (key !== undefined) values.key = key;
    const effectiveKey = key === undefined ? await inheritedKey(config, startup) : key;
    if (effectiveKey?.length >= 8 && (config.baseURL.includes(effectiveKey) || config.model.includes(effectiveKey))) {
      throw userError('请将 API 密钥仅填入密钥字段。');
    }
    return { config, key: effectiveKey, values };
  }

  function update(version, change) {
    const operation = writeQueue.then(async () => {
      if (version !== state.version) throw userError('配置已被更新，请重新打开模型配置后再试。', 409);
      const next = await change();
      await persist({ ...next, version: state.version + 1 });
      return view();
    });
    writeQueue = operation.catch(() => {});
    return operation;
  }

  return {
    view,
    preview: candidate,
    async capture() {
      const current = state;
      const startup = startupSettings();
      if (current.active === startupPreset) return startupSnapshot(startup);
      return profileSnapshot(current.active, current.profiles[current.active], startup);
    },
    save(body) {
      return update(body.version, async () => {
        if (Object.hasOwn(body, 'activate') && typeof body.activate !== 'boolean') {
          throw userError('启用选项需要布尔值。');
        }
        const { config, key, values } = await candidate(body);
        const active = body.activate === false ? state.active : config.preset;
        if (active === config.preset && !key && !config.allowNoApiKey) {
          throw userError('启用该配置需要 API 密钥。内网服务允许免密时可勾选免密选项。');
        }
        return { active, profiles: { ...state.profiles, [config.preset]: values } };
      });
    },
    activate({ preset, version }) {
      return update(version, async () => {
        const startup = startupSettings();
        if (preset === startupPreset) {
          if (startup.error) throw userError(startup.error.message);
        } else {
          if (!editablePresets.includes(preset) || !state.profiles[preset]) throw userError('请先保存这套模型配置。');
          const { config, key } = await profileSnapshot(preset, state.profiles[preset], startup);
          if (!key && !config.allowNoApiKey) throw userError('启用该配置需要 API 密钥。');
        }
        return { ...state, active: preset };
      });
    },
  };
}
