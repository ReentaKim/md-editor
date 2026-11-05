// MD Editor — main process
// 문서 1개 = 창 1개. 각 창의 파일 경로/변경 여부/파일 감시 상태를 docs 맵에서 관리한다.
const { app, BrowserWindow, Menu, dialog, ipcMain, shell, nativeTheme } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = fs.promises;
const { pathToFileURL, fileURLToPath } = require('node:url');

const MD_EXTENSIONS = ['md', 'markdown', 'mdown', 'mkd', 'mdx', 'txt'];
const isMac = process.platform === 'darwin';
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
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('recent:changed');
}
const isMarkdownPath = (p) => typeof p === 'string' && MD_EXTENSIONS.includes(path.extname(p).slice(1).toLowerCase());
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'];

// ───────────────────────── 창 / 문서 상태 ─────────────────────────
/** @type {Map<number, {win: BrowserWindow, filePath: string|null, dirty: boolean, diskContent: string|null, ignoreUntil: number, forceClose: boolean, pending: string|null}>} */
const docs = new Map();
let quitting = false;
const pendingOpenPaths = []; // 앱 준비 전 Finder "다음으로 열기"로 들어온 파일

const stateOf = (webContents) => docs.get(webContents.id);
const focusedState = () => {
  const win = BrowserWindow.getFocusedWindow();
  return win ? docs.get(win.webContents.id) : null;
};

function createWindow(filePath = null, initialContent = null) {
  const focused = BrowserWindow.getFocusedWindow();
  const { width, height } = settings.windowBounds;
  const win = new BrowserWindow({
    width,
    height,
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
  if (focused) {
    const [x, y] = focused.getPosition();
    win.setPosition(x + 28, y + 28);
  }

  const state = { win, filePath: null, dirty: false, diskContent: null, ignoreUntil: 0, forceClose: false, pending: filePath, pendingContent: initialContent };
  const id = win.webContents.id;
  docs.set(id, state);

  win.loadFile(path.join(__dirname, '..', '..', 'dist', 'index.html'));
  win.once('ready-to-show', () => win.show());

  // 미리보기 안의 링크가 앱 창을 이동시키지 못하도록 막고, 외부 링크는 브라우저로 연다.
  win.webContents.on('will-navigate', (e, url) => {
    e.preventDefault();
    openLink(state, url);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    openLink(state, url);
    return { action: 'deny' };
  });

  win.on('resize', () => {
    if (!win.isMaximized() && !win.isFullScreen()) {
      const [w, h] = win.getSize();
      settings.windowBounds = { width: w, height: h };
      saveSettings();
    }
  });

  win.on('close', async (e) => {
    if (!state.dirty || state.forceClose) return;
    e.preventDefault();
    const name = state.filePath ? path.basename(state.filePath) : '제목 없음';
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['저장', '저장 안 함', '취소'],
      defaultId: 0,
      cancelId: 2,
      message: `"${name}" 문서의 변경 사항을 저장하시겠습니까?`,
      detail: '저장하지 않으면 변경 사항이 사라집니다.',
    });
    if (response === 2) {
      quitting = false;
      return;
    }
    if (response === 0) {
      const saved = await win.webContents.executeJavaScript('window.__mdEditor.save()').catch(() => false);
      if (!saved) {
        quitting = false;
        return;
      }
    }
    state.forceClose = true;
    win.close();
    if (quitting) app.quit();
  });

  win.on('closed', () => {
    unwatch(state);
    docs.delete(id);
  });

  return win;
}

