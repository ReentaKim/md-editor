// MD Editor — main process
// 창 1개 = 탭 여러 개. 탭마다 파일 경로/변경 여부/파일 감시 상태를 main에서 관리한다.
const { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, shell, nativeTheme, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = fs.promises;
const { pathToFileURL, fileURLToPath } = require('node:url');
const updater = require('./updater');
const session = require('./session');

const MD_EXTENSIONS = ['md', 'markdown', 'mdown', 'mkd', 'mdx', 'txt'];
const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';

/** 맥 단축키 기호(⌘⌥⇧⌃)를 Windows 표기(Ctrl+Alt+Shift+…)로 바꾼다 */
function toPlatformShortcuts(text) {
  if (isMac) return text;
  return text.replace(/([⌃⌥⇧⌘]+)(\S)/g, (_, mods, key) => {
    const parts = [];
    if (mods.includes('⌘') || mods.includes('⌃')) parts.push('Ctrl');
    if (mods.includes('⌥')) parts.push('Alt');
    if (mods.includes('⇧')) parts.push('Shift');
    return [...parts, key.toUpperCase()].join('+');
  });
}
// 개발/테스트용: 설치된 앱과 설정·단일 인스턴스 잠금을 분리
if (process.env.MD_EDITOR_USER_DATA) app.setPath('userData', process.env.MD_EDITOR_USER_DATA);

// ───────────────────────── 설정 (JSON 파일) ─────────────────────────
const settings = {
  theme: 'system', // system | light | dark
  recentFiles: [],
  viewMode: 'split', // edit | split | preview
  sidebar: true,
  syncScroll: true,
  autosave: false,
  autoUpdateCheck: true,
  restoreSession: true, // 시작할 때 이전 창·탭 다시 열기 (꺼도 저장 안 된 내용은 복구)
  windowBounds: { width: 1400, height: 900 },
};
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try {
    Object.assign(settings, JSON.parse(fs.readFileSync(settingsFile(), 'utf8')));
  } catch {
    /* 최초 실행 */
  }
}
let saveTimer = null;
function saveSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
      fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
    } catch (err) {
      console.error('설정 저장 실패', err);
    }
  }, 200);
}

function addRecent(filePath) {
  settings.recentFiles = [filePath, ...settings.recentFiles.filter((f) => f !== filePath)].slice(0, 15);
  if (isMac) app.addRecentDocument(filePath);
  recentChanged();
}
function removeRecent(filePath) {
  settings.recentFiles = settings.recentFiles.filter((f) => f !== filePath);
  recentChanged();
}
function recentChanged() {
  saveSettings();
  buildMenu();
  for (const w of windows.values()) w.win.webContents.send('recent:changed');
}
const isMarkdownPath = (p) => typeof p === 'string' && MD_EXTENSIONS.includes(path.extname(p).slice(1).toLowerCase());
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'];

// ───────────────────────── 창 / 탭 상태 ─────────────────────────
/**
 * @typedef {{id:number, w:WinState, filePath:string|null, dirty:boolean, diskContent:string|null, blank:boolean, unwatch?:Function|null}} TabState
 * @typedef {{win:BrowserWindow, tabs:Map<number,TabState>, activeTab:number|null, ready:boolean, queue:Array, forceClose:boolean}} WinState
 */
/** @type {Map<number, WinState>} webContents.id → 창 상태 */
const windows = new Map();
let tabSeq = 0;
let quitting = false;
let lastFocused = null; // 앱이 비활성일 때(Finder에서 열기) 사용할 창
const pendingOpenPaths = []; // 앱 준비 전 Finder "다음으로 열기"로 들어온 파일

// ───────────────────────── 세션 (이전 탭 복원 · 저장 안 된 내용 보존) ─────────────────────────
/** 세션에 기록할 창. 닫힌 창도 종료 중이었거나 마지막 창이었다면 남겨서 다음 실행 때 복원한다. */
const sessionWins = [];
function sessionData() {
  return {
    windows: sessionWins
      .filter((w) => w.snapshot?.tabs?.length)
      .map((w) => ({ bounds: w.bounds, active: w.snapshot.active, tabs: w.snapshot.tabs })),
  };
}
const writeSessionSoon = () => session.save(sessionData);
/** 종료가 취소됐거나 새 창을 열 때: 이미 닫힌 창은 세션에서 뺀다 */
function pruneClosedWindows() {
  for (let i = sessionWins.length - 1; i >= 0; i--) if (sessionWins[i].closed) sessionWins.splice(i, 1);
  writeSessionSoon();
}
function captureBounds(w) {
  if (!w.win.isDestroyed()) w.bounds = w.win.getNormalBounds();
}
const withTimeout = (promise, ms) => Promise.race([promise, new Promise((r) => setTimeout(() => r(null), ms))]);

/**
 * 창을 닫은 뒤의 세션 정리: 저장한 탭은 "저장됨"으로, "저장 안 함"을 고른 탭은 내용을 버린다
 * (제목 없는 탭이면 아예 뺀다). 그래야 다시 켰을 때 버린 내용이 되살아나지 않는다.
 */
function finalizeSnapshot(w, discarded) {
  if (!w.snapshot) return;
  w.snapshot.tabs = w.snapshot.tabs
    .filter((t) => !(discarded.has(t.tabId) && !w.tabs.get(t.tabId)?.filePath))
    .map((t) => {
      const tab = w.tabs.get(t.tabId);
      if (!tab || (!discarded.has(t.tabId) && tab.dirty)) return t;
      return { ...t, filePath: tab.filePath, name: tabName(tab), dirty: false, content: tab.filePath ? null : t.content, saved: tab.filePath ? undefined : t.content };
    });
}

