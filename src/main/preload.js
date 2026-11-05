// sandbox:true 환경의 preload — 렌더러에 꼭 필요한 API만 노출한다.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = (channel, cb) => {
  const listener = (_e, ...args) => cb(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,

  ready: () => ipcRenderer.invoke('renderer-ready'),

  // 탭
  newTab: () => ipcRenderer.invoke('tab:new'),
  tabActivated: (tabId) => ipcRenderer.send('tab:activated', tabId),
  tabClosed: (tabId) => ipcRenderer.send('tab:closed', tabId),
  confirmCloseTab: (name) => ipcRenderer.invoke('tab:confirm-close', name),
  tabDragStart: (tabId) => ipcRenderer.send('tab:drag-start', tabId),
  tabDragEnd: (tabId) => ipcRenderer.send('tab:drag-end', tabId),
  tabDragActive: () => ipcRenderer.invoke('tab:drag-active'),
  tabDropHere: (index) => ipcRenderer.send('tab:drop-here', index),
  tabDetach: (tabId) => ipcRenderer.invoke('tab:detach', tabId),
  onTabImport: (cb) => on('tab:import', cb),
  closeWindow: () => ipcRenderer.send('window:close'),

  // 문서 (모두 탭 단위)
  save: (tabId, content, saveAs = false) => ipcRenderer.invoke('doc:save', { tabId, content, saveAs }),
  setDirty: (tabId, dirty) => ipcRenderer.send('doc:dirty', tabId, dirty),
  confirmReload: (name) => ipcRenderer.invoke('doc:confirm-reload', name),
  openDialog: () => ipcRenderer.invoke('doc:open-dialog'),
  openDropped: (p) => ipcRenderer.invoke('doc:open-dropped', p),
  reveal: (tabId) => ipcRenderer.send('reveal', tabId),

  // 최근 문서 (폴더 탐색 API는 제공하지 않음)
  recentList: () => ipcRenderer.invoke('recent:list'),
  recentOpen: (p, reveal = null) => ipcRenderer.invoke('recent:open', p, reveal),
  recentSearch: (query) => ipcRenderer.invoke('recent:search', query),
  onTabReveal: (cb) => on('tab:reveal', cb),
  recentRemove: (p) => ipcRenderer.invoke('recent:remove', p),
  recentClear: () => ipcRenderer.invoke('recent:clear'),
  onRecentChanged: (cb) => on('recent:changed', cb),

  // 파일 시스템 (이미지 저장만)
  saveImage: (payload) => ipcRenderer.invoke('fs:save-image', payload),
  pathForFile: (file) => webUtils.getPathForFile(file),

  // 내보내기
  exportPdf: (tabId) => ipcRenderer.invoke('export:pdf', tabId),
  exportHtml: (tabId, html) => ipcRenderer.invoke('export:html', tabId, html),

  // 업데이트
  updateDownload: () => ipcRenderer.send('update:download'),
  updateInstallNow: () => ipcRenderer.send('update:install-now'),
  updateInstallLater: () => ipcRenderer.send('update:install-later'),
  updateDismiss: () => ipcRenderer.send('update:dismiss'),
  updateOpenPage: () => ipcRenderer.send('update:open-page'),
  onUpdateState: (cb) => on('update:state', cb),

  // 설정
  setSettings: (patch) => ipcRenderer.send('settings:set', patch),

  // 이벤트
  onLoad: (cb) => on('doc:load', cb),
  onTabActivate: (cb) => on('tab:activate', cb),
  onExternalChange: (cb) => on('doc:external-change', cb),
  onExternalDelete: (cb) => on('doc:external-deleted', cb),
  onMenu: (cb) => on('menu', cb),
  onSettings: (cb) => on('settings:changed', cb),
});
