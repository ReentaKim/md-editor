// MD Editor — renderer 진입점
import { createEditor, setDocument, replaceDoc, applyFormat, editorCommands, toggleTaskAtLine } from './editor.js';
import { renderMarkdown, renderMermaid, slugify } from './markdown.js';
import previewCss from './preview.css';

const api = window.api;
const $ = (sel) => document.querySelector(sel);

// preview.css는 문자열로 번들되어 있으므로(HTML 내보내기에도 재사용) 여기서 주입한다.
const styleEl = document.createElement('style');
styleEl.textContent = previewCss;
document.head.prepend(styleEl);
if (api.platform !== 'darwin') document.body.classList.add('not-mac');

const el = {
  editorPane: $('#editor-pane'),
  previewPane: $('#preview-pane'),
  preview: $('#preview'),
  toc: $('#toc'),
  recentList: $('#recent-list'),
  title: $('#title-text'),
  stPath: $('#st-path'),
  stSave: $('#st-save'),
  stCursor: $('#st-cursor'),
  stCount: $('#st-count'),
  stRead: $('#st-read'),
  divider: $('#divider'),
  workspace: $('#workspace'),
};

const doc = {
  filePath: null,
  name: '제목 없음',
  dirUrl: null,
  savedContent: '',
  dirty: false,
};
const prefs = { viewMode: 'split', sidebar: true, syncScroll: true, autosave: false };
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

// ───────────────────────── 편집기 ─────────────────────────
let renderTimer = null;
let autosaveTimer = null;
const view = createEditor(el.editorPane, {
  onChange: () => {
    clearTimeout(renderTimer);
    const size = view.state.doc.length;
    renderTimer = setTimeout(onDocChanged, size > 200_000 ? 400 : size > 30_000 ? 180 : 60);
  },
  onScroll: () => syncFromEditor(),
  onCursor: (state) => {
    const pos = state.selection.main.head;
    const line = state.doc.lineAt(pos);
    el.stCursor.textContent = `줄 ${line.number}, 열 ${pos - line.from + 1}`;
  },
  onPasteFiles: (files, pos) => insertImages(files, pos),
});

function getContent() {
  return view.state.doc.toString();
}

function onDocChanged() {
  const content = getContent();
  setDirty(content !== doc.savedContent);
  render(content);
  if (prefs.autosave && doc.filePath && doc.dirty) {
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => save(false, { quiet: true }), 1200);
  }
}

function setDirty(dirty) {
  if (dirty === doc.dirty) return;
  doc.dirty = dirty;
  document.body.classList.toggle('dirty', dirty);
  api.setDirty(dirty);
  updateSaveStatus();
}

function updateSaveStatus(text) {
  if (text) el.stSave.textContent = text;
  else el.stSave.textContent = doc.dirty ? (prefs.autosave && doc.filePath ? '자동 저장 대기' : '저장되지 않음') : doc.filePath ? '저장됨' : '';
}

// ───────────────────────── 미리보기 렌더링 ─────────────────────────
let lineMap = []; // [{line, el}] 스크롤 동기화용

function render(content = getContent()) {
  const scrollTop = el.previewPane.scrollTop;
  el.preview.innerHTML = renderMarkdown(content);
  resolveRelativeUrls();
  buildToc();
  buildLineMap();
  updateStats(content);
  el.previewPane.scrollTop = scrollTop;
  renderMermaid(el.preview, darkQuery.matches).then(buildLineMap);
}

function resolveRelativeUrls() {
  if (!doc.dirUrl) return;
  const isRelative = (u) => u && !/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(u);
  for (const img of el.preview.querySelectorAll('img[src]')) {
    const src = img.getAttribute('src');
    if (isRelative(src)) img.src = new URL(src, doc.dirUrl).href;
  }
  for (const a of el.preview.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    if (isRelative(href)) a.href = new URL(href, doc.dirUrl).href;
  }
}

