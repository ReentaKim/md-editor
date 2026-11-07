// MD Editor — renderer 진입점
import { createEditor, createState, serializeState, deserializeState, revealMatch, replaceDoc, applyFormat, editorCommands, insertPlainText, toggleTaskAtLine } from './editor.js';
import { renderMarkdown, renderMermaid, slugify } from './markdown.js';
import previewCss from './preview.css';

const api = window.api;
const $ = (sel) => document.querySelector(sel);

// preview.css는 문자열로 번들되어 있으므로(HTML 내보내기에도 재사용) 여기서 주입한다.
const styleEl = document.createElement('style');
styleEl.textContent = previewCss;
document.head.prepend(styleEl);
const isMac = api.platform === 'darwin';
if (!isMac) document.body.classList.add('not-mac');

/** 맥 단축키 기호(⌘⌥⇧⌃)를 Windows 표기(Ctrl+Alt+Shift+…)로 */
function shortcut(text) {
  if (isMac) return text;
  return text.replace(/([⌃⌥⇧⌘]+)(\S)/g, (_, mods, key) => {
    const parts = [];
    if (mods.includes('⌘') || mods.includes('⌃')) parts.push('Ctrl');
    if (mods.includes('⌥')) parts.push('Alt');
    if (mods.includes('⇧')) parts.push('Shift');
    return [...parts, key.toUpperCase()].join('+');
  });
}
if (!isMac) {
  for (const node of document.querySelectorAll('[title]')) node.title = shortcut(node.title).replace('Finder', '탐색기');
}

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
  tabs: $('#tabs'),
};

/**
 * 탭 = 문서 하나. 편집기(view)는 하나만 두고, 탭을 바꿀 때 EditorState를 통째로 교체한다.
 * → 탭마다 실행 취소 기록·커서·스크롤 위치가 따로 유지된다.
 * @typedef {{id:number, filePath:string|null, name:string, dirUrl:string|null, savedContent:string|null,
 *   dirty:boolean, state:any, editorScroll:number, previewScroll:number, pendingExternal:string|null}} Tab
 */
/** @type {Tab[]} */
const tabs = [];
/** @type {Tab} 현재 활성 탭 */
let doc = null;
const prefs = { viewMode: 'split', sidebar: true, syncScroll: true, autosave: false, theme: 'system' };
/** 테마 버튼: 누를 때마다 시스템 → 라이트 → 다크 순서로 바뀐다. */
const THEMES = { system: '시스템 설정 따르기', light: '라이트', dark: '다크' };
const THEME_ORDER = Object.keys(THEMES);
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
  onScroll: () => {
    syncFromEditor();
    scheduleSnapshot();
  },
  onCursor: (state) => {
    scheduleSnapshot();
    const pos = state.selection.main.head;
    const line = state.doc.lineAt(pos);
    el.stCursor.textContent = `줄 ${line.number}, 열 ${pos - line.from + 1}`;
  },
  onPasteFiles: (files, pos) => insertImages(files, pos),
  placeholderText: shortcut('여기에 마크다운을 입력하세요…  (⌘O 파일 열기 · 파일을 끌어다 놓아도 됩니다)'),
});

// ───────────────────────── 세션 기록 ─────────────────────────
// 탭 목록·커서·스크롤과 저장 안 된 내용을 main에 보내 둔다 → 다시 켜거나 앱이 갑자기 꺼져도 복원
let snapshotTimer = null;
function scheduleSnapshot() {
  clearTimeout(snapshotTimer);
  snapshotTimer = setTimeout(() => api.sessionUpdate(takeSnapshot()), 800);
}
function takeSnapshot() {
  return {
    active: doc?.id ?? null,
    tabs: tabs
      .map((tab) => {
        const live = tab === doc;
        const state = live ? view.state : tab.state;
        const { anchor, head } = state.selection.main;
        // 내용은 저장 안 된 탭과 제목 없는 탭만 기록한다 (저장된 파일 탭은 다시 켤 때 디스크에서 읽는다)
        const content = tab.dirty || !tab.filePath ? state.doc.toString() : '';
        const keep = tab.dirty || (!tab.filePath && content !== '');
        return {
          tabId: tab.id,
          filePath: tab.filePath,
          name: tab.name,
          dirty: tab.dirty,
          content: keep ? content : null,
          saved: tab.filePath ? undefined : tab.savedContent,
          selection: { anchor, head },
          editorScroll: live ? view.scrollDOM.scrollTop : tab.editorScroll,
          previewScroll: live ? el.previewPane.scrollTop : tab.previewScroll,
        };
      })
      .filter((t) => t.filePath || t.content),
  };
}

