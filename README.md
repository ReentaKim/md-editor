# MD Editor

Mac에 설치해서 쓰는 마크다운 **편집기**입니다. 왼쪽에서 편집하고 오른쪽에서 결과를 바로 확인할 수 있습니다. 문서는 탭으로 여러 개 열 수 있고 PDF·HTML로 내보낼 수 있으며, 새 버전이 나오면 앱 안에서 버튼 한 번으로 업데이트됩니다.

> **지원 환경:** macOS · Apple Silicon(M1 이상) Mac. Intel Mac과 Windows는 아직 지원하지 않습니다.

## 설치

### 방법 1. 터미널에 한 줄 붙여 넣기 (추천)

**터미널** 앱(Spotlight에서 "터미널" 검색)을 열고 아래 한 줄을 붙여 넣은 뒤 Enter를 누르세요.

```bash
curl -fsSL https://raw.githubusercontent.com/ReentaKim/md-editor/main/install.sh | sh
```

최신 버전을 내려받아 파일이 손상되지 않았는지(SHA-256) 확인한 뒤 `응용 프로그램` 폴더에 설치하고 앱을 실행합니다. 이 방법으로 설치하면 보안 경고가 뜨지 않습니다. 스크립트 내용은 [install.sh](install.sh)에서 확인할 수 있습니다.

### 방법 2. DMG 내려받아 설치

1. [최신 릴리스](https://github.com/ReentaKim/md-editor/releases/latest)에서 `MD-Editor-<버전>-arm64.dmg`를 내려받습니다.
2. DMG를 열고 **MD Editor**를 **Applications** 폴더로 끌어다 놓습니다.
3. 처음 실행하면 *"Apple에서 확인할 수 없습니다"* 경고가 뜹니다. Apple 공증을 받지 않은 앱이기 때문입니다.
   - **완료**를 누르고, **시스템 설정 → 개인정보 보호 및 보안**으로 이동합니다. 아래쪽에 있는 **그래도 열기**를 누른 뒤 암호를 입력하세요. 이 과정은 처음 한 번만 하면 됩니다.
   - 또는 터미널에서 `xattr -dr com.apple.quarantine "/Applications/MD Editor.app"`을 실행해도 됩니다.

### 방법 3. Claude Code에게 부탁하기

Claude Code를 쓰고 있다면 이렇게 요청하면 됩니다.

```
https://github.com/ReentaKim/md-editor 의 install.sh로 MD Editor 설치해줘
```

## 업데이트

새 버전이 나오면 앱 오른쪽 아래에 알림이 뜹니다. **[업데이트] → [지금 재시작]**을 누르면 끝입니다. 메뉴의 **MD Editor → 업데이트 확인…**으로 직접 확인할 수도 있습니다.

- 처음 업데이트할 때 macOS가 "앱 관리" 권한을 물을 수 있습니다. **시스템 설정 → 개인정보 보호 및 보안 → 앱 관리**에서 MD Editor를 허용해 주세요.
- v0.2.x 이하를 쓰고 있다면 앱 안에서 업데이트할 수 없습니다. 위의 설치 방법으로 한 번만 다시 설치해 주세요.

## 기본 앱으로 지정

`.md` 파일을 더블클릭했을 때 MD Editor로 열리게 하려면 다음과 같이 지정합니다. Finder에서 아무 `.md` 파일을 선택하고 `⌘I`(정보 가져오기)를 누릅니다. **다음으로 열기**에서 MD Editor를 고른 뒤 **모두 변경**을 누르세요.

## 삭제

`응용 프로그램` 폴더의 MD Editor를 휴지통으로 옮기면 됩니다. 설정(최근 문서 등)까지 지우려면 `~/Library/Application Support/MD Editor` 폴더도 함께 삭제하세요.

## 개발

```bash
npm install
npm start        # 빌드 후 실행
npm run dist     # release/<버전>/ 에 .dmg 생성 (Apple Silicon)
```

릴리스할 때는 태그를 `v<버전>`으로, DMG 파일 이름을 `MD-Editor-<버전>-arm64.dmg`로 맞춰 GitHub Release에 올려야 합니다. 앱의 업데이트 기능과 `install.sh`가 이 이름으로 파일을 찾습니다.

| 경로 | 역할 |
| --- | --- |
| `src/main/main.js` | 창/메뉴/파일 입출력/외부 변경 감지/PDF 내보내기 (main 프로세스) |
| `src/main/preload.js` | 렌더러에 노출하는 최소 API (`window.api`) |
| `src/main/updater.js` | 앱 안 업데이트: GitHub 릴리스 확인 → 다운로드 → SHA-256·서명 검증 → 교체 |
| `src/renderer/app.js` | UI 연결: 탭, 미리보기, 목차, 최근 문서, 스크롤 동기화, 저장, 업데이트 알림 |
| `src/renderer/editor.js` | CodeMirror 6 편집기 + 서식 명령 |
| `src/renderer/markdown.js` | markdown-it 렌더링 파이프라인 + Mermaid |
| `src/renderer/preview.css` | 문서 스타일 (HTML 내보내기에도 그대로 포함) |
| `build.mjs` | esbuild 번들 + 벤더 파일 복사 (CDN 없이 오프라인 동작) |
| `install.sh` | 사용자용 설치 스크립트 (최신 릴리스 다운로드 → 검증 → 설치) |

## 기능

| 기능 |
| --- |
| 마크다운 렌더링 (각주·정의 목록·약어·체크리스트·KaTeX·코드 하이라이트) |
| **편집 / 저장 / 다른 이름으로 저장 / 자동 저장** |
| 편집기·분할·미리보기 3가지 보기 (`⌘1` `⌘2` `⌘3`) |
| 편집기 ↔ 미리보기 스크롤 동기화, 미리보기를 더블클릭하면 원본 위치로 이동 |
| 서식 툴바와 단축키 (제목, 굵게, 링크, 목록, 표, 코드 블록 등) |
| 찾기/바꾸기 (`⌘F`) |
| 이미지 붙여넣기·끌어놓기 시 `assets/`에 저장하고 링크 자동 삽입 |
| 미리보기에서 체크박스를 클릭하면 원본의 `[ ]`↔`[x]` 토글 |
| 다른 프로그램이 파일을 바꾸면 자동으로 다시 불러오기 (편집 중이면 확인 후) |
| Mermaid 다이어그램 |
| 사이드바: 목차(현재 위치 강조) + 최근 문서 목록 |
| PDF 내보내기 |
| HTML 내보내기 |
| 오프라인 렌더링 |
| 렌더러 sandbox |
| 앱 업데이트 |
| 렌더러의 파일 접근 |
| 여러 문서를 동시에 열기 |

## 다음에 해볼 만한 것

- 탭을 다른 창으로 끌어서 옮기기
- 최근 문서 안에서 내용 검색
- Windows 빌드 (`electron-builder --win`), 코드 서명·공증
