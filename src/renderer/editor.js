// CodeMirror 6 기반 마크다운 편집기 + 서식 명령
import { EditorView, keymap, drawSelection, highlightActiveLine, dropCursor, rectangularSelection, crosshairCursor, placeholder } from '@codemirror/view';
import { EditorState, EditorSelection } from '@codemirror/state';
import { defaultKeymap, history, historyField, historyKeymap, indentWithTab, undo, redo, selectAll } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { syntaxHighlighting, HighlightStyle, bracketMatching, indentOnInput } from '@codemirror/language';
import { search, searchKeymap, highlightSelectionMatches, openSearchPanel } from '@codemirror/search';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { tags as t } from '@lezer/highlight';

// 색은 전부 CSS 변수 → 라이트/다크 전환 시 확장 재구성 불필요
const mdHighlight = HighlightStyle.define([
  { tag: t.heading1, fontWeight: '700', fontSize: '1.35em', color: 'var(--ed-heading)' },
  { tag: t.heading2, fontWeight: '700', fontSize: '1.2em', color: 'var(--ed-heading)' },
  { tag: t.heading3, fontWeight: '700', fontSize: '1.1em', color: 'var(--ed-heading)' },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: '700', color: 'var(--ed-heading)' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: [t.link, t.url], color: 'var(--ed-link)' },
  { tag: t.monospace, color: 'var(--ed-code)', fontFamily: 'var(--font-mono)' },
  { tag: t.quote, color: 'var(--ed-quote)', fontStyle: 'italic' },
  { tag: [t.processingInstruction, t.meta, t.contentSeparator], color: 'var(--ed-mark)' },
  // 코드 블록 내부 문법 강조
  { tag: [t.keyword, t.modifier, t.operatorKeyword], color: 'var(--syn-keyword)' },
  { tag: [t.string, t.special(t.string), t.regexp], color: 'var(--syn-string)' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--syn-number)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--syn-func)' },
  { tag: [t.typeName, t.className, t.tagName], color: 'var(--syn-type)' },
  { tag: [t.attributeName, t.propertyName], color: 'var(--syn-attr)' },
]);

const baseTheme = EditorView.theme({
  '&': { height: '100%', fontSize: 'var(--editor-font-size)', backgroundColor: 'var(--bg)', color: 'var(--fg)' },
  '.cm-scroller': { fontFamily: 'var(--font-editor)', lineHeight: '1.75', padding: '0' },
  '.cm-content': { padding: '28px 0 40vh', maxWidth: '860px', margin: '0 auto', caretColor: 'var(--accent)' },
  '.cm-line': { padding: '0 32px' },
  '.cm-gutters': { backgroundColor: 'var(--bg)', color: 'var(--fg-faint)', border: 'none' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--fg-muted)' },
  '.cm-activeLine': { backgroundColor: 'var(--active-line)' },
  '&.cm-focused .cm-cursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--selection) !important' },
  '.cm-selectionMatch': { backgroundColor: 'var(--match)' },
  '.cm-searchMatch': { backgroundColor: 'var(--match)', outline: '1px solid var(--accent-soft)' },
  '.cm-searchMatch-selected': { backgroundColor: 'var(--accent-soft)' },
  '.cm-placeholder': { color: 'var(--fg-faint)' },
  '.cm-panels': { backgroundColor: 'var(--surface)', color: 'var(--fg)', borderColor: 'var(--border)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border)' },
  '.cm-panel.cm-search': { padding: '8px 12px', fontFamily: 'var(--font-ui)', fontSize: '13px' },
  '.cm-panel.cm-search input, .cm-panel.cm-search button': { fontFamily: 'var(--font-ui)' },
});

