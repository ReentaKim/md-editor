#!/bin/sh
# MD Editor 설치 스크립트 (macOS · Apple Silicon)
#
#   curl -fsSL https://raw.githubusercontent.com/ReentaKim/md-editor/main/install.sh | sh
#
# GitHub 최신 릴리스의 DMG를 받아 SHA-256을 검증한 뒤 /Applications 에 설치한다.
# 터미널(curl)로 받은 파일에는 macOS 격리 표시가 붙지 않아 "확인되지 않은 개발자" 경고 없이 열린다.
set -eu

REPO="ReentaKim/md-editor"
APP_NAME="MD Editor.app"
DEST="${MD_EDITOR_INSTALL_DIR:-/Applications}" # 테스트용으로 설치 위치를 바꿀 수 있음

say() { printf '\033[1m%s\033[0m\n' "$*"; }
die() { printf '\033[31m오류: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "macOS 전용입니다."
[ "$(uname -m)" = "arm64" ] || die "Apple Silicon(M1 이상) Mac 전용입니다. Intel Mac용 빌드는 아직 없습니다."

if pgrep -f "$DEST/$APP_NAME/Contents/MacOS/" >/dev/null 2>&1; then
  die "MD Editor가 실행 중입니다. ⌘Q로 종료한 뒤 다시 실행해 주세요."
fi

say "▸ 최신 버전 확인 중…"
JSON=$(curl -fsSL -H "Accept: application/vnd.github+json" "https://api.github.com/repos/$REPO/releases/latest") \
  || die "GitHub에 연결할 수 없습니다."
get() { printf '%s' "$JSON" | plutil -extract "$1" raw -o - - 2>/dev/null; }

VERSION=$(get tag_name) || die "릴리스 정보를 읽을 수 없습니다."
URL="" SHA=""
i=0
while NAME=$(get "assets.$i.name"); do
  case "$NAME" in
    *-arm64.dmg)
      URL=$(get "assets.$i.browser_download_url")
      SHA=$(get "assets.$i.digest" | sed 's/^sha256://')
      break ;;
  esac
  i=$((i + 1))
done
[ -n "$URL" ] || die "$VERSION 릴리스에 Apple Silicon용 DMG가 없습니다."
[ -n "$SHA" ] || die "$VERSION 릴리스에 SHA-256 정보가 없어 검증할 수 없습니다."

TMP=$(mktemp -d)
MNT="$TMP/mnt"
cleanup() { hdiutil detach "$MNT" -quiet -force >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT INT TERM

say "▸ MD Editor $VERSION 다운로드 중…"
curl -fL --progress-bar -o "$TMP/md-editor.dmg" "$URL" || die "다운로드에 실패했습니다."

say "▸ 파일 검증 중 (SHA-256)…"
ACTUAL=$(shasum -a 256 "$TMP/md-editor.dmg" | cut -d' ' -f1)
[ "$ACTUAL" = "$SHA" ] || die "SHA-256이 일치하지 않습니다. 파일이 손상되었을 수 있어 설치를 중단합니다."

say "▸ $DEST 에 설치 중…"
mkdir -p "$MNT"
hdiutil attach -nobrowse -readonly -noautoopen -quiet -mountpoint "$MNT" "$TMP/md-editor.dmg" || die "DMG를 열 수 없습니다."
[ -d "$MNT/$APP_NAME" ] || die "DMG 안에 $APP_NAME 이 없습니다."
codesign --verify --deep --strict "$MNT/$APP_NAME" 2>/dev/null || die "앱 서명 검증에 실패했습니다."
if [ -d "$DEST/$APP_NAME" ]; then
  rm -rf "$DEST/$APP_NAME" || die "기존 앱을 지울 수 없습니다. 권한을 확인해 주세요."
fi
ditto "$MNT/$APP_NAME" "$DEST/$APP_NAME" || die "$DEST 에 복사할 수 없습니다. 권한을 확인해 주세요."

say "✓ MD Editor $VERSION 설치 완료 — $DEST/$APP_NAME"
echo "  다음 버전부터는 앱 안의 알림에서 [업데이트] 버튼으로 업데이트할 수 있습니다."
[ -z "${MD_EDITOR_INSTALL_DIR:-}" ] && open "$DEST/$APP_NAME"
exit 0
