const tokens = /(?<comment>\/\/.*|\/\*.*?(?:\*\/|$)|(?:^|(?<=\s))#.*)|(?<string>"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(?<number>\b(?:0[xX][\da-fA-F]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)\b)|(?<literal>\b(?:true|false|null|undefined|NaN|None|True|False)\b)|(?<keyword>\b(?:async|await|as|break|case|catch|class|const|continue|def|delete|else|enum|except|export|extends|finally|for|from|function|if|import|in|interface|let|new|of|package|pass|private|public|raise|return|static|super|switch|this|throw|try|type|var|void|while|with|yield)\b)|(?<function>\b[$A-Za-z_][\w$]*(?=\s*\())|(?<punctuation>[{}\[\]():;,=<>])/g;
const ansi = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b\[[0-?]*[ -/]*[@-~]/g;

function lineKind(line, mode) {
  if (mode === 'diff') {
    if (/^@@/.test(line)) return 'hunk';
    if (/^(?:diff --git |index |--- |\+\+\+ |new file mode |deleted file mode |\\ No newline)/.test(line)) return 'meta';
    if (line.startsWith('+')) return 'added';
    if (line.startsWith('-')) return 'removed';
  }
  if (mode !== 'terminal') return '';
  if (/(?:^|\W)(?:fatal|error|failed?|not ok|exception)(?:\W|$)|[✗✖×]|失败|错误/i.test(line)) return 'error';
  if (/(?:^|\W)warn(?:ing)?(?:\W|$)|警告/i.test(line)) return 'warning';
  if (/(?:^|\W)(?:success|passed?|ok)(?:\W|$)|[✓✔]|通过|成功/i.test(line)) return 'success';
  return '';
}

function modeOf(file, source) {
  if (/\.(?:diff|patch)$/i.test(file) || /^diff --git /m.test(source)) return 'diff';
  if (/\.(?:json|jsonl|ndjson)$/i.test(file)) return 'code';
  if (/\.(?:log|out|stderr|stdout)$/i.test(file) || file === 'terminal') return 'terminal';
  if (/\.(?:[cm]?js|[cm]?ts|[jt]sx|py|rb|go|rs|java|kt|cs|c|h|cc|cpp|sh|bash|zsh|ps1|yml|yaml|toml|html?|css|scss|sql|xml|vue|svelte)$/i.test(file)) return 'code';
  return 'plain';
}

function paintLine(target, line) {
  let position = 0;
  for (const part of line.matchAll(tokens)) {
    const [fragment] = part;
    if (part.index > position) target.append(line.slice(position, part.index));
    let kind = Object.keys(part.groups).find((name) => part.groups[name] !== undefined);
    if (kind === 'string' && /^\s*:/.test(line.slice(part.index + fragment.length))) kind = 'key';
    const token = document.createElement('span');
    token.className = `token ${kind}`;
    token.textContent = fragment;
    target.append(token);
    position = part.index + fragment.length;
  }
  if (position < line.length) target.append(line.slice(position));
}

export function highlightedPreview(text, file = '', { maxLines = 1800, maxChars = 160_000 } = {}) {
  const source = String(text ?? '');
  const clipped = source.slice(0, maxChars).replace(ansi, '');
  const mode = modeOf(file, clipped);
  const lines = clipped.split(/\r\n|\n|\r/u);
  const pre = document.createElement('pre');
  pre.className = 'code-view';
  pre.tabIndex = 0;
  pre.setAttribute('aria-label', '文本预览');
  const code = document.createElement('code');
  const result = document.createDocumentFragment();
  result.append(pre);
  pre.append(code);
  for (const [index, line] of lines.slice(0, maxLines).entries()) {
    const row = document.createElement('span');
    const lineNumber = document.createElement('span');
    const value = document.createElement('span');
    row.className = 'code-line';
    const kind = lineKind(line, mode);
    if (kind) row.dataset.line = kind;
    lineNumber.className = 'line-no';
    lineNumber.setAttribute('aria-hidden', 'true');
    lineNumber.textContent = String(index + 1);
    if (mode === 'code' || (mode === 'diff' && !['hunk', 'meta'].includes(kind))) paintLine(value, line);
    else value.textContent = line;
    row.append(lineNumber, value);
    code.append(row);
  }
  if (source.length > maxChars || lines.length > maxLines) {
    const notice = document.createElement('p');
    notice.className = 'code-notice';
    notice.textContent = '文件较长，预览仅显示开头部分。';
    result.append(notice);
  }
  return result;
}