function getContent() {
  return view.state.doc.toString();
}

function onDocChanged() {
  if (!doc) return;
  const content = getContent();
  setTabDirty(doc, content !== doc.savedContent);
  render(content);
  if (prefs.autosave && doc.filePath && doc.dirty) {
    clearTimeout(autosaveTimer);
    const tabId = doc.id;
    autosaveTimer = setTimeout(() => save(false, { quiet: true, tabId }), 1200);
  }
}

function setTabDirty(tab, dirty) {
  if (dirty === tab.dirty) return;
  tab.dirty = dirty;
  api.setDirty(tab.id, dirty);
  if (tab === doc) {
    document.body.classList.toggle('dirty', dirty);
    updateSaveStatus();
  }
  renderTabs();
}

const tabContent = (tab) => (tab === doc ? getContent() : tab.state.doc.toString());

function updateSaveStatus(text) {
  if (!doc) return;
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
async function save(saveAs = false, { quiet = false, tabId = doc?.id } = {}) {
  const tab = tabs.find((t) => t.id === tabId);
  if (!tab) return false;
  if (tab === doc) clearTimeout(autosaveTimer);
  const content = tabContent(tab);
  const result = await api.save(tab.id, content, saveAs);
  if (!result) return false;
  const pathChanged = result.filePath !== tab.filePath;
  Object.assign(tab, { filePath: result.filePath, name: result.name, dirUrl: result.dirUrl, savedContent: content });
  tab.dirty = !tab.dirty; // setTabDirty가 항상 반영하도록
  setTabDirty(tab, tabContent(tab) !== content);
  renderTabs();
  if (tab === doc) {
    updateHeader();
    if (pathChanged) render();
    if (quiet) updateSaveStatus(`자동 저장됨 ${new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}`);
  }
  if (pathChanged) loadRecent();
  if (!quiet) toast(`저장했습니다 — ${result.name}`);
  return true;
}

function makeTab(id, data = {}) {
  return {
    id,
    filePath: null,
    name: '제목 없음',
    dirUrl: null,
    savedContent: '',
    dirty: false,
    state: createState(view, ''),
    editorScroll: 0,
    previewScroll: 0,
    pendingExternal: null,
    ...data,
  };
}

/** main이 연 문서를 탭에 싣는다(빈 탭 재사용 또는 새 탭) */
function loadDocument({ tabId, content, filePath, name, dirUrl }) {
  let tab = tabs.find((t) => t.id === tabId);
  if (!tab) {
    tab = makeTab(tabId);
    tabs.splice(doc ? tabs.indexOf(doc) + 1 : tabs.length, 0, tab);
  }
  Object.assign(tab, { filePath, name, dirUrl, savedContent: content, state: createState(view, content), editorScroll: 0, previewScroll: 0 });
  tab.dirty = true;
  setTabDirty(tab, false);
  if (tab === doc) doc = null; // 같은 탭이라도 새 상태로 다시 활성화
  activateTab(tab.id);
}

function activateTab(id) {
  const tab = tabs.find((t) => t.id === id);
  if (!tab) return;
  if (doc && doc !== tab) {
    doc.state = view.state;
    doc.editorScroll = view.scrollDOM.scrollTop;
    doc.previewScroll = el.previewPane.scrollTop;
  }
  const switching = doc !== tab;
  doc = tab;
  if (switching || view.state !== tab.state) view.setState(tab.state);
  clearTimeout(autosaveTimer);
  document.body.classList.toggle('dirty', tab.dirty);
  updateHeader();
  render(getContent());
  suppressSync('editor');
  suppressSync('preview');
  requestAnimationFrame(() => {
    view.scrollDOM.scrollTop = tab.editorScroll;
    el.previewPane.scrollTop = tab.previewScroll;
  });
  const pos = view.state.selection.main.head;
  const line = view.state.doc.lineAt(pos);
  el.stCursor.textContent = `줄 ${line.number}, 열 ${pos - line.from + 1}`;
  renderTabs();
  loadRecent();
  api.tabActivated(tab.id);
  if (tab.pendingExternal != null) {
    const content = tab.pendingExternal;
    tab.pendingExternal = null;
    handleExternalChange(tab, content);
  }
  if (prefs.viewMode !== 'preview') view.focus();
}

async function newTab() {
  const id = await api.newTab();
  const tab = makeTab(id);
  tabs.splice(doc ? tabs.indexOf(doc) + 1 : tabs.length, 0, tab);
  activateTab(id);
}

async function closeTab(id = doc?.id) {
  const tab = tabs.find((t) => t.id === id);
  if (!tab) return;
  if (tab.dirty) {
    if (tab !== doc) activateTab(tab.id);
    const answer = await api.confirmCloseTab(tab.name);
    if (answer === 'cancel') return;
    if (answer === 'save' && !(await save(false, { tabId: tab.id }))) return;
  }
  // 이미 빈 "제목 없음" 탭 하나만 남았을 때 ⌘W → 창을 닫는다
  if (tabs.length === 1 && isBlank(tab)) return api.closeWindow();
  const index = tabs.indexOf(tab);
  tabs.splice(index, 1);
  api.tabClosed(tab.id);
  if (!tabs.length) {
    // 마지막 문서를 닫으면 창은 남기고 빈 "제목 없음" 탭으로 바꾼다
    doc = null;
    await newTab();
    return;
  }
  if (tab === doc) {
    doc = null;
    activateTab(tabs[Math.min(index, tabs.length - 1)].id);
  } else renderTabs();
}

/** 저장된 적 없고, 아무것도 입력하지 않은 탭 */
const isBlank = (tab) => !tab.filePath && !tab.dirty && tabContent(tab) === '';

function cycleTab(step) {
  if (tabs.length < 2) return;
  const i = tabs.indexOf(doc);
  activateTab(tabs[(i + step + tabs.length) % tabs.length].id);
}

// 창 닫기 확인 대화상자에서 main이 호출
window.__mdEditor = {
  save: (tabId) => save(false, { tabId }),
  snapshot: () => {
    clearTimeout(snapshotTimer);
    return takeSnapshot();
  },
  activate: (tabId) => activateTab(tabId),
  // 탭을 다른 창으로 옮길 때 main이 호출
  exportTab: (tabId) => {
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab) return null;
    if (tab === doc) {
      tab.state = view.state;
      tab.editorScroll = view.scrollDOM.scrollTop;
      tab.previewScroll = el.previewPane.scrollTop;
    }
    const { id, filePath, name, dirUrl, savedContent, dirty, editorScroll, previewScroll, pendingExternal } = tab;
    return { tabId: id, filePath, name, dirUrl, savedContent, dirty, editorScroll, previewScroll, pendingExternal, state: serializeState(tab.state) };
  },
  removeTab: (tabId) => {
    const index = tabs.findIndex((t) => t.id === tabId);
    if (index < 0) return;
    const [tab] = tabs.splice(index, 1);
    if (!tabs.length) return void (doc = null); // 남은 탭이 없으면 main이 이 창을 닫는다
    if (tab === doc) {
      doc = null;
      activateTab(tabs[Math.min(index, tabs.length - 1)].id);
    } else renderTabs();
  },
};

