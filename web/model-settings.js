const providers = {
  openai: { name: 'OpenAI' },
  deepseek: { name: 'DeepSeek', addressExample: 'https://api.deepseek.com', modelExample: 'deepseek-flash' },
  compatible: { name: '内网或兼容服务', addressExample: 'http://model.intra:8000/v1', modelExample: '服务提供的模型 ID' },
};

const dialog = document.createElement('dialog');
dialog.className = 'model-settings-dialog';
dialog.setAttribute('aria-labelledby', 'model-settings-title');
dialog.innerHTML = `
  <header class="model-settings-header">
    <h2 id="model-settings-title">模型配置</h2>
    <button type="button" class="model-settings-action" data-close autofocus>关闭</button>
  </header>
  <div class="model-settings-content">
    <div class="model-settings-load" data-load>
      <p role="status" data-load-status></p>
      <button type="button" class="model-settings-action" data-retry hidden>重试</button>
    </div>
    <form autocomplete="off" hidden>
      <section class="model-settings-current" aria-label="当前配置">
        <div><span>当前配置</span><strong data-active-model></strong></div>
        <span class="model-settings-protocol" data-active-protocol></span>
        <p class="model-settings-current-address" data-active-address hidden></p>
      </section>
      <p class="model-settings-feedback" data-state="error" data-config-error hidden></p>
      <div class="model-settings-startup" data-startup-row hidden>
        <span data-startup-model></span>
        <button type="button" class="model-settings-action" data-startup>恢复启动配置</button>
      </div>

      <fieldset class="model-settings-profiles" data-profiles>
        <legend>选择模型服务</legend>
        <div class="model-settings-options">
          <label class="model-settings-option">
            <input type="radio" name="preset" value="deepseek">
            <span><strong>DeepSeek</strong><small data-profile-status="deepseek"></small></span>
          </label>
          <label class="model-settings-option">
            <input type="radio" name="preset" value="compatible">
            <span><strong>内网或兼容服务</strong><small data-profile-status="compatible"></small></span>
          </label>
        </div>
      </fieldset>

      <fieldset class="model-settings-fields" data-fields>
        <div class="model-settings-field">
          <label for="model-settings-address">API 基础地址</label>
          <input id="model-settings-address" type="url" name="baseURL" required maxlength="2048" spellcheck="false" aria-describedby="model-settings-address-help">
          <small id="model-settings-address-help">填写接口根地址，无需附加 /chat/completions。</small>
        </div>
        <div class="model-settings-field">
          <label for="model-settings-model">模型 ID</label>
          <input id="model-settings-model" type="text" name="model" required maxlength="200" spellcheck="false">
        </div>
        <div class="model-settings-field">
          <label for="model-settings-key">API 密钥</label>
          <input id="model-settings-key" type="password" name="apiKey" autocomplete="new-password" maxlength="4096" spellcheck="false" aria-describedby="model-settings-key-help">
          <small id="model-settings-key-help"></small>
        </div>
        <label class="model-settings-checkbox" data-allow-row hidden>
          <input type="checkbox" name="allowNoApiKey">允许无密钥连接
        </label>
        <label class="model-settings-checkbox" data-clear-row hidden>
          <input type="checkbox" name="clearApiKey">清除已配置的密钥
        </label>
      </fieldset>

      <p class="model-settings-feedback" role="status" data-feedback hidden></p>
      <div class="model-settings-actions">
        <div>
          <button class="model-settings-action" type="button" data-test aria-describedby="model-settings-test-help">测试连接</button>
          <button class="model-settings-action" type="button" data-switch hidden>启用已保存配置</button>
        </div>
        <div>
          <button class="model-settings-action" type="button" data-save-only>仅保存</button>
          <button class="model-settings-action model-settings-primary" type="submit" data-activate>保存并启用</button>
        </div>
        <p id="model-settings-test-help">发送一条简短请求来验证地址、密钥和模型。</p>
      </div>
    </form>
  </div>`;
document.body.append(dialog);

const find = (selector) => dialog.querySelector(selector);
const form = find('form');
const { preset, baseURL, model, apiKey, allowNoApiKey, clearApiKey } = form.elements;
const close = find('[data-close]');
const retry = find('[data-retry]');
const test = find('[data-test]');
const switchSaved = find('[data-switch]');
const restoreStartup = find('[data-startup]');
const saveOnly = find('[data-save-only]');
const activate = find('[data-activate]');
const drafts = new Map();
let session;
let opener;
let config;
let selected = 'deepseek';
let operation = '';

function activePreset() {
  return config?.activePreset ?? config?.preset;
}

