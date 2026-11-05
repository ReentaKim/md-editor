// MD Editor — 자체 업데이트
//
// Electron 표준 자동 업데이트(Squirrel.Mac)는 Apple Developer ID 서명이 필요하다.
// 이 앱은 ad-hoc 서명이라, 대신 다음 방식으로 "버튼 한 번 업데이트"를 구현한다.
//   1. GitHub Releases API로 최신 버전 확인
//   2. DMG 다운로드 → SHA-256 검증(릴리스 asset digest)
//   3. DMG를 읽기 전용으로 마운트 → 앱 복사(staging) → 번들 ID·버전·코드 서명 검증
//   4. 앱이 종료된 뒤 작은 셸 스크립트가 기존 앱과 교체하고 다시 실행
//      (Windows: 설치 프로그램(.exe)을 받아 SHA-256 검증 → 종료 후 PowerShell이 /S로 조용히 재설치)
//   5. 실패하면 이전 앱을 되돌리고, 다음 실행 때 원인과 수동 설치 방법을 안내
const { app, net, shell, dialog, BrowserWindow } = require('electron');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');

const run = promisify(execFile);

const REPO = 'ReentaKim/md-editor';
const BUNDLE_ID = 'io.github.reentakim.mdeditor';
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;
// 테스트 전용: 로컬 가짜 릴리스 서버를 가리킬 수 있다(이때만 127.0.0.1 http 다운로드 허용)
const TEST_API = process.env.MD_EDITOR_UPDATE_API;
const API = TEST_API || `https://api.github.com/repos/${REPO}/releases/latest`;
const ALLOWED_DOWNLOAD = TEST_API
  ? /^http:\/\/127\.0\.0\.1:\d+\//
  : new RegExp(`^https://github\\.com/${REPO.replace('/', '\\/')}/releases/download/`);
const CHECK_INTERVAL = 6 * 60 * 60 * 1000;

let ctx = null; // { settings, saveSettings, rebuildMenu }
let state = { status: 'idle' };
let release = null; // 최신 릴리스 정보
let staged = null; // { appPath, dir, dmg, version }
let installOnQuit = false;
let relaunchAfterInstall = false;
let dismissedVersion = null;
let installedNotice = null; // 방금 업데이트되어 실행된 경우 렌더러에 알릴 버전

const resultFile = () => path.join(app.getPath('userData'), 'update-result.json');

function broadcast() {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('update:state', publicState());
  }
}
function setState(next) {
  state = next;
  broadcast();
}
/** 렌더러에 보내는 상태 (나중에를 누른 버전은 숨김) */
function publicState() {
  if (state.status === 'available' && state.version === dismissedVersion) return { status: 'idle' };
  return { ...state, onQuit: installOnQuit && !relaunchAfterInstall };
}