// 다른 창에서 옮겨 온 탭 받기
api.onTabImport(({ data, index }) => {
  // 아무것도 입력하지 않은 "제목 없음" 탭 하나뿐이면 그 자리를 대신한다
  if (tabs.length === 1 && isBlank(tabs[0])) {
    api.tabClosed(tabs[0].id);
    tabs.length = 0;
    doc = null;
  }
  const { tabId, state, ...fields } = data;
  const tab = makeTab(tabId, { ...fields, state: deserializeState(view, state) });
  const at = index == null ? (doc ? tabs.indexOf(doc) + 1 : tabs.length) : Math.max(0, Math.min(index, tabs.length));
  tabs.splice(at, 0, tab);
  activateTab(tabId);
  toast(`"${tab.name}" 탭을 이 창으로 옮겼습니다`);
});

function updateHeader() {
  el.title.textContent = doc.name;
  el.stPath.textContent = doc.filePath || '저장되지 않은 새 문서';
  document.title = doc.name;
  updateSaveStatus();
}

// ───────────────────────── 탭 바 ─────────────────────────
function renderTabs() {
  scheduleSnapshot();
  el.tabs.replaceChildren(
    ...tabs.map((tab) => {
      const node = document.createElement('div');
      node.className = 'tab';
      node.dataset.id = tab.id;
      node.draggable = true;
      node.setAttribute('role', 'tab');
      node.setAttribute('aria-selected', String(tab === doc));
      node.title = tab.filePath || tab.name;
      if (tab === doc) node.classList.add('active');
      if (tab.dirty) node.classList.add('dirty');
      node.innerHTML = '<svg class="tab-icon"><use href="#i-file"/></svg><span class="tab-name"></span><button class="tab-close" type="button" title="탭 닫기 (⌘W)"><svg><use href="#i-x"/></svg></button>';
      node.querySelector('.tab-name').textContent = tab.name;
      return node;
    }),
  );
  el.tabs.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

el.tabs.addEventListener('click', (e) => {
  const node = e.target.closest('.tab');
  if (!node) return;
  const id = Number(node.dataset.id);
  if (e.target.closest('.tab-close')) closeTab(id);
  else if (id !== doc?.id) activateTab(id);
});
el.tabs.addEventListener('auxclick', (e) => {
  const node = e.target.closest('.tab');
  if (node && e.button === 1) closeTab(Number(node.dataset.id)); // 가운데 버튼으로 닫기
});
el.tabs.addEventListener('dblclick', (e) => {
  if (!e.target.closest('.tab')) newTab(); // 빈 곳 더블클릭 → 새 탭
});
$('#tab-add').addEventListener('click', () => newTab());
// 세로 휠로도 탭 목록 가로 스크롤
el.tabs.addEventListener('wheel', (e) => {
  if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
    el.tabs.scrollLeft += e.deltaY;
    e.preventDefault();
  }
}, { passive: false });