function buildLineMap() {
  lineMap = [...el.preview.querySelectorAll('[data-line]')]
    .map((node) => ({ line: Number(node.dataset.line), el: node }))
    .filter((x) => x.el.offsetParent !== null || x.el === el.preview);
}

function updateStats(content) {
  const text = content.replace(/```[\s\S]*?```/g, ' ').replace(/[#>*_`~\-|[\]()!]/g, ' ');
  const words = (text.match(/\S+/g) || []).length;
  const chars = content.replace(/\s/g, '').length;
  const minutes = Math.max(1, Math.round(chars / 500));
  el.stCount.textContent = `단어 ${words.toLocaleString()} · 글자 ${chars.toLocaleString()}`;
  el.stRead.textContent = `읽는 시간 약 ${minutes}분`;
}

// ───────────────────────── 목차 ─────────────────────────
let tocEntries = [];
function buildToc() {
  const used = new Set();
  tocEntries = [...el.preview.querySelectorAll('h1, h2, h3, h4, h5, h6')].map((h) => {
    h.id = slugify(h.textContent, used);
    return { level: Number(h.tagName[1]), text: h.textContent.trim(), id: h.id, line: Number(h.dataset.line ?? -1), el: h };
  });
  if (!tocEntries.length) {
    el.toc.innerHTML = '<div class="sb-empty">제목(#, ##, ###)을 추가하면<br/>여기에 목차가 표시됩니다.</div>';
    return;
  }
  const minLevel = Math.min(...tocEntries.map((e) => e.level));
  el.toc.replaceChildren(
    ...tocEntries.map((e, i) => {
      const a = document.createElement('a');
      a.className = `toc-item l${e.level - minLevel + 1}`;
      a.textContent = e.text;
      a.title = e.text;
      a.dataset.index = i;
      return a;
    }),
  );
  highlightToc();
}

el.toc.addEventListener('click', (e) => {
  const item = e.target.closest('.toc-item');
  if (!item) return;
  const entry = tocEntries[Number(item.dataset.index)];
  if (!entry) return;
  if (prefs.viewMode !== 'edit') {
    suppressSync('preview');
    el.previewPane.scrollTo({ top: entry.el.offsetTop - 12, behavior: 'smooth' });
  }
  if (prefs.viewMode !== 'preview' && entry.line >= 0) {
    const line = view.state.doc.line(entry.line + 1);
    suppressSync('editor');
    view.dispatch({ selection: { anchor: line.from }, effects: [], scrollIntoView: false });
    const top = view.lineBlockAt(line.from).top;
    view.scrollDOM.scrollTo({ top: top - 12, behavior: 'smooth' });
    if (prefs.viewMode === 'edit') view.focus();
  }
});

function highlightToc() {
  if (!tocEntries.length) return;
  let current = 0;
  if (prefs.viewMode === 'edit') {
    const topLine = editorTopLine();
    tocEntries.forEach((e, i) => {
      if (e.line <= topLine) current = i;
    });
  } else {
    const y = el.previewPane.scrollTop + 40;
    tocEntries.forEach((e, i) => {
      if (e.el.offsetTop <= y) current = i;
    });
  }
  el.toc.querySelectorAll('.toc-item').forEach((a, i) => a.classList.toggle('active', i === current));
}

// ───────────────────────── 스크롤 동기화 ─────────────────────────
let suppressed = { editor: 0, preview: 0 };
const suppressSync = (side) => (suppressed[side] = Date.now() + 600);

function editorTopLine() {
  const block = view.lineBlockAtHeight(view.scrollDOM.scrollTop);
  return view.state.doc.lineAt(block.from).number - 1;
}

function syncFromEditor() {
  highlightTocSoon();
  if (!prefs.syncScroll || prefs.viewMode !== 'split' || Date.now() < suppressed.editor || !lineMap.length) return;
  const scroller = view.scrollDOM;
  if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) {
    suppressSync('preview');
    el.previewPane.scrollTop = el.previewPane.scrollHeight;
    return;
  }
  const block = view.lineBlockAtHeight(scroller.scrollTop);
  const line = view.state.doc.lineAt(block.from).number - 1;
  const frac = block.height ? (scroller.scrollTop - block.top) / block.height : 0;
  let prev = null;
  let next = null;
  for (const item of lineMap) {
    if (item.line <= line) prev = item;
    else {
      next = item;
      break;
    }
  }
  let target;
  if (!prev) target = 0;
  else {
    const prevTop = prev.el.offsetTop;
    const nextTop = next ? next.el.offsetTop : el.preview.scrollHeight;
    const nextLine = next ? next.line : view.state.doc.lines;
    const span = Math.max(1, nextLine - prev.line);
    target = prevTop + ((line - prev.line + frac) / span) * (nextTop - prevTop);
  }
  suppressSync('preview');
  el.previewPane.scrollTop = target - 16;
}

function syncFromPreview() {
  highlightTocSoon();
  if (!prefs.syncScroll || prefs.viewMode !== 'split' || Date.now() < suppressed.preview || !lineMap.length) return;
  const pane = el.previewPane;
  const y = pane.scrollTop + 16;
  let prev = null;
  let next = null;
  for (const item of lineMap) {
    if (item.el.offsetTop <= y) prev = item;
    else {
      next = item;
      break;
    }
  }
  let line;
  if (!prev) line = 0;
  else {
    const nextTop = next ? next.el.offsetTop : el.preview.scrollHeight;
    const nextLine = next ? next.line : view.state.doc.lines;
    const ratio = (y - prev.el.offsetTop) / Math.max(1, nextTop - prev.el.offsetTop);
    line = prev.line + ratio * (nextLine - prev.line);
  }
  const lineNo = Math.min(view.state.doc.lines, Math.max(1, Math.floor(line) + 1));
  const block = view.lineBlockAt(view.state.doc.line(lineNo).from);
  suppressSync('editor');
  view.scrollDOM.scrollTop = block.top + (line % 1) * block.height;
}
el.previewPane.addEventListener('scroll', syncFromPreview, { passive: true });

let tocRaf = 0;
function highlightTocSoon() {
  cancelAnimationFrame(tocRaf);
  tocRaf = requestAnimationFrame(highlightToc);
}

// ───────────────────────── 미리보기 상호작용 ─────────────────────────
el.preview.addEventListener('click', (e) => {
  // 체크박스 → 원본 토글
  const checkbox = e.target.closest('input.task-list-item-checkbox');
  if (checkbox) {
    const li = checkbox.closest('li[data-line]');
    if (li) toggleTaskAtLine(view, Number(li.dataset.line));
    return;
  }
  // 코드 복사
  const copy = e.target.closest('.copy-btn');
  if (copy) {
    const code = copy.parentElement.querySelector('code');
    navigator.clipboard.writeText(code?.innerText ?? '').then(() => {
      copy.textContent = '복사됨';
      setTimeout(() => (copy.textContent = '복사'), 1200);
    });
    return;
  }
  // 문서 내 앵커
  const a = e.target.closest('a[href^="#"]');
  if (a) {
    e.preventDefault();
    const id = decodeURIComponent(a.getAttribute('href').slice(1));
    const target = document.getElementById(id) || el.preview.querySelector(`[name="${CSS.escape(id)}"]`);
    if (target) el.previewPane.scrollTo({ top: target.offsetTop - 12, behavior: 'smooth' });
  }
  // 그 외 링크는 main 프로세스(will-navigate / window open)가 외부 브라우저 또는 새 창으로 처리
});

// 미리보기 더블클릭 → 해당 원본 위치로 이동
el.preview.addEventListener('dblclick', (e) => {
  if (prefs.viewMode === 'preview') return;
  const node = e.target.closest('[data-line]');
  if (!node) return;
  const line = view.state.doc.line(Number(node.dataset.line) + 1);
  view.dispatch({ selection: { anchor: line.from }, scrollIntoView: true });
  view.focus();
});

// ───────────────────────── 저장 / 열기 ─────────────────────────
async function save(saveAs = false, { quiet = false } = {}) {
  clearTimeout(autosaveTimer);
  const content = getContent();
  const result = await api.save(content, saveAs);
  if (!result) return false;
  const pathChanged = result.filePath !== doc.filePath;
  Object.assign(doc, { filePath: result.filePath, name: result.name, dirUrl: result.dirUrl, savedContent: content });
  doc.dirty = true; // setDirty가 변경을 감지하도록
  setDirty(getContent() !== content);
  updateHeader();
  if (pathChanged) {
    render();
    loadRecent();
  }
  if (!quiet) toast(`저장했습니다 — ${result.name}`);
  else updateSaveStatus(`자동 저장됨 ${new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}`);
  return true;
}
// 창 닫기 확인 대화상자에서 main이 호출
window.__mdEditor = { save: () => save(false) };

function loadDocument({ content, filePath, name, dirUrl }) {
  Object.assign(doc, { filePath, name, dirUrl, savedContent: content });
  setDocument(view, content);
  doc.dirty = true;
  setDirty(false);
  updateHeader();
  render(content);
  el.previewPane.scrollTop = 0;
  loadRecent();
  view.focus();
}

function updateHeader() {
  el.title.textContent = doc.name;
  el.stPath.textContent = doc.filePath || '저장되지 않은 새 문서';
  document.title = doc.name;
  updateSaveStatus();
}

// ───────────────────────── 이미지 붙여넣기 / 끌어놓기 ─────────────────────────
async function insertImages(files, pos) {
  if (!doc.filePath) {
    toast('이미지를 저장할 위치가 필요합니다. 먼저 문서를 저장해 주세요.');
    if (!(await save(false))) return;
  }
  const snippets = [];
  for (const file of files) {
    const sourcePath = api.pathForFile(file) || null;
    const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace('svg+xml', 'svg');
    const data = sourcePath ? null : new Uint8Array(await file.arrayBuffer());
    const rel = await api.saveImage({ data, ext, sourcePath });
    if (rel) snippets.push(`![${file.name && sourcePath ? file.name.replace(/\.[^.]+$/, '') : '이미지'}](${encodeURI(rel)})`);
  }
  if (!snippets.length) return;
  const at = pos ?? view.state.selection.main.from;
  const insert = snippets.join('\n');
  view.dispatch({ changes: { from: at, to: pos == null ? view.state.selection.main.to : at, insert }, selection: { anchor: at + insert.length } });
  view.focus();
  toast(`이미지 ${snippets.length}개를 assets/ 폴더에 저장했습니다`);
}

// ───────────────────────── 파일 끌어놓기 (문서 열기) ─────────────────────────
const MD_RE = /\.(md|markdown|mdown|mkd|mdx|txt)$/i;
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  dragDepth++;
  document.body.classList.add('dragging-file');
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    document.body.classList.remove('dragging-file');
  }
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener(
  'drop',
  (e) => {
    dragDepth = 0;
    document.body.classList.remove('dragging-file');
    const files = [...(e.dataTransfer?.files || [])];
    const mdFiles = files.filter((f) => MD_RE.test(f.name));
    if (mdFiles.length) {
      e.preventDefault();
      e.stopPropagation();
      mdFiles.forEach((f) => api.openDropped(api.pathForFile(f)));
    } else if (!e.target.closest?.('.cm-editor')) {
      e.preventDefault();
    }
  },
  true,
);