function updateTitle(state) {
  const { win, filePath, dirty } = state;
  if (win.isDestroyed()) return;
  win.setTitle(filePath ? path.basename(filePath) : '제목 없음');
  if (isMac) {
    win.setRepresentedFilename(filePath || '');
    win.setDocumentEdited(dirty);
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

/** 이미 열린 파일이면 그 창에 포커스, 비어 있는 창이면 재사용, 아니면 새 창 */
async function openPath(filePath, targetState = focusedState()) {
  filePath = path.resolve(filePath);
  for (const s of docs.values()) {
    if (s.filePath === filePath) {
      s.win.show();
      s.win.focus();
      return;
    }
  }
  if (targetState && !targetState.filePath && !targetState.dirty && !targetState.win.isDestroyed()) {
    await loadInto(targetState, filePath);
  } else {
    createWindow(filePath);
  }
}

async function loadInto(state, filePath) {
  try {
    const doc = await readDoc(filePath);
    state.filePath = filePath;
    state.diskContent = doc.content;
    state.dirty = false;
    state.win.webContents.send('doc:load', doc);
    watch(state);
    addRecent(filePath);
    updateTitle(state);
  } catch (err) {
    dialog.showErrorBox('파일을 열 수 없습니다', `${filePath}\n\n${err.message}`);
    removeRecent(filePath);
  }
}

async function showOpenDialog(state) {
  const { canceled, filePaths } = await dialog.showOpenDialog(state?.win, {
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Markdown', extensions: MD_EXTENSIONS },
      { name: '모든 파일', extensions: ['*'] },
    ],
  });
  if (canceled) return;
  for (const p of filePaths) await openPath(p, state);
}

async function writeDoc(state, content, saveAs) {
  let target = state.filePath;
  if (!target || saveAs) {
    const { canceled, filePath } = await dialog.showSaveDialog(state.win, {
      defaultPath: target || path.join(app.getPath('documents'), '제목 없음.md'),
      filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
    });
    if (canceled || !filePath) return null;
    target = filePath;
  }
  state.ignoreUntil = Date.now() + 1500; // 우리가 쓴 변경은 외부 변경으로 감지하지 않음
  await fsp.writeFile(target, content, 'utf8');
  const changedPath = target !== state.filePath;
  state.filePath = target;
  state.diskContent = content;
  state.dirty = false;
  if (changedPath) {
    watch(state);
    addRecent(target);
  }
  updateTitle(state);
  return { filePath: target, name: path.basename(target), dirUrl: pathToFileURL(path.dirname(target) + path.sep).href };
}

// ───────────────────────── 외부 변경 감지 ─────────────────────────
// fs.watchFile(폴링)은 에디터들의 "원자적 저장(rename)"에도 끊기지 않는다.
function watch(state) {
  unwatch(state);
  const file = state.filePath;
  if (!file) return;
  const listener = async (curr, prev) => {
    if (curr.mtimeMs === prev.mtimeMs || Date.now() < state.ignoreUntil || state.win.isDestroyed()) return;
    if (curr.nlink === 0) {
      state.win.webContents.send('doc:external-deleted');
      return;
    }
    try {
      const content = await fsp.readFile(file, 'utf8');
      if (content === state.diskContent) return;
      state.diskContent = content;
      state.win.webContents.send('doc:external-change', { content, dirty: state.dirty });
    } catch {
      /* 일시적인 쓰기 중 상태 */
    }
  };
  fs.watchFile(file, { interval: 800 }, listener);
  state.unwatch = () => fs.unwatchFile(file, listener);
}
function unwatch(state) {
  state.unwatch?.();
  state.unwatch = null;
}

// ───────────────────────── 링크 처리 ─────────────────────────
function openLink(state, url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:') {
      shell.openExternal(url);
    } else if (u.protocol === 'file:') {
      const p = fileURLToPath(u);
      if (MD_EXTENSIONS.includes(path.extname(p).slice(1).toLowerCase())) openPath(p, null);
      else shell.openPath(p);
    }
  } catch {
    /* 잘못된 URL 무시 */
  }
}

// ───────────────────────── IPC ─────────────────────────
ipcMain.handle('renderer-ready', async (e) => {
  const state = stateOf(e.sender);
  const initial = {
    settings: { viewMode: settings.viewMode, sidebar: settings.sidebar, syncScroll: settings.syncScroll, autosave: settings.autosave, theme: settings.theme },
    doc: null,
  };
  if (state?.pendingContent != null) {
    initial.doc = { content: state.pendingContent, filePath: null, name: '제목 없음', dirUrl: null };
    state.pendingContent = null;
  } else if (state?.pending) {
    const p = state.pending;
    state.pending = null;
    try {
      initial.doc = await readDoc(p);
      state.filePath = p;
      state.diskContent = initial.doc.content;
      watch(state);
      addRecent(p);
    } catch (err) {
      dialog.showErrorBox('파일을 열 수 없습니다', `${p}\n\n${err.message}`);
    }
  }
  if (state) updateTitle(state);
  return initial;
});

ipcMain.handle('doc:save', async (e, { content, saveAs }) => {
  const state = stateOf(e.sender);
  try {
    return await writeDoc(state, content, saveAs);
  } catch (err) {
    dialog.showErrorBox('저장 실패', err.message);
    return null;
  }
});

ipcMain.on('doc:dirty', (e, dirty) => {
  const state = stateOf(e.sender);
  if (!state) return;
  state.dirty = dirty;
  updateTitle(state);
});

ipcMain.handle('doc:confirm-reload', async (e) => {
  const state = stateOf(e.sender);
  const { response } = await dialog.showMessageBox(state.win, {
    type: 'question',
    buttons: ['디스크 버전 불러오기', '내 편집 유지'],
    defaultId: 1,
    cancelId: 1,
    message: '다른 프로그램에서 파일이 변경되었습니다.',
    detail: '현재 저장하지 않은 편집 내용이 있습니다. 디스크의 버전으로 바꾸면 편집 내용이 사라집니다.',
  });
  return response === 0;
});

ipcMain.handle('doc:open-dialog', (e) => showOpenDialog(stateOf(e.sender)));
// 렌더러가 임의 경로를 열지 못하도록: 사용자가 직접 끌어다 놓은 마크다운 파일만 허용
ipcMain.handle('doc:open-dropped', (e, p) => {
  if (!isMarkdownPath(p) || !path.isAbsolute(p)) return false;
  openPath(p, stateOf(e.sender));
  return true;
});
ipcMain.handle('doc:new', () => createWindow());

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
ipcMain.handle('recent:open', (e, p) => {
  if (!settings.recentFiles.includes(p)) return false;
  openPath(p, stateOf(e.sender));
  return true;
});
ipcMain.handle('recent:remove', (_e, p) => removeRecent(p));
ipcMain.handle('recent:clear', () => {
  settings.recentFiles = [];
  recentChanged();
});