// 끌어서 순서 바꾸기
let draggingTabId = null;
el.tabs.addEventListener('dragstart', (e) => {
  const node = e.target.closest('.tab');
  if (!node) return;
  draggingTabId = Number(node.dataset.id);
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('application/x-md-tab', String(draggingTabId));
  node.classList.add('dragging');
  api.tabDragStart(draggingTabId); // 다른 창에 놓거나 창 밖에 놓는 경우를 main이 처리
});
el.tabs.addEventListener('dragover', (e) => {
  if (draggingTabId == null) return;
  e.preventDefault();
  const over = e.target.closest('.tab');
  if (!over || Number(over.dataset.id) === draggingTabId) return;
  const from = tabs.findIndex((t) => t.id === draggingTabId);
  const rect = over.getBoundingClientRect();
  let to = tabs.findIndex((t) => t.id === Number(over.dataset.id));
  if (e.clientX > rect.left + rect.width / 2) to += 1;
  if (from < to) to -= 1;
  if (from === to) return;
  const [moved] = tabs.splice(from, 1);
  tabs.splice(to, 0, moved);
  renderTabs();
  el.tabs.querySelector(`.tab[data-id="${draggingTabId}"]`)?.classList.add('dragging');
});
el.tabs.addEventListener('dragend', () => {
  if (draggingTabId != null) api.tabDragEnd(draggingTabId);
  draggingTabId = null;
  el.tabs.querySelector('.tab.dragging')?.classList.remove('dragging');
});