function compareVersions(a, b) {
  const pa = String(a).split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

/** 현재 실행 중인 .app 번들 경로 (패키징된 앱에서만 의미 있음) */
function appBundlePath() {
  return path.resolve(path.dirname(app.getPath('exe')), '..', '..');
}
const IS_WIN = process.platform === 'win32';
/** 이 플랫폼용 릴리스 파일 이름 규칙: Mac `MD-Editor-<ver>-arm64.dmg`, Windows `MD-Editor-Setup-<ver>-x64.exe` */
const ASSET_SUFFIX = `-${process.arch}.${IS_WIN ? 'exe' : 'dmg'}`;

function canSelfInstall() {
  if (!app.isPackaged) return false;
  if (process.platform === 'darwin') return appBundlePath().endsWith('.app');
  // 설치 프로그램으로 설치된 경우에만(제거 프로그램이 함께 있음) 자체 업데이트
  if (IS_WIN) return fs.existsSync(path.join(path.dirname(app.getPath('exe')), 'Uninstall MD Editor.exe'));
  return false;
}

// ───────────────────────── 확인 ─────────────────────────
async function check({ manual = false } = {}) {
  if (['downloading', 'verifying', 'ready'].includes(state.status)) {
    if (manual) dismissedVersion = null, broadcast();
    return;
  }
  if (manual) setState({ status: 'checking' });
  try {
    const res = await net.fetch(API, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'MD-Editor-Updater' },
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`GitHub 응답 오류 (${res.status})`);
    const rel = await res.json();
    const version = String(rel.tag_name || '').replace(/^v/, '');
    if (!version || compareVersions(version, app.getVersion()) <= 0) {
      setState({ status: 'idle' });
      if (manual) {
        await dialog.showMessageBox({
          type: 'info',
          message: '최신 버전을 사용하고 있습니다.',
          detail: `현재 버전: ${app.getVersion()}`,
        });
      }
      return;
    }
    const asset = (rel.assets || []).find((a) => a.name.endsWith(ASSET_SUFFIX));
    if (!asset) {
      // 새 버전은 나왔지만 이 플랫폼용 파일이 아직 올라오지 않음(예: Windows 빌드 진행 중)
      setState({ status: 'idle' });
      if (manual) {
        await dialog.showMessageBox({
          type: 'info',
          message: `새 버전 v${version}이 준비 중입니다.`,
          detail: '이 컴퓨터용 설치 파일이 아직 올라오지 않았습니다. 잠시 후 다시 확인해 주세요.',
        });
      }
      return;
    }
    const sha256 = asset?.digest?.startsWith('sha256:')
      ? asset.digest.slice(7)
      : (rel.body || '').match(/`([0-9a-f]{64})`/i)?.[1];
    release = { version, notesUrl: rel.html_url || RELEASES_PAGE, asset, sha256: sha256?.toLowerCase() || null };
    if (manual) dismissedVersion = null;
    setState({
      status: 'available',
      version,
      notesUrl: release.notesUrl,
      canInstall: Boolean(asset && release.sha256 && canSelfInstall()),
    });
  } catch (err) {
    if (manual) {
      setState({ status: 'idle' });
      await dialog.showMessageBox({ type: 'warning', message: '업데이트를 확인하지 못했습니다.', detail: err.message });
    } else {
      console.warn('[updater] 확인 실패:', err.message);
    }
  }
}

// ───────────────────────── 다운로드 · 검증 · 준비 ─────────────────────────
async function download() {
  if (!release?.asset || !release.sha256 || !canSelfInstall()) return openReleasePage();
  const { version, asset, sha256 } = release;
  const url = asset.browser_download_url;
  let dir = null;
  try {
    if (!ALLOWED_DOWNLOAD.test(url)) throw new Error('허용되지 않은 다운로드 주소입니다.');
    dir = await fsp.mkdtemp(path.join(app.getPath('temp'), 'md-editor-update-'));
    const dmg = path.join(dir, path.basename(asset.name));

    setState({ status: 'downloading', version, progress: 0 });
    const res = await net.fetch(url, { headers: { 'User-Agent': 'MD-Editor-Updater' } });
    if (!res.ok || !res.body) throw new Error(`다운로드 실패 (${res.status})`);
    const total = Number(res.headers.get('content-length')) || asset.size || 0;
    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(dmg);
    let received = 0;
    let lastReport = 0;
    for await (const chunk of res.body) {
      const buf = Buffer.from(chunk);
      hash.update(buf);
      received += buf.length;
      if (!out.write(buf)) await once(out, 'drain');
      if (Date.now() - lastReport > 150) {
        lastReport = Date.now();
        setState({ status: 'downloading', version, progress: total ? received / total : null });
      }
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));

    setState({ status: 'verifying', version });
    if (hash.digest('hex') !== sha256) throw new Error('받은 파일의 SHA-256이 릴리스와 일치하지 않습니다. 파일이 손상되었을 수 있습니다.');

    if (IS_WIN) {
      // Windows: 설치 프로그램 자체를 실행할 것이므로 실행 파일 형식(MZ)만 추가로 확인
      const fh = await fsp.open(dmg, 'r');
      const head = Buffer.alloc(2);
      await fh.read(head, 0, 2, 0);
      await fh.close();
      if (head.toString('latin1') !== 'MZ') throw new Error('받은 파일이 Windows 설치 프로그램이 아닙니다.');
      staged = { installer: dmg, dir, version };
      setState({ status: 'ready', version });
      return;
    }

    // 읽기 전용 마운트 → 앱 복사 → 검증
    const mnt = path.join(dir, 'mnt');
    await fsp.mkdir(mnt);
    await run('hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-noverify', '-mountpoint', mnt, dmg]);
    const appPath = path.join(dir, 'MD Editor.app');
    try {
      const appName = (await fsp.readdir(mnt)).find((n) => n.endsWith('.app'));
      if (!appName) throw new Error('DMG 안에서 앱을 찾을 수 없습니다.');
      await run('ditto', [path.join(mnt, appName), appPath]);
    } finally {
      await run('hdiutil', ['detach', mnt, '-force']).catch(() => {});
    }
    const plist = path.join(appPath, 'Contents', 'Info.plist');
    const { stdout: id } = await run('plutil', ['-extract', 'CFBundleIdentifier', 'raw', plist]);
    const { stdout: ver } = await run('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', plist]);
    if (id.trim() !== BUNDLE_ID) throw new Error(`앱 ID가 다릅니다 (${id.trim()}).`);
    if (ver.trim() !== version) throw new Error(`앱 버전이 다릅니다 (${ver.trim()}).`);
    await run('codesign', ['--verify', '--deep', '--strict', appPath]);

    staged = { appPath, dir, dmg, version };
    setState({ status: 'ready', version });
  } catch (err) {
    if (dir && !staged) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    setState({ status: 'error', version, message: err.message, notesUrl: release.notesUrl });
  }
}