function savedProfile(id) {
  return config?.profiles?.[id] ?? (activePreset() === id ? config : {});
}

function isActiveProfile(id) {
  return id === activePreset() && config.activeSource === 'saved';
}

function modelLabel(id, modelId) {
  return [providers[id]?.name ?? id, modelId].filter(Boolean).join(' · ');
}

function draftFor(id) {
  if (!drafts.has(id)) {
    const saved = savedProfile(id);
    drafts.set(id, {
      baseURL: saved.baseURL ?? (id === 'deepseek' ? providers.deepseek.addressExample : ''),
      model: saved.model ?? (id === 'deepseek' ? providers.deepseek.modelExample : ''),
      apiKey: '',
      allowNoApiKey: Boolean(saved.allowNoApiKey),
      clearApiKey: false,
    });
  }
  return drafts.get(id);
}

function showFeedback(text, state = '') {
  const feedback = find('[data-feedback]');
  feedback.dataset.state = state;
  feedback.hidden = !text;
  feedback.textContent = text;
}

function originOf(address) {
  return URL.canParse(address) ? new URL(address).origin : null;
}

function renderKey() {
  const draft = draftFor(selected);
  const saved = savedProfile(selected);
  const origin = originOf(draft.baseURL.trim());
  const reusable = saved.keyConfigured && origin && origin === originOf(saved.baseURL);
  const help = find('#model-settings-key-help');
  apiKey.disabled = draft.clearApiKey;
  if (draft.clearApiKey) help.textContent = '测试时不使用已配置的密钥。保存后清除。';
  else if (reusable) help.textContent = '已配置密钥，留空可继续使用。';
  else if (saved.keyConfigured) help.textContent = '已配置的密钥仅用于原站点。换站点时请填写对应密钥。';
  else if (selected === 'compatible' && draft.allowNoApiKey) help.textContent = '该档案允许无密钥连接。';
  else help.textContent = '填写该服务的 API 密钥。';
  find('[data-clear-row]').hidden = !saved.keyConfigured;
}

function renderForm() {
  const active = activePreset();
  const activeModel = config.model ?? savedProfile(active).model;
  find('[data-active-model]').textContent = modelLabel(active, activeModel) || '待配置';
  const protocol = find('[data-active-protocol]');
  protocol.textContent = config.apiStyle === 'responses' ? 'Responses' : config.apiStyle === 'chat-completions' ? 'Chat Completions' : '';
  protocol.hidden = !protocol.textContent;
  const address = find('[data-active-address]');
  const keyStatus = config.keyConfigured ? '密钥已配置' : config.allowNoApiKey ? '允许免密' : '未配置密钥';
  address.textContent = config.baseURL ? `${config.baseURL} · ${keyStatus}` : '';
  address.hidden = !address.textContent;
  const warning = find('[data-config-error]');
  warning.textContent = [config.activeError, config.settingsError].filter(Boolean).join(' ');
  warning.hidden = !warning.textContent;
  const startup = config.startup;
  const restoreAvailable = Boolean(startup?.baseURL && startup?.model && config.activeSource !== 'startup');
  find('[data-startup-row]').hidden = !restoreAvailable;
  find('[data-startup-model]').textContent = restoreAvailable ? modelLabel(startup.preset, startup.model) : '';
  for (const input of preset) {
    const id = input.value;
    const saved = savedProfile(id);
    const status = find(`[data-profile-status="${id}"]`);
    const inUse = isActiveProfile(id);
    status.textContent = inUse ? '正在使用' : saved.ready ? '可启用' : saved.saved ? '已保存，待补全' : '待配置';
    status.dataset.active = inUse;
    input.checked = id === selected;
  }

  const draft = draftFor(selected);
  baseURL.placeholder = providers[selected].addressExample;
  model.placeholder = providers[selected].modelExample;
  baseURL.value = draft.baseURL;
  model.value = draft.model;
  apiKey.value = draft.apiKey;
  allowNoApiKey.checked = draft.allowNoApiKey;
  clearApiKey.checked = draft.clearApiKey;
  find('[data-allow-row]').hidden = selected !== 'compatible';
  const inUse = isActiveProfile(selected);
  const saved = savedProfile(selected);
  saveOnly.hidden = inUse;
  switchSaved.hidden = inUse || !saved.saved || !saved.ready;
  activate.textContent = inUse ? '保存配置' : '保存并启用';
  renderKey();
}

function setOperation(value) {
  operation = value;
  const busy = Boolean(value);
  find('[data-profiles]').disabled = busy;
  find('[data-fields]').disabled = busy;
  test.disabled = saveOnly.disabled = activate.disabled = switchSaved.disabled = restoreStartup.disabled = busy;
  close.disabled = value === 'save' || value === 'activate';
}