// 다른 창에서 끌려 온 탭 받기: 탭 바 위면 그 위치에, 그 밖이면 맨 끝에 넣는다
let foreignTabDrag = false;
const isTabDrag = (e) => [...(e.dataTransfer?.types || [])].includes('application/x-md-tab');
window.addEventListener('dragenter', async (e) => {
  if (draggingTabId != null || [...(e.dataTransfer?.types || [])].includes('Files')) return;
  if (isTabDrag(e) || (await api.tabDragActive())) {
    foreignTabDrag = true;
    document.body.classList.add('tab-drop-target');
  }
}, true);
window.addEventListener('dragover', (e) => {
  if (draggingTabId != null || !(foreignTabDrag || isTabDrag(e))) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
}, true);
window.addEventListener('dragleave', (e) => {
  if (e.relatedTarget == null && foreignTabDrag) {
    foreignTabDrag = false;
    document.body.classList.remove('tab-drop-target');
  }
}, true);
function tabDropIndex(e) {
  const over = e.target.closest?.('.tab');
  if (!over) return null;
  const i = tabs.findIndex((t) => t.id === Number(over.dataset.id));
  const rect = over.getBoundingClientRect();
  return e.clientX > rect.left + rect.width / 2 ? i + 1 : i;
}
window.addEventListener('drop', (e) => {
  if (draggingTabId != null && isTabDrag(e)) {
    // 같은 창 안에서 끌다 편집기 등에 놓은 경우: 글자로 들어가지 않게 막기만 한다
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  if (!(foreignTabDrag || isTabDrag(e))) return;
  e.preventDefault();
  e.stopPropagation();
  foreignTabDrag = false;
  document.body.classList.remove('tab-drop-target');
  api.tabDropHere(tabDropIndex(e));
}, true);

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
    const rel = await api.saveImage({ tabId: doc.id, data, ext, sourcePath });
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
  // 검색 결과를 보여 주는 중에는 '목록 지우기'를 숨긴다
  $('#recent-clear').hidden = !items.length || document.querySelector('#search-results')?.hidden === false;
  if (!items.length) {
    el.recentList.innerHTML = '<li class="sb-empty">최근에 연 문서가 여기에 표시됩니다.<br/>⌘O로 파일을 열거나 창에 끌어다 놓으세요.</li>';
    return;
  }
  el.recentList.replaceChildren(
    ...items.map((item) => {
      const li = document.createElement('li');
      li.className = 'recent-item';
      if (item.path === doc?.filePath) li.classList.add('current');
      else if (tabs.some((t) => t.filePath === item.path)) li.classList.add('open');
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

// ───────────────────────── 최근 문서 내용 검색 ─────────────────────────
const queryInput = $('#recent-query');
const resultsBox = $('#search-results');
let searchTimer = null;
let searchSeq = 0;
let lastResults = [];

function snippetHtml(text, start, length) {
  const from = Math.max(0, start - 28);
  const to = Math.min(text.length, start + length + 70);
  return (
    (from > 0 ? '…' : '') +
    escapeHtml(text.slice(from, start).trimStart()) +
    `<mark>${escapeHtml(text.slice(start, start + length))}</mark>` +
    escapeHtml(text.slice(start + length, to)) +
    (to < text.length ? '…' : '')
  );
}

function setSearchMode(on) {
  resultsBox.hidden = !on;
  el.recentList.hidden = on;
  $('#recent-clear').hidden = on || !el.recentList.querySelector('.recent-item');
}

async function runSearch() {
  const query = queryInput.value.trim();
  const seq = ++searchSeq;
  if (!query) {
    setSearchMode(false);
    lastResults = [];
    return;
  }
  const results = await api.recentSearch(query);
  if (seq !== searchSeq) return; // 그 사이 검색어가 바뀜
  lastResults = results;
  setSearchMode(true);
  if (!results.length) {
    resultsBox.innerHTML = `<div class="sb-empty">"${escapeHtml(query)}"이(가) 들어간 문서가 없습니다.<br/>최근 문서 목록에 있는 파일만 검색합니다.</div>`;
    return;
  }
  const total = results.reduce((n, r) => n + r.total, 0);
  resultsBox.innerHTML =
    `<div class="sr-summary">문서 ${results.length}개 · ${total}곳</div>` +
    results
      .map(
        (r, i) => `<div class="sr-file" data-i="${i}">
          <div class="sr-head" data-i="${i}" title="${escapeHtml(r.path)}"><svg><use href="#i-file"/></svg><span class="sr-name">${escapeHtml(r.name)}</span>${r.total ? `<span class="sr-count">${r.total}</span>` : ''}</div>
          ${r.matches
            .map((m, j) => `<div class="sr-line" data-i="${i}" data-j="${j}"><span class="sr-no">${m.line + 1}</span><span class="sr-text">${snippetHtml(m.text, m.start, m.length)}</span></div>`)
            .join('')}
          ${r.total > r.matches.length ? `<div class="sr-more">… ${r.total - r.matches.length}곳 더</div>` : ''}
        </div>`,
      )
      .join('');
}

function openResult(i, j = 0) {
  const r = lastResults[i];
  if (!r) return;
  const m = r.matches[j];
  api.recentOpen(r.path, m ? { line: m.line, query: queryInput.value.trim() } : null);
}

queryInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 180);
});
queryInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') openResult(0);
  else if (e.key === 'Escape') {
    queryInput.value = '';
    runSearch();
  }
});
resultsBox.addEventListener('click', (e) => {
  const row = e.target.closest('.sr-line, .sr-head');
  if (row) openResult(Number(row.dataset.i), Number(row.dataset.j ?? 0));
});
// 검색 중에 최근 문서 목록이 바뀌면(파일을 열거나 저장) 결과도 다시
api.onRecentChanged(() => queryInput.value.trim() && runSearch());