export function createEditor(parent, { onChange, onScroll, onCursor, onPasteFiles, placeholderText = '여기에 마크다운을 입력하세요…' }) {
  const extensions = [
        history(),
        drawSelection(),
        dropCursor(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        search({ top: true }),
        EditorView.lineWrapping,
        markdown({ base: markdownLanguage, codeLanguages: languages, addKeymap: true }),
        syntaxHighlighting(mdHighlight),
        placeholder(placeholderText),
        keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, indentWithTab]),
        baseTheme,
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChange?.(u);
          if (u.selectionSet || u.docChanged) onCursor?.(u.state);
        }),
        EditorView.domEventHandlers({
          scroll: () => onScroll?.(),
          paste: (e) => {
            const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
            if (!files.length) return false;
            e.preventDefault();
            onPasteFiles?.(files, null);
            return true;
          },
          drop: (e, v) => {
            const files = [...(e.dataTransfer?.files || [])];
            const images = files.filter((f) => f.type.startsWith('image/'));
            if (!images.length) return false;
            e.preventDefault();
            e.stopPropagation();
            const pos = v.posAtCoords({ x: e.clientX, y: e.clientY });
            onPasteFiles?.(images, pos);
            return true;
          },
        }),
  ];
  const view = new EditorView({ parent, state: EditorState.create({ doc: '', extensions }) });
  view.mdExtensions = extensions;
  return view;
}

/** 탭마다 독립된 편집 상태(문서·커서·실행 취소 기록)를 만든다 */
export function createState(view, text) {
  return EditorState.create({ doc: text, extensions: view.mdExtensions });
}

/** 탭을 다른 창으로 옮길 때: 문서·커서·실행 취소 기록을 JSON으로 */
export const serializeState = (state) => state.toJSON({ history: historyField });
export const deserializeState = (view, json) => EditorState.fromJSON(json, { extensions: view.mdExtensions }, { history: historyField });

/** 외부 변경 반영: 실행 취소 가능한 하나의 변경으로 교체, 커서 위치 최대한 유지 */
export function replaceDoc(view, text) {
  const head = Math.min(view.state.selection.main.head, text.length);
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
    selection: EditorSelection.cursor(head),
  });
}

// ───────────────────────── 서식 명령 ─────────────────────────
function wrap(view, before, after = before, placeholderText = '') {
  const { state } = view;
  view.dispatch(
    state.changeByRange((range) => {
      const text = state.sliceDoc(range.from, range.to);
      // 이미 감싸져 있으면 해제
      const outerFrom = range.from - before.length;
      const outerTo = range.to + after.length;
      if (outerFrom >= 0 && state.sliceDoc(outerFrom, range.from) === before && state.sliceDoc(range.to, outerTo) === after) {
        return {
          changes: [
            { from: outerFrom, to: range.from, insert: '' },
            { from: range.to, to: outerTo, insert: '' },
          ],
          range: EditorSelection.range(outerFrom, range.to - before.length),
        };
      }
      const inner = text || placeholderText;
      return {
        changes: { from: range.from, to: range.to, insert: before + inner + after },
        range: EditorSelection.range(range.from + before.length, range.from + before.length + inner.length),
      };
    }),
  );
  view.focus();
}

function selectedLines(state) {
  const lines = new Set();
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number;
    const b = state.doc.lineAt(r.to).number;
    for (let n = a; n <= b; n++) lines.add(n);
  }
  return [...lines].map((n) => state.doc.line(n));
}