async function request(path, signal, method = 'GET', body) {
  const response = await fetch(path, {
    method, cache: 'no-store', signal,
    ...(body && { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  }).catch(() => { throw new Error('无法连接评测台，请稍后重试。'); });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result) throw new Error(result?.error ?? `请求失败（HTTP ${response.status}）。`);
  return result;
}

async function loadConfig() {
  const { signal } = session;
  const load = find('[data-load]');
  const status = find('[data-load-status]');
  form.hidden = true;
  load.hidden = false;
  retry.hidden = true;
  retry.disabled = true;
  load.dataset.state = '';
  status.textContent = '正在读取模型配置…';
  try {
    const next = await request('/api/model-config', signal);
    if (signal.aborted) return;
    config = next;
    selected = ['deepseek', 'compatible'].includes(activePreset()) ? activePreset() : 'deepseek';
    renderForm();
    load.hidden = true;
    form.hidden = false;
  } catch (error) {
    if (signal.aborted) return;
    load.dataset.state = 'error';
    status.textContent = error.message;
    retry.hidden = false;
    retry.disabled = false;
  }
}

async function applyDraft(action, shouldActivate = false) {
  if (operation || !form.reportValidity()) return;
  const { signal } = session;
  const draft = draftFor(selected);
  const key = draft.apiKey.trim();
  const body = {
    preset: selected,
    baseURL: draft.baseURL.trim(),
    model: draft.model.trim(),
    allowNoApiKey: selected === 'compatible' && draft.allowNoApiKey,
    ...(draft.clearApiKey ? { clearApiKey: true } : key ? { apiKey: key } : {}),
  };
  const saving = action === 'save';
  setOperation(action);
  showFeedback(saving ? '正在保存配置…' : '正在连接模型服务…');
  try {
    if (saving) {
      config = await request('/api/model-config', signal, 'PUT', { ...body, activate: shouldActivate, version: config.version });
      drafts.delete(selected);
      renderForm();
      showFeedback(isActiveProfile(selected) ? '配置已保存。新运行将使用此配置。' : '档案已保存。', 'success');
    } else {
      const result = await request('/api/model-config/test', signal, 'POST', body);
      if (!result.ok) throw new Error(result.error ?? '模型服务连接失败。');
      const latency = Number.isFinite(result.latencyMs) ? `耗时 ${Math.round(result.latencyMs)} 毫秒。` : '';
      showFeedback(`连接成功。${latency}`, 'success');
    }
  } catch (error) {
    if (!signal.aborted) showFeedback(key ? error.message.replaceAll(key, '[已隐藏]') : error.message, 'error');
  } finally {
    if (!signal.aborted) setOperation('');
  }
}

async function applyActiveProfile(id) {
  if (operation) return;
  const { signal } = session;
  setOperation('activate');
  showFeedback('正在切换模型配置…');
  try {
    config = await request('/api/model-config/activate', signal, 'POST', { preset: id, version: config.version });
    renderForm();
    showFeedback('已切换配置。新运行将使用此配置。', 'success');
  } catch (error) {
    if (!signal.aborted) showFeedback(error.message, 'error');
  } finally {
    if (!signal.aborted) setOperation('');
  }
}

form.addEventListener('input', ({ target }) => {
  if (target.name === 'preset') {
    selected = target.value;
    renderForm();
  } else {
    const draft = draftFor(selected);
    draft[target.name] = target.type === 'checkbox' ? target.checked : target.value;
    renderKey();
  }
  showFeedback('');
});
form.addEventListener('submit', (event) => {
  event.preventDefault();
  void applyDraft('save', true);
});
test.addEventListener('click', () => void applyDraft('test'));
saveOnly.addEventListener('click', () => void applyDraft('save'));
switchSaved.addEventListener('click', () => void applyActiveProfile(selected));
restoreStartup.addEventListener('click', () => void applyActiveProfile('startup'));
retry.addEventListener('click', () => void loadConfig());
close.addEventListener('click', () => dialog.close());
dialog.addEventListener('cancel', (event) => {
  if (close.disabled) event.preventDefault();
});
dialog.addEventListener('close', () => {
  session?.abort();
  config = undefined;
  drafts.clear();
  apiKey.value = '';
  setOperation('');
  showFeedback('');
  opener?.focus();
});

for (const button of document.querySelectorAll('[data-model-settings]')) {
  button.setAttribute('aria-haspopup', 'dialog');
  button.addEventListener('click', () => {
    if (dialog.open) return;
    opener = button;
    session = new AbortController();
    dialog.showModal();
    void loadConfig();
  });
}