function focusRecentSearch() {
  if (!prefs.sidebar) api.setSettings({ sidebar: true });
  document.querySelector('.sb-tab[data-tab="recent"]').click();
  queryInput.focus();
  queryInput.select();
}

// 검색 결과로 문서를 열면 main이 보내 준다: 해당 줄의 검색어를 선택
api.onTabReveal(({ tabId, line, query }) => {
  setTimeout(() => {
    if (doc?.id !== tabId) activateTab(tabId);
    revealMatch(view, line, query);
    if (prefs.viewMode === 'preview') {
      const target = [...lineMap].reverse().find((x) => x.line <= line);
      if (target) el.previewPane.scrollTo({ top: target.el.offsetTop - 40, behavior: 'smooth' });
    }
  }, 60);
});
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
  const theme = THEMES[prefs.theme] ? prefs.theme : 'system';
  const themeBtn = $('#theme-btn');
  themeBtn.querySelector('use').setAttribute('href', `#i-theme-${theme}`);
  themeBtn.title = `테마: ${THEMES[theme]} (누르면 바뀜)`;
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
  const out = await api.exportPdf(doc.id);
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
${hasMath ? `<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@${__KATEX_VERSION__}/dist/katex.min.css">` : ''}
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
  const out = await api.exportHtml(doc.id, html);
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
  reveal: () => api.reveal(doc.id),
  newTab: () => newTab(),
  closeTab: () => closeTab(),
  nextTab: () => cycleTab(1),
  searchRecent: () => focusRecentSearch(),
  detachTab: async () => {
    if (!(await api.tabDetach(doc.id))) toast('탭이 하나뿐이라 새 창으로 옮길 수 없습니다');
  },
  prevTab: () => cycleTab(-1),
  toggleSidebar: () => api.setSettings({ sidebar: !prefs.sidebar }),
  cycleTheme: () => {
    const next = THEME_ORDER[(THEME_ORDER.indexOf(prefs.theme) + 1) % THEME_ORDER.length];
    api.setSettings({ theme: next });
    toast(`테마: ${THEMES[next]}`);
  },
  undo: () => (isEditorFocused() ? editorCommands.undo(view) : document.execCommand('undo')),
  redo: () => (isEditorFocused() ? editorCommands.redo(view) : document.execCommand('redo')),
  selectAll: () => (isEditorFocused() || prefs.viewMode !== 'preview' ? (view.focus(), editorCommands.selectAll(view)) : document.execCommand('selectAll')),
  find: () => {
    if (prefs.viewMode === 'preview') api.setSettings({ viewMode: 'split' });
    editorCommands.find(view);
  },
  pastePlain: (text) => {
    if (!text) return;
    const a = document.activeElement;
    if (view.contentDOM.contains(a)) return insertPlainText(view, text);
    // 검색창 같은 입력란
    if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')) document.execCommand('insertText', false, text);
  },
  format: (kind) => {
    if (prefs.viewMode === 'preview') return toast(shortcut('미리보기 모드에서는 편집할 수 없습니다 (⌘1 / ⌘2)'));
    applyFormat(view, kind);
  },
};