const winOf = (sender) => windows.get(sender.id);
const tabOf = (sender, tabId) => winOf(sender)?.tabs.get(tabId);
function targetWindow() {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused) return windows.get(focused.webContents.id) || null;
  if (lastFocused && !lastFocused.win.isDestroyed()) return lastFocused;
  return [...windows.values()].pop() || null;
}

function newTab(w) {
  const tab = { id: ++tabSeq, w, filePath: null, dirty: false, diskContent: null, blank: true, unwatch: null };
  w.tabs.set(tab.id, tab);
  return tab;
}
/** 아무것도 입력하지 않은 빈 탭이면 재사용 */
function reusableTab(w) {
  const t = w.tabs.get(w.activeTab);
  return t && t.blank && !t.filePath && !t.dirty ? t : null;
}

/** @param {Array<{filePath?:string, content?:string, name?:string}>} queue 창이 준비되면 열 문서들 */
/** @param {{restore?:Array, active?:number, bounds?:object}|null} restore 세션 복원용 탭과 창 위치 */
function createWindow(queue = [], position = null, restore = null) {
  const focused = BrowserWindow.getFocusedWindow();
  const { width, height } = settings.windowBounds;
  const bounds = restore?.bounds && onScreen(restore.bounds) ? restore.bounds : null;
  const win = new BrowserWindow({
    width: bounds?.width ?? width,
    height: bounds?.height ?? height,
    ...(bounds ? { x: bounds.x, y: bounds.y } : {}),
    minWidth: 760,
    minHeight: 480,
    show: false,
    title: 'MD Editor',
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 14, y: 14 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1c1f' : '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  if (bounds) {
    /* 세션에 기록된 위치 그대로 */
  } else if (position) {
    // 탭을 창 밖으로 끌어 놓은 위치에 새 창을 띄운다(커서가 탭 바 근처에 오도록)
    win.setPosition(Math.round(position.x - 160), Math.round(position.y - 60));
  } else if (focused) {
    const [x, y] = focused.getPosition();
    win.setPosition(x + 28, y + 28);
  }

  /** @type {WinState} */
  const w = { win, tabs: new Map(), activeTab: null, ready: false, queue, forceClose: false, restore, snapshot: null, bounds: null, closed: false };
  const id = win.webContents.id;
  windows.set(id, w);
  pruneClosedWindows();
  sessionWins.push(w);

  win.loadFile(path.join(__dirname, '..', '..', 'dist', 'index.html'));
  // 테스트 실행(MD_EDITOR_USER_DATA) 때는 사용자가 쓰던 앱의 포커스를 빼앗지 않는다
  win.once('ready-to-show', () => (process.env.MD_EDITOR_USER_DATA ? win.showInactive() : win.show()));
  win.on('focus', () => (lastFocused = w));

  // 미리보기 안의 링크가 앱 창을 이동시키지 못하도록 막고, 외부 링크는 브라우저로 연다.
  win.webContents.on('will-navigate', (e, url) => {
    e.preventDefault();
    openLink(url);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    openLink(url);
    return { action: 'deny' };
  });

  win.on('resize', () => {
    if (!win.isMaximized() && !win.isFullScreen()) {
      const [width, height] = win.getSize();
      settings.windowBounds = { width, height };
      saveSettings();
    }
  });

  // 창을 닫을 때: 저장 안 된 탭마다 차례로 확인
  win.on('close', async (e) => {
    if (w.forceClose) return;
    e.preventDefault();
    // 닫기 직전의 탭 상태를 세션에 남긴다 (렌더러가 응답하지 않아도 닫기는 막지 않음)
    const snap = await withTimeout(win.webContents.executeJavaScript('window.__mdEditor.snapshot()').catch(() => null), 1000);
    if (snap) w.snapshot = snap;
    captureBounds(w);
    const dirtyTabs = [...w.tabs.values()].filter((t) => t.dirty);
    const discarded = new Set();
    for (const t of dirtyTabs) {
      await win.webContents.executeJavaScript(`window.__mdEditor.activate(${t.id})`).catch(() => {});
      const answer = await confirmClose(win, tabName(t));
      if (answer === 'cancel') {
        quitting = false;
        updater.quitCancelled();
        pruneClosedWindows();
        return;
      }
      if (answer === 'discard') discarded.add(t.id);
      if (answer === 'save') {
        const saved = await win.webContents.executeJavaScript(`window.__mdEditor.save(${t.id})`).catch(() => false);
        if (!saved) {
          quitting = false;
          updater.quitCancelled();
          pruneClosedWindows();
          return;
        }
      }
    }
    finalizeSnapshot(w, discarded);
    w.forceClose = true;
    win.close();
    if (quitting) app.quit();
  });

  win.on('closed', () => {
    for (const t of w.tabs.values()) unwatch(t);
    windows.delete(id);
    if (lastFocused === w) lastFocused = null;
    // 다른 창이 남아 있는데 이 창만 닫았다면 세션에서 뺀다.
    // 종료 중이거나 마지막 창이면 남겨 두어 다음 실행 때 다시 연다.
    w.closed = true;
    const at = sessionWins.indexOf(w);
    if (!quitting && windows.size > 0 && at >= 0) sessionWins.splice(at, 1);
    writeSessionSoon();
  });

  return w;
}

const tabName = (t) => (t.filePath ? path.basename(t.filePath) : t.name || '제목 없음');

async function confirmClose(win, name) {
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['저장', '저장 안 함', '취소'],
    defaultId: 0,
    cancelId: 2,
    message: `"${name}" 문서의 변경 사항을 저장하시겠습니까?`,
    detail: '저장하지 않으면 변경 사항이 사라집니다.',
  });
  return ['save', 'discard', 'cancel'][response];
}