// ───────────────────────── 설치 ─────────────────────────
function installNow() {
  if (!staged) return;
  installOnQuit = true;
  relaunchAfterInstall = true;
  broadcast();
  app.quit(); // 저장 안 된 문서가 있으면 평소처럼 창마다 확인한다
}
function installLater() {
  if (!staged) return;
  installOnQuit = true;
  relaunchAfterInstall = false;
  broadcast();
}
/** 종료가 취소되면(저장 확인에서 "취소") 재시작 예약만 풀고, 종료 시 설치는 유지 */
function quitCancelled() {
  if (relaunchAfterInstall) {
    relaunchAfterInstall = false;
    broadcast();
  }
}

const INSTALL_SCRIPT = `#!/bin/sh
# MD Editor 업데이트 설치 — 앱이 완전히 종료된 뒤 실행된다
PID="$1"; TARGET="$2"; STAGED="$3"; RESULT="$4"; RELAUNCH="$5"; VERSION="$6"; DIR="$7"; DMG="$8"
i=0
while kill -0 "$PID" 2>/dev/null && [ "$i" -lt 300 ]; do sleep 0.2; i=$((i+1)); done
BACKUP="$DIR/previous.app"
write() { printf '{"ok":%s,"version":"%s","reason":"%s","dir":"%s","dmg":"%s"}' "$1" "$VERSION" "$2" "$DIR" "$DMG" > "$RESULT"; }
fail() {
  write false "$1"
  [ "$RELAUNCH" = 1 ] && [ -z "$MD_EDITOR_UPDATE_NO_RELAUNCH" ] && open "$TARGET"
  exit 1
}
mv "$TARGET" "$BACKUP" 2>/dev/null || fail move-old
if ! mv "$STAGED" "$TARGET" 2>/dev/null; then
  mv "$BACKUP" "$TARGET" 2>/dev/null
  fail move-new
fi
rm -rf "$BACKUP"
write true ""
[ "$RELAUNCH" = 1 ] && [ -z "$MD_EDITOR_UPDATE_NO_RELAUNCH" ] && open "$TARGET"
exit 0
`;

const WIN_INSTALL_SCRIPT = `param([int]$AppPid, [string]$Installer, [string]$Result, [string]$Relaunch, [string]$Version, [string]$Dir, [string]$Exe)
# MD Editor 업데이트 설치 (Windows) — 앱이 완전히 종료된 뒤 실행된다
for ($i = 0; $i -lt 150 -and (Get-Process -Id $AppPid -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Milliseconds 200 }
$code = -1
try {
  $p = Start-Process -FilePath $Installer -ArgumentList '/S', '--updated' -Wait -PassThru
  $code = $p.ExitCode
} catch { $code = -2 }
$ok = ($code -eq 0)
$reason = if ($ok) { '' } else { "installer-exit-$code" }
$json = @{ ok = $ok; version = $Version; reason = $reason; dir = $Dir; file = $Installer } | ConvertTo-Json -Compress
[IO.File]::WriteAllText($Result, $json, (New-Object System.Text.UTF8Encoding $false))
if ($Relaunch -eq '1' -and -not $env:MD_EDITOR_UPDATE_NO_RELAUNCH) { Start-Process -FilePath $Exe }
`;