api.onMenu((cmd, arg) => commands[cmd]?.(arg));
document.querySelectorAll('[data-format]').forEach((b) => b.addEventListener('click', () => commands.format(b.dataset.format)));
document.querySelectorAll('[data-action]').forEach((b) => b.addEventListener('click', () => commands[b.dataset.action]?.()));
document.querySelectorAll('[data-view-mode]').forEach((b) => b.addEventListener('click', () => api.setSettings({ viewMode: b.dataset.viewMode })));
el.stPath.addEventListener('click', () => doc?.filePath && api.reveal(doc.id));

api.onSettings((patch) => {
  Object.assign(prefs, patch);
  applyPrefs();
  if ('autosave' in patch && patch.autosave && doc?.dirty && doc.filePath) save(false, { quiet: true });
});
darkQuery.addEventListener('change', () => render());

// ───────────────────────── 업데이트 알림 카드 ─────────────────────────
const updateCard = $('#update-card');
function renderUpdate(s = {}) {
  const v = escapeHtml(String(s.version || ''));
  const card = (title, body, actions = '', extra = '') => {
    updateCard.className = s.status === 'error' ? 'error' : '';
    updateCard.innerHTML = `<svg class="uc-icon"><use href="#i-update"/></svg><div class="uc-title">${title}</div><div class="uc-body">${body}</div>${extra}${actions ? `<div class="uc-actions">${actions}</div>` : ''}`;
    updateCard.hidden = false;
  };
  const btn = (action, label, primary = false) => `<button type="button" data-update="${action}"${primary ? ' class="primary"' : ''}>${label}</button>`;
  switch (s.status) {
    case 'checking':
      return card('업데이트 확인 중…', 'GitHub에서 최신 버전을 확인하고 있습니다.');
    case 'available':
      return s.canInstall
        ? card(`새 버전 v${v}`, `현재 v${escapeHtml(appVersion)} — 지금 업데이트할 수 있습니다.`, btn('download', '업데이트', true) + btn('notes', '변경 사항') + btn('dismiss', '나중에'))
        : card(`새 버전 v${v}`, '이 환경에서는 자동 설치를 지원하지 않습니다. 릴리스 페이지에서 내려받아 주세요.', btn('notes', '다운로드 페이지', true) + btn('dismiss', '나중에'));
    case 'downloading': {
      const pct = s.progress == null ? null : Math.round(s.progress * 100);
      return card(`v${v} 다운로드 중…${pct == null ? '' : ` ${pct}%`}`, '다운로드하는 동안 계속 작업할 수 있습니다.', '',
        `<div class="uc-progress${pct == null ? ' indeterminate' : ''}" style="grid-column:2"><div style="width:${pct ?? 0}%"></div></div>`);
    }
    case 'verifying':
      return card('파일 확인 중…', '받은 파일의 SHA-256과 앱 서명을 확인하고 있습니다.');
    case 'ready':
      return s.onQuit
        ? card(`v${v} 설치 예약됨`, '앱을 종료하면 자동으로 설치됩니다.', btn('install-now', '지금 재시작', true))
        : card(`v${v} 설치 준비 완료`, '재시작하면 새 버전으로 바뀝니다. 저장하지 않은 문서는 종료할 때 저장 여부를 묻습니다.', btn('install-now', '지금 재시작', true) + btn('install-later', '종료할 때 설치'));
    case 'error':
      return card('업데이트 실패', escapeHtml(s.message || '알 수 없는 오류'), btn('download', '다시 시도', true) + btn('notes', '다운로드 페이지') + btn('dismiss', '닫기'));
    default:
      updateCard.hidden = true;
  }
}
let appVersion = '';
updateCard.addEventListener('click', (e) => {
  const action = e.target.closest('[data-update]')?.dataset.update;
  const actions = {
    download: api.updateDownload,
    notes: api.updateOpenPage,
    dismiss: api.updateDismiss,
    'install-now': api.updateInstallNow,
    'install-later': api.updateInstallLater,
  };
  actions[action]?.();
});
api.onUpdateState(renderUpdate);