function updateTitle(w) {
  const { win } = w;
  if (win.isDestroyed()) return;
  const t = w.tabs.get(w.activeTab);
  win.setTitle(t ? tabName(t) : 'MD Editor');
  if (isMac) {
    win.setRepresentedFilename(t?.filePath || '');
    win.setDocumentEdited([...w.tabs.values()].some((x) => x.dirty));
  }
}

// ───────────────────────── 파일 열기 / 저장 ─────────────────────────
async function readDoc(filePath) {
  const content = await fsp.readFile(filePath, 'utf8');
  return {
    content,
    filePath,
    name: path.basename(filePath),
    dirUrl: pathToFileURL(path.dirname(filePath) + path.sep).href,
  };
}

/** 이미 열린 파일이면 그 탭으로 이동, 아니면 대상 창에 새 탭(빈 탭이면 재사용) */
/** @param {{line:number, query:string}|null} reveal 열고 나서 이 줄의 검색어를 선택(최근 문서 검색 결과용) */
async function openPath(filePath, w = targetWindow(), reveal = null) {
  filePath = path.resolve(filePath);
  for (const other of windows.values()) {
    for (const t of other.tabs.values()) {
      if (t.filePath === filePath) {
        other.win.show();
        other.win.focus();
        other.win.webContents.send('tab:activate', t.id);
        if (reveal) other.win.webContents.send('tab:reveal', { tabId: t.id, ...reveal });
        return;
      }
    }
  }
  if (!w || w.win.isDestroyed()) return void createWindow([{ filePath }]);
  if (!w.ready) return void w.queue.push({ filePath });
  if (!process.env.MD_EDITOR_USER_DATA) {
    w.win.show();
    w.win.focus();
  }
  const reused = reusableTab(w);
  const tab = reused ?? newTab(w);
  // 새로 만든 탭인데 열기에 실패하면 렌더러는 그 탭을 모르므로 main에서만 지운다
  const loaded = await loadInto(tab, filePath);
  if (!loaded && !reused) w.tabs.delete(tab.id);
  if (loaded && reveal) w.win.webContents.send('tab:reveal', { tabId: tab.id, ...reveal });
}

async function loadInto(tab, filePath) {
  try {
    const doc = await readDoc(filePath);
    Object.assign(tab, { filePath, diskContent: doc.content, dirty: false, blank: false });
    tab.w.win.webContents.send('doc:load', { tabId: tab.id, ...doc });
    watch(tab);
    addRecent(filePath);
    updateTitle(tab.w);
    return true;
  } catch (err) {
    dialog.showErrorBox('파일을 열 수 없습니다', `${filePath}\n\n${err.message}`);
    removeRecent(filePath);
    return false;
  }
}

/** 파일이 아닌 내용(예: 문법 예제)을 새 탭으로 */
function openContent(w, content, name) {
  if (!w || w.win.isDestroyed()) return void createWindow([{ content, name }]);
  if (!w.ready) return void w.queue.push({ content, name });
  const tab = reusableTab(w) ?? newTab(w);
  Object.assign(tab, { blank: false, name });
  w.win.webContents.send('doc:load', { tabId: tab.id, content, filePath: null, name, dirUrl: null });
}

async function showOpenDialog(w) {
  const { canceled, filePaths } = await dialog.showOpenDialog(w?.win, {
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Markdown', extensions: MD_EXTENSIONS },
      { name: '모든 파일', extensions: ['*'] },
    ],
  });
  if (canceled) return;
  for (const p of filePaths) await openPath(p, w);
}

async function writeDoc(tab, content, saveAs) {
  let target = tab.filePath;
  if (!target || saveAs) {
    const { canceled, filePath } = await dialog.showSaveDialog(tab.w.win, {
      defaultPath: target || path.join(app.getPath('documents'), `${(tab.name || '제목 없음').replace(/\.md$/, '')}.md`),
      filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
    });
    if (canceled || !filePath) return null;
    target = filePath;
  }
  await fsp.writeFile(target, content, 'utf8');
  const changedPath = target !== tab.filePath;
  Object.assign(tab, { filePath: target, diskContent: content, dirty: false, blank: false });
  if (changedPath) {
    watch(tab);
    addRecent(target);
  }
  updateTitle(tab.w);
  return { filePath: target, name: path.basename(target), dirUrl: pathToFileURL(path.dirname(target) + path.sep).href };
}

// ───────────────────────── 외부 변경 감지 ─────────────────────────
// fs.watchFile(폴링)은 에디터들의 "원자적 저장(rename)"에도 끊기지 않는다.
function watch(tab) {
  unwatch(tab);
  const file = tab.filePath;
  if (!file) return;
  const listener = async (curr, prev) => {
    const { win } = tab.w;
    // 내가 저장한 변경은 아래에서 내용 비교(diskContent)로 걸러진다. 시간으로 무시하면
    // 저장 직후 다른 프로그램이 바꾼 내용을 놓치므로 쓰지 않는다.
    if (curr.mtimeMs === prev.mtimeMs || win.isDestroyed()) return;
    if (curr.nlink === 0) {
      win.webContents.send('doc:external-deleted', { tabId: tab.id });
      return;
    }
    try {
      const content = await fsp.readFile(file, 'utf8');
      if (content === tab.diskContent) return;
      tab.diskContent = content;
      win.webContents.send('doc:external-change', { tabId: tab.id, content });
    } catch {
      /* 일시적인 쓰기 중 상태 */
    }
  };
  fs.watchFile(file, { interval: 800 }, listener);
  tab.unwatch = () => fs.unwatchFile(file, listener);
}
function unwatch(tab) {
  tab.unwatch?.();
  tab.unwatch = null;
}