// 붙여넣기/드롭한 이미지를 문서 옆 assets/ 폴더에 저장하고 상대 경로를 돌려준다.
ipcMain.handle('fs:save-image', async (e, { data, ext, sourcePath }) => {
  const state = stateOf(e.sender);
  if (!state?.filePath || !IMAGE_EXTENSIONS.includes(String(ext).toLowerCase())) return null;
  const docDir = path.dirname(state.filePath);
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
  }
  else await fsp.writeFile(target, Buffer.from(data));
  return path.relative(docDir, target).split(path.sep).join('/');
});

ipcMain.handle('export:pdf', async (e) => {
  const state = stateOf(e.sender);
  const base = state.filePath ? path.basename(state.filePath, path.extname(state.filePath)) : '제목 없음';
  const { canceled, filePath } = await dialog.showSaveDialog(state.win, {
    defaultPath: path.join(state.filePath ? path.dirname(state.filePath) : app.getPath('documents'), `${base}.pdf`),
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (canceled || !filePath) return null;
  const pdf = await state.win.webContents.printToPDF({
    pageSize: 'A4',
    printBackground: true,
    margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 },
  });
  await fsp.writeFile(filePath, pdf);
  return filePath;
});

ipcMain.handle('export:html', async (e, html) => {
  const state = stateOf(e.sender);
  const base = state.filePath ? path.basename(state.filePath, path.extname(state.filePath)) : '제목 없음';
  const { canceled, filePath } = await dialog.showSaveDialog(state.win, {
    defaultPath: path.join(state.filePath ? path.dirname(state.filePath) : app.getPath('documents'), `${base}.html`),
    filters: [{ name: 'HTML', extensions: ['html'] }],
  });
  if (canceled || !filePath) return null;
  await fsp.writeFile(filePath, html, 'utf8');
  return filePath;
});

ipcMain.on('reveal', (e) => {
  const state = stateOf(e.sender);
  if (state?.filePath) shell.showItemInFolder(state.filePath);
});

ipcMain.on('settings:set', (_e, patch) => setSetting(patch));

// ───────────────────────── 메뉴 ─────────────────────────
function send(cmd, arg) {
  const win = BrowserWindow.getFocusedWindow();
  if (win) win.webContents.send('menu', cmd, arg);
}
function setSetting(patch) {
  Object.assign(settings, patch);
  if ('theme' in patch) nativeTheme.themeSource = settings.theme;
  saveSettings();
  for (const s of docs.values()) if (!s.win.isDestroyed()) s.win.webContents.send('settings:changed', patch);
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
        { label: '새 문서', accelerator: 'CmdOrCtrl+N', click: () => createWindow() },
        { label: '열기…', accelerator: 'CmdOrCtrl+O', click: () => showOpenDialog(focusedState()) },
        { label: '최근 문서', submenu: recent },
        { type: 'separator' },
        { label: '저장', accelerator: 'CmdOrCtrl+S', click: () => send('save') },
        { label: '다른 이름으로 저장…', accelerator: 'CmdOrCtrl+Shift+S', click: () => send('saveAs') },
        { label: '자동 저장', type: 'checkbox', checked: settings.autosave, click: (item) => setSetting({ autosave: item.checked }) },
        { type: 'separator' },
        { label: 'PDF로 내보내기…', accelerator: 'CmdOrCtrl+P', click: () => send('exportPdf') },
        { label: 'HTML로 내보내기…', accelerator: 'CmdOrCtrl+Shift+E', click: () => send('exportHtml') },
        { type: 'separator' },
        { label: 'Finder에서 보기', accelerator: 'CmdOrCtrl+Shift+R', click: () => send('reveal') },
        { type: 'separator' },
        isMac ? { role: 'close', label: '창 닫기' } : { role: 'quit', label: '종료' },
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
        { label: '전체 선택', accelerator: 'CmdOrCtrl+A', click: () => send('selectAll') },
        { type: 'separator' },
        { label: '찾기 / 바꾸기', accelerator: 'CmdOrCtrl+F', click: () => send('find') },
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
    { role: 'windowMenu', label: '윈도우' },
    {
      role: 'help',
      label: '도움말',
      submenu: [
        { label: '마크다운 문법 예제 열기', click: () => createWindow(null, fs.readFileSync(path.join(__dirname, '..', '..', 'dist', 'sample.md'), 'utf8')) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
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
    const argvFiles = process.argv.slice(app.isPackaged ? 1 : 2).filter((a) => fs.existsSync(a) && MD_EXTENSIONS.includes(path.extname(a).slice(1).toLowerCase()));
    const initial = [...pendingOpenPaths, ...argvFiles];
    if (initial.length) initial.forEach((f) => createWindow(path.resolve(f)));
    else createWindow();
  });
}

app.on('before-quit', () => {
  quitting = true;
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
app.on('window-all-closed', () => {
  if (!isMac) app.quit();
});