// ───────────────────────── 사이드바: 최근 문서 ─────────────────────────
// 폴더 탐색은 제공하지 않는다. 사용자가 이미 연 적 있는 파일만 보여준다.
async function loadRecent() {
  const items = await api.recentList();
  $('#recent-clear').hidden = !items.length;
  if (!items.length) {
    el.recentList.innerHTML = '<li class="sb-empty">최근에 연 문서가 여기에 표시됩니다.<br/>⌘O로 파일을 열거나 창에 끌어다 놓으세요.</li>';
    return;
  }
  el.recentList.replaceChildren(
    ...items.map((item) => {
      const li = document.createElement('li');
      li.className = 'recent-item';
      if (item.path === doc.filePath) li.classList.add('current');
      if (!item.exists) li.classList.add('missing');
      li.title = item.exists ? item.path : `${item.path}\n(파일을 찾을 수 없습니다)`;
      li.innerHTML = '<svg class="ri-icon"><use href="#i-file"/></svg><div class="ri-text"><div class="ri-name"></div><div class="ri-dir"></div></div><button class="ri-remove" type="button" title="목록에서 제거"><svg><use href="#i-x"/></svg></button>';
      li.querySelector('.ri-name').textContent = item.name;
      li.querySelector('.ri-dir').textContent = item.exists ? item.dir : '찾을 수 없음';
      li.addEventListener('click', (e) => {
        if (e.target.closest('.ri-remove')) return api.recentRemove(item.path);
        if (!item.exists) return toast('파일이 이동되었거나 삭제되었습니다.', 'error');
        api.recentOpen(item.path);
      });
      return li;
    }),
  );
}
$('#recent-clear').addEventListener('click', () => api.recentClear());
api.onRecentChanged(loadRecent);