// ───────────────────────── 링크 처리 ─────────────────────────
function openLink(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:') {
      shell.openExternal(url);
    } else if (u.protocol === 'file:') {
      const p = fileURLToPath(u);
      // 문서 속 링크로 실행 파일(.app, .command 등)이 바로 실행되지 않도록,
      // 마크다운이 아닌 파일은 열지 않고 Finder/탐색기에서 위치만 보여 준다.
      if (isMarkdownPath(p)) openPath(p);
      else shell.showItemInFolder(p);
    }
  } catch {
    /* 잘못된 URL 무시 */
  }
}

// ───────────────────────── IPC ─────────────────────────
ipcMain.handle('renderer-ready', (e) => {
  const w = winOf(e.sender);
  // 세션 복원: 기록된 탭들을 다시 만든다
  const restored = (w.restore?.tabs ?? []).map((item) => {
    const tab = newTab(w);
    Object.assign(tab, { filePath: item.filePath, name: item.name, dirty: item.dirty, diskContent: item.disk ?? null, blank: false });
    if (tab.filePath) watch(tab);
    return { ...item, disk: undefined, tabId: tab.id };
  });
  const activeIndex = Math.max(0, w.restore?.tabs.findIndex((t) => t.oldId === w.restore.active) ?? 0);
  w.restore = null;
  const first = restored.length ? null : newTab(w);
  w.activeTab = first ? first.id : restored[activeIndex].tabId;
  w.ready = true;
  // 응답이 먼저 도착하도록 다음 틱에 대기 중인 문서를 연다
  setImmediate(async () => {
    for (const item of w.queue.splice(0)) {
      if (item.moveTab) await moveTab(item.moveTab.from, item.moveTab.tabId, w, 0);
      else if (item.filePath) await openPath(item.filePath, w);
      else openContent(w, item.content, item.name);
    }
  });
  updateTitle(w);
  return {
    settings: { viewMode: settings.viewMode, sidebar: settings.sidebar, syncScroll: settings.syncScroll, autosave: settings.autosave, theme: settings.theme },
    tabId: first?.id ?? null,
    restore: restored.length ? { tabs: restored, active: w.activeTab } : null,
    version: app.getVersion(),
    update: updater.publicState(),
    updatedTo: updater.takeInstalledNotice(),
  };
});

// ───────────────────────── 업데이트 IPC ─────────────────────────
ipcMain.on('update:download', () => updater.download());
ipcMain.on('update:install-now', () => updater.installNow());
ipcMain.on('update:install-later', () => updater.installLater());
ipcMain.on('update:dismiss', () => updater.dismiss());
ipcMain.on('update:open-page', () => updater.openReleasePage());

ipcMain.handle('tab:new', (e) => {
  const w = winOf(e.sender);
  const tab = newTab(w);
  return tab.id;
});
ipcMain.on('tab:activated', (e, tabId) => {
  const w = winOf(e.sender);
  if (!w?.tabs.has(tabId)) return;
  w.activeTab = tabId;
  updateTitle(w);
});
ipcMain.on('tab:closed', (e, tabId) => {
  const w = winOf(e.sender);
  const tab = w?.tabs.get(tabId);
  if (!tab) return;
  unwatch(tab);
  w.tabs.delete(tabId);
  updateTitle(w);
});
ipcMain.on('window:close', (e) => winOf(e.sender)?.win.close());
ipcMain.on('session:update', (e, snap) => {
  const w = winOf(e.sender);
  if (!w || w.forceClose || !snap || !Array.isArray(snap.tabs)) return;
  w.snapshot = snap;
  captureBounds(w);
  writeSessionSoon();
});
// ───────────────────────── 탭을 다른 창으로 옮기기 ─────────────────────────
let tabDrag = null; // { w, tabId } — 탭 끌기가 진행 중일 때

/** 탭 상태(문서·실행 취소 기록·저장 여부·파일 감시)를 다른 창으로 옮긴다 */
async function moveTab(fromW, tabId, toW, index = null) {
  const tab = fromW?.tabs.get(tabId);
  if (!tab || fromW === toW || toW.win.isDestroyed() || fromW.win.isDestroyed()) return false;
  const data = await fromW.win.webContents.executeJavaScript(`window.__mdEditor.exportTab(${tabId})`).catch(() => null);
  if (!data) return false;
  fromW.tabs.delete(tabId);
  await fromW.win.webContents.executeJavaScript(`window.__mdEditor.removeTab(${tabId})`).catch(() => {});
  tab.w = toW; // 파일 감시 콜백은 tab.w를 매번 읽으므로 그대로 새 창으로 이어진다
  tab.blank = false;
  toW.tabs.set(tabId, tab);
  toW.activeTab = tabId;
  toW.win.webContents.send('tab:import', { data, index });
  toW.win.show();
  toW.win.focus();
  if (fromW.tabs.size === 0) {
    fromW.forceClose = true; // 남은 탭이 없으면 원래 창은 닫는다
    fromW.win.close();
  } else updateTitle(fromW);
  updateTitle(toW);
  return true;
}

/** 탭을 새 창으로 분리 (탭이 하나뿐인 창이면 의미가 없으므로 하지 않음) */
function detachTab(fromW, tabId, position = null) {
  if (!fromW?.tabs.has(tabId) || fromW.tabs.size < 2) return false;
  createWindow([{ moveTab: { from: fromW, tabId } }], position);
  return true;
}

const windowAt = (pt) =>
  [...windows.values()].find((w) => {
    if (w.win.isDestroyed() || !w.win.isVisible()) return false;
    const b = w.win.getBounds();
    return pt.x >= b.x && pt.x <= b.x + b.width && pt.y >= b.y && pt.y <= b.y + b.height;
  });

