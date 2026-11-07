// 세션 파일 — 다시 켰을 때 이전 창·탭을 복원하고, 저장하지 않은 내용을 보존한다.
// 앱이 갑자기 꺼져도 잃는 내용이 최소가 되도록 변경이 생길 때마다 짧게 모아서 기록한다.
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const VERSION = 1;
const file = () => path.join(app.getPath('userData'), 'session.json');

/** @returns {{version:number, windows:Array<{bounds?:object, active?:number, tabs:Array<object>}>}|null} */
function load() {
  try {
    const data = JSON.parse(fs.readFileSync(file(), 'utf8'));
    return data && data.version === VERSION && Array.isArray(data.windows) ? data : null;
  } catch {
    return null; // 처음 실행했거나 파일이 손상됨
  }
}

let timer = null;
let pending = null;

/** getData()를 잠시 뒤에 한 번만 기록한다 (연속 변경을 모아서) */
function save(getData, delay = 300) {
  pending = getData;
  clearTimeout(timer);
  timer = setTimeout(flush, delay);
}

/** 대기 중인 기록을 바로 쓴다. 임시 파일에 쓴 뒤 이름을 바꿔서, 쓰는 도중 꺼져도 파일이 깨지지 않게 한다. */
function flush() {
  clearTimeout(timer);
  timer = null;
  if (!pending) return;
  const getData = pending;
  pending = null;
  try {
    const target = file();
    const tmp = `${target}.tmp`;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ version: VERSION, ...getData() }));
    fs.renameSync(tmp, target);
  } catch (err) {
    console.error('세션 저장 실패', err);
  }
}

module.exports = { load, save, flush };