function runInstallerOnQuit() {
  if (!installOnQuit || !staged) return;
  if (IS_WIN) {
    const script = path.join(staged.dir, 'install.ps1');
    fs.writeFileSync(script, '\ufeff' + WIN_INSTALL_SCRIPT, 'utf8'); // BOM: PowerShell 5.1이 UTF-8로 읽도록
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script,
        '-AppPid', String(process.pid), '-Installer', staged.installer, '-Result', resultFile(),
        '-Relaunch', relaunchAfterInstall ? '1' : '0', '-Version', staged.version, '-Dir', staged.dir, '-Exe', process.execPath],
      { detached: true, stdio: 'ignore', windowsHide: true },
    );
    child.unref();
    installOnQuit = false;
    return;
  }
  const script = path.join(staged.dir, 'install.sh');
  fs.writeFileSync(script, INSTALL_SCRIPT, { mode: 0o755 });
  const child = spawn(
    '/bin/sh',
    [script, String(process.pid), appBundlePath(), staged.appPath, resultFile(), relaunchAfterInstall ? '1' : '0', staged.version, staged.dir, staged.dmg],
    { detached: true, stdio: 'ignore' },
  );
  child.unref();
  installOnQuit = false;
}

// ───────────────────────── 이전 설치 결과 ─────────────────────────
async function reportPreviousResult() {
  let result;
  try {
    result = JSON.parse(await fsp.readFile(resultFile(), 'utf8'));
  } catch {
    return;
  }
  await fsp.rm(resultFile(), { force: true });
  if (result.ok) {
    if (result.dir) await fsp.rm(result.dir, { recursive: true, force: true }).catch(() => {});
    if (result.version === app.getVersion()) installedNotice = result.version;
    return;
  }
  const file = result.file || result.dmg;
  if (IS_WIN) {
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['설치 프로그램 직접 실행', '닫기'],
      defaultId: 0,
      cancelId: 1,
      message: `v${result.version} 업데이트를 설치하지 못했습니다.`,
      detail: `설치 프로그램이 정상적으로 끝나지 않았습니다(${result.reason}). 기존 앱은 그대로 유지되어 있습니다.\n\n"설치 프로그램 직접 실행"을 눌러 다시 설치해 주세요.`,
    });
    if (response === 0 && file && fs.existsSync(file)) shell.openPath(file);
    else if (response === 0) openReleasePage();
    return;
  }
  // 실패: 대부분 macOS "앱 관리" 권한 때문. DMG는 남겨 두었으므로 직접 설치를 안내한다
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    buttons: ['DMG로 직접 설치', '앱 관리 권한 설정 열기', '닫기'],
    defaultId: 0,
    cancelId: 2,
    message: `v${result.version} 업데이트를 설치하지 못했습니다.`,
    detail:
      'macOS가 앱 파일 교체를 막았습니다. 기존 앱은 그대로 유지되어 있습니다.\n\n' +
      '• 시스템 설정 → 개인정보 보호 및 보안 → 앱 관리에서 MD Editor를 허용한 뒤 다시 업데이트하거나\n' +
      '• "DMG로 직접 설치"를 눌러 응용 프로그램 폴더로 끌어다 놓으세요.',
  });
  if (response === 0 && file && fs.existsSync(file)) shell.openPath(file);
  else if (response === 0) openReleasePage();
  else if (response === 1) shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_AppBundles');
}

function openReleasePage() {
  shell.openExternal(release?.notesUrl || RELEASES_PAGE);
}

// ───────────────────────── 초기화 ─────────────────────────
function init(options) {
  ctx = options;
  app.on('will-quit', runInstallerOnQuit);
  reportPreviousResult().finally(() => {
    if (ctx.settings.autoUpdateCheck !== false) setTimeout(() => check(), 4000);
  });
  setInterval(() => {
    if (ctx.settings.autoUpdateCheck !== false) check();
  }, CHECK_INTERVAL);
}

function takeInstalledNotice() {
  const v = installedNotice;
  installedNotice = null;
  return v;
}

function dismiss() {
  if (state.status === 'available') dismissedVersion = state.version;
  else if (state.status === 'error') state = { status: 'idle' };
  broadcast();
}

module.exports = {
  init,
  check,
  download,
  installNow,
  installLater,
  quitCancelled,
  dismiss,
  openReleasePage,
  publicState,
  takeInstalledNotice,
};