ipcMain.on('tab:drag-start', (e, tabId) => {
  tabDrag = { w: winOf(e.sender), tabId };
});
ipcMain.handle('tab:drag-active', (e) => Boolean(tabDrag && tabDrag.w !== winOf(e.sender)));
ipcMain.on('tab:drop-here', (e, index) => {
  const to = winOf(e.sender);
  if (!tabDrag || tabDrag.w === to) return;
  const { w, tabId } = tabDrag;
  tabDrag = null;
  moveTab(w, tabId, to, index);
});
ipcMain.on('tab:drag-end', (e, tabId) => {
  // 다른 창의 drop이 먼저 처리되도록 잠깐 기다린 뒤, 아무 창에도 놓이지 않았으면 새 창으로 분리
  setTimeout(() => {
    if (!tabDrag || tabDrag.tabId !== tabId) return;
    const from = tabDrag.w;
    tabDrag = null;
    const pt = screen.getCursorScreenPoint();
    if (!windowAt(pt)) detachTab(from, tabId, pt);
  }, 150);
});
ipcMain.handle('tab:detach', (e, tabId) => detachTab(winOf(e.sender), tabId));

ipcMain.handle('tab:confirm-close', (e, name) => confirmClose(winOf(e.sender).win, name));

ipcMain.handle('doc:save', async (e, { tabId, content, saveAs }) => {
  const tab = tabOf(e.sender, tabId);
  if (!tab) return null;
  try {
    return await writeDoc(tab, content, saveAs);
  } catch (err) {
    dialog.showErrorBox('저장 실패', err.message);
    return null;
  }
});

ipcMain.on('doc:dirty', (e, tabId, dirty) => {
  const tab = tabOf(e.sender, tabId);
  if (!tab) return;
  tab.dirty = dirty;
  if (dirty) tab.blank = false;
  updateTitle(tab.w);
});

ipcMain.handle('doc:confirm-reload', async (e, name) => {
  const { response } = await dialog.showMessageBox(winOf(e.sender).win, {
    type: 'question',
    buttons: ['디스크 버전 불러오기', '내 편집 유지'],
    defaultId: 1,
    cancelId: 1,
    message: `다른 프로그램에서 "${name}" 파일이 변경되었습니다.`,
    detail: '현재 저장하지 않은 편집 내용이 있습니다. 디스크의 버전으로 바꾸면 편집 내용이 사라집니다.',
  });
  return response === 0;
});

ipcMain.handle('doc:open-dialog', (e) => showOpenDialog(winOf(e.sender)));
// 렌더러가 임의 경로를 열지 못하도록: 사용자가 직접 끌어다 놓은 마크다운 파일만 허용
ipcMain.handle('doc:open-dropped', (e, p) => {
  if (!isMarkdownPath(p) || !path.isAbsolute(p)) return false;
  openPath(p, winOf(e.sender));
  return true;
});

// 최근 문서 — 폴더 탐색 없이, 사용자가 이미 연 적 있는 파일만 노출
const home = app.getPath('home');
ipcMain.handle('recent:list', () =>
  settings.recentFiles.map((f) => {
    const dir = path.dirname(f);
    return {
      path: f,
      name: path.basename(f),
      dir: dir.startsWith(home) ? '~' + dir.slice(home.length) : dir,
      exists: fs.existsSync(f),
    };
  }),
);
ipcMain.handle('recent:open', (e, p, reveal = null) => {
  if (!settings.recentFiles.includes(p)) return false;
  const r = reveal && Number.isInteger(reveal.line) ? { line: reveal.line, query: String(reveal.query || '').slice(0, 200) } : null;
  openPath(p, winOf(e.sender), r);
  return true;
});

// 최근 문서 내용 검색 — 최근 문서 목록에 있는 파일만 읽는다(폴더 탐색 없음)
const SEARCH_MAX_BYTES = 2 * 1024 * 1024;
const SEARCH_MAX_LINES_PER_FILE = 20;
ipcMain.handle('recent:search', async (_e, rawQuery) => {
  const query = String(rawQuery || '').normalize('NFC').trim().slice(0, 200);
  if (!query) return [];
  const re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
  const results = [];
  for (const file of settings.recentFiles) {
    try {
      if (!isMarkdownPath(file)) continue;
      const stat = await fsp.stat(file);
      if (!stat.isFile() || stat.size > SEARCH_MAX_BYTES) continue;
      const lines = (await fsp.readFile(file, 'utf8')).normalize('NFC').split(/\r?\n/);
      const matches = [];
      let total = 0;
      lines.forEach((text, i) => {
        re.lastIndex = 0;
        const m = re.exec(text);
        if (!m) return;
        total++;
        if (matches.length < SEARCH_MAX_LINES_PER_FILE) matches.push({ line: i, text: text.slice(0, 500), start: m.index, length: m[0].length });
      });
      // 파일 이름이 일치해도 결과에 넣는다
      const nameHit = path.basename(file).normalize('NFC').toLocaleLowerCase().includes(query.toLocaleLowerCase());
      if (total || nameHit) {
        const dir = path.dirname(file);
        results.push({ path: file, name: path.basename(file), dir: dir.startsWith(home) ? '~' + dir.slice(home.length) : dir, total, matches });
      }
    } catch {
      /* 없는 파일·읽기 실패는 건너뜀 */
    }
  }
  return results;
});
ipcMain.handle('recent:remove', (_e, p) => removeRecent(p));
ipcMain.handle('recent:clear', () => {
  settings.recentFiles = [];
  recentChanged();
});

