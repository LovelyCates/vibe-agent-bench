const probePrompt = 'Reply with OK.';
const defaultTimeoutMs = 12_000;
const incompleteChat = new Set(['length', 'content_filter', 'safety', 'tool_calls', 'function_call', 'insufficient_system_resource']);

function failed(error, status = null) {
  return { ok: false, status, error };
}

function probeURL(baseURL, apiStyle) {
  const url = new URL(baseURL);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Invalid API address');
  }
  const route = apiStyle === 'responses' ? 'responses' : 'chat/completions';
  return `${url.href.replace(/\/+$/u, '')}/${route}`;
}

function httpError(status) {
  const messages = {
    400: '模型服务拒绝请求，请检查模型 ID 和接口类型。',
    401: '模型服务认证失败，请检查 API 密钥。',
    402: '模型服务的余额或计费配置不可用。',
    403: '模型服务拒绝访问，请检查 API 密钥和模型权限。',
    404: '模型服务找不到接口或模型，请检查 API 基础地址和模型 ID。',
    405: '当前地址不支持此接口，请检查 API 基础地址和接口类型。',
    422: '模型服务无法处理请求，请检查模型 ID 和接口类型。',
    429: '模型服务的调用频率或额度已达上限，请稍后再试。',
  };
  if (status >= 300 && status < 400) return '模型服务要求跳转，请填写最终 API 基础地址。';
  if (status >= 500) return `模型服务暂时不可用（HTTP ${status}），请稍后再试。`;
  return messages[status] ?? `模型服务返回 HTTP ${status}。`;
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasAnswer(body, apiStyle) {
  if (body?.error) return false;
  if (apiStyle === 'responses') {
    if (body?.status !== 'completed' || !Array.isArray(body.output)) return false;
    return body.output.some((item) => item?.type === 'message' && item.role === 'assistant'
      && Array.isArray(item.content) && item.content.some((part) => part?.type === 'output_text' && hasText(part.text)));
  }

  const choice = Array.isArray(body?.choices) ? body.choices[0] : null;
  if (!choice?.message || incompleteChat.has(choice.finish_reason) || hasText(choice.message.refusal)) return false;
  const content = choice.message.content;
  return hasText(content) || (Array.isArray(content)
    && content.some((part) => part?.type === 'text' && hasText(part.text)));
}

export async function testModelConnection(config, apiKey, { timeoutMs = defaultTimeoutMs } = {}) {
  const { apiStyle, allowNoApiKey, baseURL, model, preset } = config ?? {};
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!['responses', 'chat-completions'].includes(apiStyle) || !hasText(model) || (key && model.includes(key))) {
    return failed('请检查模型 ID 和接口类型。');
  }
  if (!key && !allowNoApiKey) return failed('连接测试需要 API 密钥。');

  let url;
  try {
    url = probeURL(baseURL, apiStyle);
  } catch {
    return failed('请填写完整的 HTTP 或 HTTPS API 基础地址。');
  }

  const request = apiStyle === 'responses'
    ? { model, input: probePrompt, max_output_tokens: 128, store: false }
    : {
      model,
      messages: [{ role: 'user', content: probePrompt }],
      ...(preset === 'deepseek' ? { max_tokens: 256 } : {}),
    };
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = `Bearer ${key}`;
  const timeout = Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30_000 ? timeoutMs : defaultTimeoutMs;
  const signal = AbortSignal.timeout(timeout);
  const start = performance.now();
  let response;
  let body;
  try {
    response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(request), redirect: 'manual', signal });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return failed(httpError(response.status), response.status);
    }
    body = await response.json();
  } catch (error) {
    const status = response?.status ?? null;
    if (signal.aborted) return failed('模型连接测试超时，请检查网络或稍后再试。', status);
    if (error instanceof SyntaxError) return failed('模型服务返回了无法解析的 JSON，请检查 API 基础地址。', status);
    return failed('无法连接模型服务，请检查 API 基础地址和网络。', status);
  }

  if (!hasAnswer(body, apiStyle)) return failed('模型服务没有返回有效回答，请检查模型 ID 和接口类型。', response.status);
  const returnedModel = typeof body.model === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9./_:@-]{0,199}$/u.test(body.model)
    && (!key || !body.model.includes(key)) ? body.model : model;
  return { ok: true, status: response.status, latencyMs: Math.round(performance.now() - start), model: returnedModel };
}