const LINE_PREFIX_RE = /^(\s*)(#{1,6}\s+|>\s?|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)?/;

function setLinePrefix(view, makePrefix) {
  const { state } = view;
  const lines = selectedLines(state);
  const changes = [];
  // 모든 줄이 이미 같은 형식이면 해제(토글)
  const allHave = lines.every((line, i) => {
    const m = line.text.match(LINE_PREFIX_RE);
    return (m[2] || '') === makePrefix(i) && makePrefix(i) !== '';
  });
  lines.forEach((line, i) => {
    const m = line.text.match(LINE_PREFIX_RE);
    const from = line.from + m[1].length;
    const to = from + (m[2] || '').length;
    changes.push({ from, to, insert: allHave ? '' : makePrefix(i) });
  });
  view.dispatch({ changes });
  view.focus();
}

function insertBlock(view, text, selectOffset = null, selectLength = 0) {
  const { state } = view;
  const r = state.selection.main;
  const line = state.doc.lineAt(r.from);
  const needsNewlineBefore = line.text.trim() !== '' ? '\n\n' : '';
  const insert = needsNewlineBefore + text + '\n';
  const from = line.text.trim() !== '' ? line.to : line.from;
  const to = line.text.trim() !== '' ? line.to : line.to;
  const base = from + needsNewlineBefore.length;
  view.dispatch({
    changes: { from, to, insert },
    selection: selectOffset == null ? EditorSelection.cursor(from + insert.length) : EditorSelection.range(base + selectOffset, base + selectOffset + selectLength),
    scrollIntoView: true,
  });
  view.focus();
}

export function applyFormat(view, kind) {
  switch (kind) {
    case 'bold':
      return wrap(view, '**', '**', '굵은 글씨');
    case 'italic':
      return wrap(view, '*', '*', '기울임');
    case 'strike':
      return wrap(view, '~~', '~~', '취소선');
    case 'code':
      return wrap(view, '`', '`', 'code');
    case 'link': {
      const r = view.state.selection.main;
      const text = view.state.sliceDoc(r.from, r.to) || '링크 텍스트';
      const insert = `[${text}](https://)`;
      view.dispatch({
        changes: { from: r.from, to: r.to, insert },
        selection: EditorSelection.range(r.from + text.length + 3, r.from + insert.length - 1),
      });
      return view.focus();
    }
    case 'image': {
      const r = view.state.selection.main;
      const alt = view.state.sliceDoc(r.from, r.to) || '이미지 설명';
      const insert = `![${alt}](assets/image.png)`;
      view.dispatch({ changes: { from: r.from, to: r.to, insert }, selection: EditorSelection.range(r.from + alt.length + 4, r.from + insert.length - 1) });
      return view.focus();
    }
    case 'h1':
    case 'h2':
    case 'h3': {
      const n = Number(kind[1]);
      return setLinePrefix(view, () => '#'.repeat(n) + ' ');
    }
    case 'p':
      return setLinePrefix(view, () => '');
    case 'quote':
      return setLinePrefix(view, () => '> ');
    case 'ul':
      return setLinePrefix(view, () => '- ');
    case 'ol':
      return setLinePrefix(view, (i) => `${i + 1}. `);
    case 'task':
      return setLinePrefix(view, () => '- [ ] ');
    case 'hr':
      return insertBlock(view, '---');
    case 'codeblock': {
      const r = view.state.selection.main;
      const sel = view.state.sliceDoc(r.from, r.to);
      if (sel) return wrap(view, '```\n', '\n```');
      return insertBlock(view, '```js\n\n```', 3, 2);
    }
    case 'table':
      return insertBlock(view, '| 항목 | 내용 | 비고 |\n| --- | --- | --- |\n| 셀 | 셀 | 셀 |\n| 셀 | 셀 | 셀 |', 2, 2);
    default:
  }
}

export const editorCommands = {
  undo: (v) => undo(v),
  redo: (v) => redo(v),
  selectAll: (v) => selectAll(v),
  find: (v) => openSearchPanel(v),
};

/** 검색 결과로 이동: 해당 줄의 검색어를 선택하고 화면 가운데로 */
export function revealMatch(view, lineIndex, query) {
  const doc = view.state.doc;
  const line = doc.line(Math.min(Math.max(lineIndex, 0), doc.lines - 1) + 1);
  const text = line.text.normalize('NFC').toLocaleLowerCase();
  const at = query ? text.indexOf(query.normalize('NFC').toLocaleLowerCase()) : -1;
  const from = at >= 0 ? line.from + at : line.from;
  const to = at >= 0 ? from + query.length : line.from;
  view.dispatch({ selection: EditorSelection.range(from, to), effects: EditorView.scrollIntoView(from, { y: 'center' }) });
  view.focus();
}

/** 미리보기의 체크박스 클릭 → 원본 줄의 [ ] ↔ [x] 토글 */
export function toggleTaskAtLine(view, lineIndex) {
  const line = view.state.doc.line(lineIndex + 1);
  const m = line.text.match(/^(\s*[-*+]\s+\[)([ xX])(\])/);
  if (!m) return false;
  const pos = line.from + m[1].length;
  view.dispatch({ changes: { from: pos, to: pos + 1, insert: m[2] === ' ' ? 'x' : ' ' } });
  return true;
}