// 붙여넣기/드롭한 이미지를 문서 옆 assets/ 폴더에 저장하고 상대 경로를 돌려준다.
ipcMain.handle('fs:save-image', async (e, { tabId, data, ext, sourcePath }) => {
  const tab = tabOf(e.sender, tabId);
  if (!tab?.filePath || !IMAGE_EXTENSIONS.includes(String(ext).toLowerCase())) return null;
  const docDir = path.dirname(tab.filePath);
  const assetsDir = path.join(docDir, 'assets');
  await fsp.mkdir(assetsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const base = sourcePath ? path.basename(sourcePath, path.extname(sourcePath)).replace(/\s+/g, '-') : `image-${stamp}`;
  let name = `${base}.${ext}`;
  for (let i = 1; fs.existsSync(path.join(assetsDir, name)); i++) name = `${base}-${i}.${ext}`;
  const target = path.join(assetsDir, name);
  if (sourcePath) {
    if (!IMAGE_EXTENSIONS.includes(path.extname(sourcePath).slice(1).toLowerCase())) return null;
    await fsp.copyFile(sourcePath, target);
  } else await fsp.writeFile(target, Buffer.from(data));
  return path.relative(docDir, target).split(path.sep).join('/');
});

function exportTarget(tab, ext) {
  const base = tab?.filePath ? path.basename(tab.filePath, path.extname(tab.filePath)) : (tab?.name || '제목 없음').replace(/\.md$/, '');
  return path.join(tab?.filePath ? path.dirname(tab.filePath) : app.getPath('documents'), `${base}.${ext}`);
}

ipcMain.handle('export:pdf', async (e, tabId) => {
  const w = winOf(e.sender);
  const { canceled, filePath } = await dialog.showSaveDialog(w.win, {
    defaultPath: exportTarget(w.tabs.get(tabId), 'pdf'),
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (canceled || !filePath) return null;
  const pdf = await w.win.webContents.printToPDF({
    pageSize: 'A4',
    printBackground: true,
    margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 },
  });
  await fsp.writeFile(filePath, pdf);
  return filePath;
});

ipcMain.handle('export:html', async (e, tabId, html) => {
  const w = winOf(e.sender);
  const { canceled, filePath } = await dialog.showSaveDialog(w.win, {
    defaultPath: exportTarget(w.tabs.get(tabId), 'html'),
    filters: [{ name: 'HTML', extensions: ['html'] }],
  });
  if (canceled || !filePath) return null;
  await fsp.writeFile(filePath, html, 'utf8');
  return filePath;
});

ipcMain.on('reveal', (e, tabId) => {
  const tab = tabOf(e.sender, tabId);
  if (tab?.filePath) shell.showItemInFolder(tab.filePath);
});

ipcMain.on('settings:set', (_e, patch) => setSetting(patch));

// ───────────────────────── 메뉴 ─────────────────────────
function send(cmd, arg) {
  const win = BrowserWindow.getFocusedWindow();
  if (win) win.webContents.send('menu', cmd, arg);
  else if (cmd === 'newTab') createWindow();
}
function setSetting(patch) {
  Object.assign(settings, patch);
  if ('theme' in patch) nativeTheme.themeSource = settings.theme;
  saveSettings();
  for (const w of windows.values()) if (!w.win.isDestroyed()) w.win.webContents.send('settings:changed', patch);
  buildMenu();
}

function buildMenu() {
  const recent = settings.recentFiles.length
    ? [
        ...settings.recentFiles.map((f) => ({ label: path.basename(f), sublabel: path.dirname(f), click: () => openPath(f) })),
        { type: 'separator' },
        { label: '최근 문서 지우기', click: () => { settings.recentFiles = []; recentChanged(); } },
      ]
    : [{ label: '최근 문서 없음', enabled: false }];

  const template = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about', label: 'MD Editor 정보' },
              { label: '업데이트 확인…', click: () => updater.check({ manual: true }) },
              {
                label: '자동으로 업데이트 확인',
                type: 'checkbox',
                checked: settings.autoUpdateCheck !== false,
                click: (item) => setSetting({ autoUpdateCheck: item.checked }),
              },
              { type: 'separator' },
              { role: 'services', label: '서비스' },
              { type: 'separator' },
              { role: 'hide', label: 'MD Editor 가리기' },
              { role: 'hideOthers', label: '기타 가리기' },
              { role: 'unhide', label: '모두 보기' },
              { type: 'separator' },
              { role: 'quit', label: 'MD Editor 종료' },
            ],
          },
        ]
      : []),
    {
      label: '파일',
      submenu: [
        { label: '새 탭', accelerator: 'CmdOrCtrl+N', click: () => send('newTab') },
        { label: '새 창', accelerator: 'CmdOrCtrl+Shift+N', click: () => createWindow() },
        { label: '열기…', accelerator: 'CmdOrCtrl+O', click: () => showOpenDialog(targetWindow()) },
        { label: '최근 문서', submenu: recent },
        { type: 'separator' },
        { label: '저장', accelerator: 'CmdOrCtrl+S', click: () => send('save') },
        { label: '다른 이름으로 저장…', accelerator: 'CmdOrCtrl+Shift+S', click: () => send('saveAs') },
        { label: '자동 저장', type: 'checkbox', checked: settings.autosave, click: (item) => setSetting({ autosave: item.checked }) },
        {
          label: '시작할 때 이전 탭 다시 열기',
          type: 'checkbox',
          checked: settings.restoreSession !== false,
          click: (item) => setSetting({ restoreSession: item.checked }),
        },
        { type: 'separator' },
        { label: 'PDF로 내보내기…', accelerator: 'CmdOrCtrl+P', click: () => send('exportPdf') },
        { label: 'HTML로 내보내기…', accelerator: 'CmdOrCtrl+Shift+E', click: () => send('exportHtml') },
        { type: 'separator' },
        { label: isMac ? 'Finder에서 보기' : '탐색기에서 보기', accelerator: 'CmdOrCtrl+Shift+R', click: () => send('reveal') },
        { type: 'separator' },
        { label: '탭 닫기', accelerator: 'CmdOrCtrl+W', click: () => send('closeTab') },
        { label: '창 닫기', accelerator: 'CmdOrCtrl+Shift+W', click: () => BrowserWindow.getFocusedWindow()?.close() },
        ...(isMac ? [] : [{ type: 'separator' }, { role: 'quit', label: '종료' }]),
      ],
    },
    {
      label: '편집',
      submenu: [
        { label: '실행 취소', accelerator: 'CmdOrCtrl+Z', click: () => send('undo') },
        { label: '실행 복귀', accelerator: 'CmdOrCtrl+Shift+Z', click: () => send('redo') },
        { type: 'separator' },
        { role: 'cut', label: '오려두기' },
        { role: 'copy', label: '복사하기' },
        { role: 'paste', label: '붙여넣기' },
        { label: '서식 없이 붙여넣기', accelerator: 'CmdOrCtrl+Shift+V', click: () => send('pastePlain', clipboard.readText()) },
        { label: '전체 선택', accelerator: 'CmdOrCtrl+A', click: () => send('selectAll') },
        { type: 'separator' },
        { label: '찾기 / 바꾸기', accelerator: 'CmdOrCtrl+F', click: () => send('find') },
        { label: '최근 문서에서 찾기', accelerator: 'CmdOrCtrl+Shift+F', click: () => send('searchRecent') },
      ],
    },
    {
      label: '서식',
      submenu: [
        { label: '굵게', accelerator: 'CmdOrCtrl+B', click: () => send('format', 'bold') },
        { label: '기울임', accelerator: 'CmdOrCtrl+I', click: () => send('format', 'italic') },
        { label: '취소선', accelerator: 'CmdOrCtrl+Shift+X', click: () => send('format', 'strike') },
        { label: '인라인 코드', accelerator: 'CmdOrCtrl+E', click: () => send('format', 'code') },
        { label: '링크', accelerator: 'CmdOrCtrl+K', click: () => send('format', 'link') },
        { type: 'separator' },
        { label: '제목 1', accelerator: 'CmdOrCtrl+Alt+1', click: () => send('format', 'h1') },
        { label: '제목 2', accelerator: 'CmdOrCtrl+Alt+2', click: () => send('format', 'h2') },
        { label: '제목 3', accelerator: 'CmdOrCtrl+Alt+3', click: () => send('format', 'h3') },
        { label: '본문', accelerator: 'CmdOrCtrl+Alt+0', click: () => send('format', 'p') },
        { type: 'separator' },
        { label: '인용', accelerator: 'CmdOrCtrl+Shift+.', click: () => send('format', 'quote') },
        { label: '글머리 목록', accelerator: 'CmdOrCtrl+Shift+8', click: () => send('format', 'ul') },
        { label: '번호 목록', accelerator: 'CmdOrCtrl+Shift+7', click: () => send('format', 'ol') },
        { label: '체크리스트', accelerator: 'CmdOrCtrl+Shift+9', click: () => send('format', 'task') },
        { type: 'separator' },
        { label: '코드 블록', accelerator: 'CmdOrCtrl+Alt+C', click: () => send('format', 'codeblock') },
        { label: '표 삽입', accelerator: 'CmdOrCtrl+Alt+T', click: () => send('format', 'table') },
        { label: '이미지', click: () => send('format', 'image') },
        { label: '구분선', click: () => send('format', 'hr') },
      ],
    },
    {
      label: '보기',
      submenu: [
        { label: '편집기만', type: 'radio', checked: settings.viewMode === 'edit', accelerator: 'CmdOrCtrl+1', click: () => setSetting({ viewMode: 'edit' }) },
        { label: '분할 보기', type: 'radio', checked: settings.viewMode === 'split', accelerator: 'CmdOrCtrl+2', click: () => setSetting({ viewMode: 'split' }) },
        { label: '미리보기만', type: 'radio', checked: settings.viewMode === 'preview', accelerator: 'CmdOrCtrl+3', click: () => setSetting({ viewMode: 'preview' }) },
        { type: 'separator' },
        { label: '사이드바', type: 'checkbox', checked: settings.sidebar, accelerator: 'CmdOrCtrl+\\', click: (i) => setSetting({ sidebar: i.checked }) },
        { label: '스크롤 동기화', type: 'checkbox', checked: settings.syncScroll, click: (i) => setSetting({ syncScroll: i.checked }) },
        {
          label: '테마',
          submenu: [
            { label: '시스템 설정 따르기', type: 'radio', checked: settings.theme === 'system', click: () => setSetting({ theme: 'system' }) },
            { label: '라이트', type: 'radio', checked: settings.theme === 'light', click: () => setSetting({ theme: 'light' }) },
            { label: '다크', type: 'radio', checked: settings.theme === 'dark', click: () => setSetting({ theme: 'dark' }) },
          ],
        },
        { type: 'separator' },
        { role: 'zoomIn', label: '확대', accelerator: 'CmdOrCtrl+=' },
        { role: 'zoomOut', label: '축소' },
        { role: 'resetZoom', label: '실제 크기' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '전체 화면' },
        { role: 'toggleDevTools', label: '개발자 도구' },
      ],
    },
    {
      role: 'window',
      label: '윈도우',
      submenu: [
        { role: 'minimize', label: '최소화' },
        { role: 'zoom', label: '확대/축소' },
        { type: 'separator' },
        { label: '탭을 새 창으로 이동', click: () => send('detachTab') },
        { type: 'separator' },
        { label: '다음 탭', accelerator: 'Ctrl+Tab', click: () => send('nextTab') },
        { label: '이전 탭', accelerator: 'Ctrl+Shift+Tab', click: () => send('prevTab') },
        { label: '다음 탭', accelerator: 'CmdOrCtrl+Shift+]', visible: false, acceleratorWorksWhenHidden: true, click: () => send('nextTab') },
        { label: '이전 탭', accelerator: 'CmdOrCtrl+Shift+[', visible: false, acceleratorWorksWhenHidden: true, click: () => send('prevTab') },
        ...(isMac ? [{ type: 'separator' }, { role: 'front', label: '모두 앞으로 가져오기' }] : []),
      ],
    },
    {
      role: 'help',
      label: '도움말',
      submenu: [
        {
          label: '마크다운 문법 예제 열기',
          click: () => openContent(targetWindow(), toPlatformShortcuts(fs.readFileSync(path.join(__dirname, '..', '..', 'dist', 'sample.md'), 'utf8')), '마크다운 문법 예제'),
        },
        // Windows에는 앱 이름 메뉴가 없으므로 업데이트·정보 항목을 도움말에 둔다
        ...(isMac
          ? []
          : [
              { type: 'separator' },
              { label: '업데이트 확인…', click: () => updater.check({ manual: true }) },
              {
                label: '자동으로 업데이트 확인',
                type: 'checkbox',
                checked: settings.autoUpdateCheck !== false,
                click: (item) => setSetting({ autoUpdateCheck: item.checked }),
              },
              { type: 'separator' },
              {
                label: 'MD Editor 정보',
                click: () =>
                  dialog.showMessageBox(BrowserWindow.getFocusedWindow(), {
                    type: 'info',
                    title: 'MD Editor 정보',
                    message: `MD Editor ${app.getVersion()}`,
                    detail: '마크다운 편집기\nhttps://github.com/ReentaKim/md-editor',
                  }),
              },
            ]),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ───────────────────────── 세션 복원 ─────────────────────────
/** 창 위치가 지금 연결된 화면 안에 있는지 (모니터를 뺀 경우 대비) */
function onScreen(b) {
  if (![b?.x, b?.y, b?.width, b?.height].every(Number.isFinite)) return false;
  return screen.getAllDisplays().some(({ workArea: a }) => b.x + 80 > a.x && b.x + 80 < a.x + a.width && b.y + 20 >= a.y && b.y + 20 < a.y + a.height);
}

/**
 * 기록된 탭을 복원할 수 있는 형태로 준비한다.
 * - 파일 탭: 디스크에서 다시 읽는다. 저장 안 된 내용이 있었다면 그 내용을 편집기에 싣는다.
 * - 파일이 사라졌는데 저장 안 된 내용이 있으면 제목 없는 탭으로 살린다. 내용이 없으면 건너뛴다.
 * - all=false(설정 꺼짐)면 저장 안 된 내용이 있는 탭만 복원한다.
 */
async function prepareTabs(tabs, all) {
  const out = [];
  for (const t of tabs ?? []) {
    const hasContent = typeof t.content === 'string';
    const base = { oldId: t.tabId, selection: t.selection, editorScroll: t.editorScroll || 0, previewScroll: t.previewScroll || 0 };
    if (t.filePath) {
      if (!all && !(hasContent && t.dirty)) continue;
      let disk = null;
      try {
        disk = await fsp.readFile(t.filePath, 'utf8');
      } catch {
        /* 파일이 사라졌거나 읽을 수 없음 */
      }
      if (disk != null) {
        const content = hasContent ? t.content : disk;
        out.push({
          ...base,
          filePath: t.filePath,
          name: path.basename(t.filePath),
          dirUrl: pathToFileURL(path.dirname(t.filePath) + path.sep).href,
          content,
          savedContent: disk,
          disk,
          dirty: content !== disk,
        });
      } else if (hasContent && t.content !== '') {
        out.push({ ...base, filePath: null, name: path.basename(t.filePath), dirUrl: null, content: t.content, savedContent: '', dirty: true });
      }
    } else if (hasContent && t.content !== '') {
      const saved = typeof t.saved === 'string' ? t.saved : '';
      const dirty = t.content !== saved;
      if (!all && !dirty) continue;
      out.push({ ...base, filePath: null, name: t.name || '제목 없음', dirUrl: null, content: t.content, savedContent: saved, dirty });
    }
  }
  return out;
}

/** 시작할 때: 이전 세션의 창·탭을 다시 열고, 함께 열 파일(Finder·명령줄)은 첫 창에 연다 */
async function restoreSession(initial) {
  const all = settings.restoreSession !== false;
  const saved = session.load();
  const plans = [];
  for (const sw of saved?.windows ?? []) {
    const tabs = await prepareTabs(sw.tabs, all);
    if (tabs.length) plans.push({ tabs, active: sw.active, bounds: all ? sw.bounds : null });
  }
  if (!plans.length) return void createWindow(initial);
  plans.forEach((plan, i) => createWindow(i === 0 ? initial : [], null, plan));
}

// ───────────────────────── 앱 생명주기 ─────────────────────────
// open-file은 ready 이전에 올 수 있으므로 최상위에서 등록한다.
app.on('open-file', (e, filePath) => {
  e.preventDefault();
  if (app.isReady()) openPath(filePath);
  else pendingOpenPaths.push(filePath);
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const files = argv.slice(1).filter((a) => MD_EXTENSIONS.includes(path.extname(a).slice(1).toLowerCase()));
    if (files.length) files.forEach((f) => openPath(f));
    else BrowserWindow.getAllWindows()[0]?.focus();
  });

  app.whenReady().then(() => {
    loadSettings();
    nativeTheme.themeSource = settings.theme;
    buildMenu();
    updater.init({ settings });
    const argvFiles = process.argv.slice(app.isPackaged ? 1 : 2).filter((a) => fs.existsSync(a) && MD_EXTENSIONS.includes(path.extname(a).slice(1).toLowerCase()));
    const initial = [...pendingOpenPaths, ...argvFiles].map((f) => ({ filePath: path.resolve(f) }));
    restoreSession(initial).catch((err) => {
      console.error('세션 복원 실패', err);
      if (!windows.size) createWindow(initial);
    });
  });
}

app.on('before-quit', () => {
  quitting = true;
});
app.on('will-quit', () => session.flush());
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
app.on('window-all-closed', () => {
  if (!isMac) app.quit();
});