document.querySelectorAll('.sb-tab').forEach((tab) =>
  tab.addEventListener('click', () => {
    document.querySelectorAll('.sb-tab').forEach((t) => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.sb-panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === tab.dataset.tab));
  }),
);

// ───────────────────────── 보기 모드 / 분할 크기 ─────────────────────────
function applyPrefs() {
  document.body.dataset.view = prefs.viewMode;
  document.body.dataset.sidebar = prefs.sidebar ? 'on' : 'off';
  document.querySelectorAll('[data-view-mode]').forEach((b) => b.classList.toggle('active', b.dataset.viewMode === prefs.viewMode));
  updateSaveStatus();
  requestAnimationFrame(() => {
    view.requestMeasure();
    buildLineMap();
    highlightToc();
  });
}

try {
  const ratio = Number(localStorage.getItem('split-ratio'));
  if (ratio > 0.15 && ratio < 0.85) el.workspace.style.setProperty('--ratio', ratio);
} catch {
  /* 저장소 사용 불가 */
}
el.divider.addEventListener('pointerdown', (e) => {
  el.divider.setPointerCapture(e.pointerId);
  el.divider.classList.add('dragging');
  const sidebarW = prefs.sidebar ? $('#sidebar').getBoundingClientRect().width : 0;
  const total = el.workspace.getBoundingClientRect().width - sidebarW;
  const move = (ev) => {
    const ratio = Math.min(0.85, Math.max(0.15, (ev.clientX - sidebarW) / total));
    el.workspace.style.setProperty('--ratio', ratio);
  };
  const up = () => {
    el.divider.classList.remove('dragging');
    el.divider.removeEventListener('pointermove', move);
    try {
      localStorage.setItem('split-ratio', el.workspace.style.getPropertyValue('--ratio'));
    } catch {
      /* 무시 */
    }
    buildLineMap();
  };
  el.divider.addEventListener('pointermove', move);
  el.divider.addEventListener('pointerup', up, { once: true });
});

