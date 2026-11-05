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

  // 문서
  save: (content, saveAs = false) => ipcRenderer.invoke('doc:save', { content, saveAs }),
  setDirty: (dirty) => ipcRenderer.send('doc:dirty', dirty),
  confirmReload: () => ipcRenderer.invoke('doc:confirm-reload'),
  openDialog: () => ipcRenderer.invoke('doc:open-dialog'),
  openDropped: (p) => ipcRenderer.invoke('doc:open-dropped', p),
  newDocument: () => ipcRenderer.invoke('doc:new'),
  reveal: () => ipcRenderer.send('reveal'),

  // 최근 문서 (폴더 탐색 API는 제공하지 않음)
  recentList: () => ipcRenderer.invoke('recent:list'),
  recentOpen: (p) => ipcRenderer.invoke('recent:open', p),
  recentRemove: (p) => ipcRenderer.invoke('recent:remove', p),
  recentClear: () => ipcRenderer.invoke('recent:clear'),
  onRecentChanged: (cb) => on('recent:changed', cb),

  // 파일 시스템 (이미지 저장만)
  saveImage: (payload) => ipcRenderer.invoke('fs:save-image', payload),
  pathForFile: (file) => webUtils.getPathForFile(file),

  // 내보내기
  exportPdf: () => ipcRenderer.invoke('export:pdf'),
  exportHtml: (html) => ipcRenderer.invoke('export:html', html),

  // 설정
  setSettings: (patch) => ipcRenderer.send('settings:set', patch),

  // 이벤트
  onLoad: (cb) => on('doc:load', cb),
  onExternalChange: (cb) => on('doc:external-change', cb),
  onExternalDelete: (cb) => on('doc:external-deleted', cb),
  onMenu: (cb) => on('menu', cb),
  onSettings: (cb) => on('settings:changed', cb),
});