// ───────────────────────── 외부 변경 ─────────────────────────
async function handleExternalChange(tab, content) {
  if (content === tabContent(tab)) {
    tab.savedContent = content;
    setTabDirty(tab, false);
    return;
  }
  if (tab !== doc) {
    // 보이지 않는 탭: 편집 중이 아니면 조용히 반영, 편집 중이면 그 탭을 열 때 묻는다
    if (!tab.dirty) {
      tab.state = tab.state.update({ changes: { from: 0, to: tab.state.doc.length, insert: content } }).state;
      tab.savedContent = content;
      toast(`"${tab.name}" — 다른 프로그램에서 변경된 내용을 불러왔습니다`);
    } else tab.pendingExternal = content;
    return;
  }
  if (!tab.dirty || (await api.confirmReload(tab.name))) {
    replaceDoc(view, content);
    tab.savedContent = content;
    setTabDirty(tab, false);
    render(content);
    toast('다른 프로그램에서 변경된 내용을 불러왔습니다');
  } else {
    tab.savedContent = content; // 이후 저장 시 덮어씀
    setTabDirty(tab, true);
  }
}
api.onExternalChange(({ tabId, content }) => {
  const tab = tabs.find((t) => t.id === tabId);
  if (tab) handleExternalChange(tab, content);
});
api.onExternalDelete(({ tabId }) => {
  const tab = tabs.find((t) => t.id === tabId);
  if (!tab) return;
  tab.savedContent = null;
  setTabDirty(tab, true);
  toast(`"${tab.name}" 파일이 삭제되었거나 이동되었습니다. 저장하면 다시 만들어집니다.`, 'error');
});

api.onLoad(loadDocument);
api.onTabActivate((tabId) => activateTab(tabId));

// ───────────────────────── 시작 ─────────────────────────
(async () => {
  const { settings, tabId, restore, update, updatedTo, version } = await api.ready();
  appVersion = version;
  Object.assign(prefs, settings);
  applyPrefs();
  if (restore) {
    // 이전 세션의 탭 복원
    for (const r of restore.tabs) {
      tabs.push(
        makeTab(r.tabId, {
          filePath: r.filePath,
          name: r.name,
          dirUrl: r.dirUrl,
          savedContent: r.savedContent,
          dirty: r.dirty,
          state: createState(view, r.content, r.selection),
          editorScroll: r.editorScroll,
          previewScroll: r.previewScroll,
        }),
      );
    }
    activateTab(restore.active);
    const recovered = restore.tabs.filter((r) => r.dirty).length;
    if (recovered) toast(`저장하지 않은 문서 ${recovered}개를 복구했습니다`);
  } else {
    tabs.push(makeTab(tabId));
    activateTab(tabId);
  }
  renderUpdate(update);
  if (updatedTo) toast(`v${updatedTo}(으)로 업데이트했습니다`);
})();