// ───────────────────────── 내보내기 ─────────────────────────
async function exportPdf() {
  render();
  const dark = darkQuery.matches;
  if (dark) await renderMermaid(el.preview, false); // 인쇄물은 항상 밝은 다이어그램
  const out = await api.exportPdf();
  if (dark) render();
  if (out) toast(`PDF로 내보냈습니다 — ${out.split(/[\\/]/).pop()}`);
}

async function exportHtml() {
  render();
  const body = el.preview.cloneNode(true);
  body.querySelectorAll('.copy-btn').forEach((b) => b.remove());
  const hasMath = !!body.querySelector('.katex');
  const html = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(doc.name.replace(/\.[^.]+$/, ''))}</title>
${hasMath ? '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.25/dist/katex.min.css">' : ''}
<style>
${previewCss}
body { margin: 0; background: var(--md-bg); }
</style>
</head>
<body>
<article class="markdown-body">
${body.innerHTML}
</article>
</body>
</html>
`;
  const out = await api.exportHtml(html);
  if (out) toast(`HTML로 내보냈습니다 — ${out.split(/[\\/]/).pop()}`);
}

const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// ───────────────────────── 토스트 ─────────────────────────
function toast(message, type = 'info') {
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = message;
  $('#toasts').append(t);
  setTimeout(() => t.remove(), 2600);
}

// ───────────────────────── 명령 라우팅 ─────────────────────────
const isEditorFocused = () => view.hasFocus;
const commands = {
  save: () => save(false),
  saveAs: () => save(true),
  exportPdf,
  exportHtml,
  reveal: () => api.reveal(),
  toggleSidebar: () => api.setSettings({ sidebar: !prefs.sidebar }),
  undo: () => (isEditorFocused() ? editorCommands.undo(view) : document.execCommand('undo')),
  redo: () => (isEditorFocused() ? editorCommands.redo(view) : document.execCommand('redo')),
  selectAll: () => (isEditorFocused() || prefs.viewMode !== 'preview' ? (view.focus(), editorCommands.selectAll(view)) : document.execCommand('selectAll')),
  find: () => {
    if (prefs.viewMode === 'preview') api.setSettings({ viewMode: 'split' });
    editorCommands.find(view);
  },
  format: (kind) => {
    if (prefs.viewMode === 'preview') return toast('미리보기 모드에서는 편집할 수 없습니다 (⌘1 / ⌘2)');
    applyFormat(view, kind);
  },
};

api.onMenu((cmd, arg) => commands[cmd]?.(arg));
document.querySelectorAll('[data-format]').forEach((b) => b.addEventListener('click', () => commands.format(b.dataset.format)));
document.querySelectorAll('[data-action]').forEach((b) => b.addEventListener('click', () => commands[b.dataset.action]?.()));
document.querySelectorAll('[data-view-mode]').forEach((b) => b.addEventListener('click', () => api.setSettings({ viewMode: b.dataset.viewMode })));
el.stPath.addEventListener('click', () => doc.filePath && api.reveal());

api.onSettings((patch) => {
  Object.assign(prefs, patch);
  applyPrefs();
  if ('autosave' in patch && patch.autosave && doc.dirty && doc.filePath) save(false, { quiet: true });
});
darkQuery.addEventListener('change', () => render());

// ───────────────────────── 외부 변경 ─────────────────────────
api.onExternalChange(async ({ content }) => {
  if (content === getContent()) {
    doc.savedContent = content;
    setDirty(false);
    return;
  }
  if (!doc.dirty || (await api.confirmReload())) {
    replaceDoc(view, content);
    doc.savedContent = content;
    setDirty(false);
    render(content);
    toast('다른 프로그램에서 변경된 내용을 불러왔습니다');
  } else {
    doc.savedContent = content; // 이후 저장 시 덮어씀
    setDirty(true);
  }
});
api.onExternalDelete(() => {
  doc.savedContent = null;
  setDirty(true);
  toast('파일이 삭제되었거나 이동되었습니다. 저장하면 다시 만들어집니다.', 'error');
});

api.onLoad(loadDocument);

// ───────────────────────── 시작 ─────────────────────────
(async () => {
  const { settings, doc: initialDoc } = await api.ready();
  Object.assign(prefs, settings);
  applyPrefs();
  if (initialDoc) loadDocument(initialDoc);
  else {
    updateHeader();
    render('');
    loadRecent();
    view.focus();
  }
})();
