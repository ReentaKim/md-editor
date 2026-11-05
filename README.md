# MD Editor

로컬 PC에 설치해서 쓰는 마크다운 **편집기**입니다. 실시간 미리보기와 편집 기능을 함께 제공합니다.

## 설치

```bash
open "release/0.2.1/MD Editor-0.2.1-arm64.dmg"   # 창이 열리면 MD Editor를 응용 프로그램 폴더로 끌어다 놓기
```

- `.md` 파일을 항상 MD Editor로 열려면: Finder에서 아무 `.md` 파일 선택 → `⌘I`(정보 가져오기) → "다음으로 열기"에서 MD Editor 선택 → **모두 변경**
- ad-hoc 서명만 되어 있습니다. 직접 빌드한 이 PC에서는 바로 실행됩니다. 다른 Mac에 복사하면 처음 한 번은 앱을 우클릭한 뒤 **열기**를 선택해야 합니다.

## 개발

```bash
npm install
npm start        # 빌드 후 실행
npm run dist     # release/<버전>/ 에 .dmg 생성 (Apple Silicon)
```

| 경로 | 역할 |
| --- | --- |
| `src/main/main.js` | 창/메뉴/파일 입출력/외부 변경 감지/PDF 내보내기 (main 프로세스) |
| `src/main/preload.js` | 렌더러에 노출하는 최소 API (`window.api`) |
| `src/renderer/app.js` | UI 연결: 미리보기, 목차, 파일 트리, 스크롤 동기화, 저장 |
| `src/renderer/editor.js` | CodeMirror 6 편집기 + 서식 명령 |
| `src/renderer/markdown.js` | markdown-it 렌더링 파이프라인 + Mermaid |
| `src/renderer/preview.css` | 문서 스타일 (HTML 내보내기에도 그대로 포함) |
| `build.mjs` | esbuild 번들 + 벤더 파일 복사 (CDN 없이 오프라인 동작) |

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
| 렌더러의 파일 접근 |
| 여러 문서를 동시에 열기 |

## 다음에 해볼 만한 것

- 탭을 다른 창으로 끌어서 옮기기
- 최근 문서 안에서 내용 검색
- Windows 빌드 (`electron-builder --win`), 코드 서명·공증
