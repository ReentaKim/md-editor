// 표 편집 도우미
// - 표 안에서 Tab / Shift+Tab: 다음·이전 셀로 이동 (마지막 셀에서 Tab → 새 행)
// - 표 안에서 Enter: 아래 행의 같은 열로 (마지막 행이면 새 행, 빈 마지막 행이면 표 밖으로)
// - 이동할 때마다 열 너비를 맞춘다 (한글·한자·이모지는 폭 2로 계산)
// - 행/열 추가·삭제, 열 정렬(왼쪽/가운데/오른쪽)
import { EditorSelection } from '@codemirror/state';
import { syntaxTree, ensureSyntaxTree } from '@codemirror/language';

// ───────── 글자 폭 ─────────
function charWidth(cp) {
  if (cp === 0x200d || (cp >= 0x300 && cp <= 0x36f) || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0; // 결합 문자·변형 선택자
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // 한글 자모
    (cp >= 0x2e80 && cp <= 0xa4cf) || // CJK·한글 호환 자모·히라가나 등
    (cp >= 0xac00 && cp <= 0xd7a3) || // 한글 음절
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) || // 전각 문자
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) || // 이모지
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
    return 2;
  return 1;
}
export function textWidth(s) {
  let w = 0;
  for (const ch of s) w += charWidth(ch.codePointAt(0));
  return w;
}

// ───────── 표 읽기 ─────────
const DELIM_CELL = /^\s*:?-+:?\s*$/;

/** 한 줄을 셀로 나눈다. `\|`와 `코드` 안의 |는 구분자가 아니다. 셀마다 줄 안의 시작·끝 위치도 돌려준다. */
function splitRow(text) {
  const cells = [];
  let start = 0;
  let inCode = false;
  const trimmed = text.replace(/\s+$/, '');
  let i = 0;
  const lead = trimmed.match(/^\s*\|/);
  if (lead) start = i = lead[0].length;
  for (; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '`') inCode = !inCode;
    else if (ch === '|' && !inCode) {
      cells.push({ text: trimmed.slice(start, i), from: start, to: i });
      start = i + 1;
    }
  }
  // 끝에 |가 없으면 마지막 셀이 남는다
  if (start < trimmed.length || !cells.length) cells.push({ text: trimmed.slice(start), from: start, to: trimmed.length });
  return cells;
}

function alignOf(cell) {
  const t = cell.trim();
  const l = t.startsWith(':');
  const r = t.endsWith(':');
  return l && r ? 'center' : r ? 'right' : l ? 'left' : '';
}

/** 커서가 있는 표를 찾는다 → { from, to, rows: string[][], aligns, row, col } 또는 null */
export function tableAt(state, pos = state.selection.main.head) {
  const tree = ensureSyntaxTree(state, Math.min(state.doc.length, pos + 5000), 100) ?? syntaxTree(state);
  let node = tree.resolveInner(pos, -1);
  while (node && node.name !== 'Table') node = node.parent;
  if (!node) {
    // 줄 끝(마지막 | 뒤)에 커서가 있으면 바로 앞 글자 기준으로 찾지 못할 수 있어 줄 시작으로 다시 확인
    const line = state.doc.lineAt(pos);
    node = tree.resolveInner(line.from, 1);
    while (node && node.name !== 'Table') node = node.parent;
    if (!node) return null;
  }
  const first = state.doc.lineAt(node.from);
  const last = state.doc.lineAt(node.to);
  const lines = [];
  for (let n = first.number; n <= last.number; n++) lines.push(state.doc.line(n));
  // 마지막 줄이 비어 있으면(표 바로 뒤 빈 줄) 제외
  while (lines.length > 2 && !lines[lines.length - 1].text.trim()) lines.pop();
  if (lines.length < 2 || !splitRow(lines[1].text).every((c) => DELIM_CELL.test(c.text))) return null;

  const parsed = lines.map((l) => splitRow(l.text));
  const cols = Math.max(...parsed.map((r) => r.length));
  const aligns = Array.from({ length: cols }, (_, i) => (parsed[1][i] ? alignOf(parsed[1][i].text) : ''));
  const rows = parsed.filter((_, i) => i !== 1).map((r) => Array.from({ length: cols }, (_, i) => (r[i] ? r[i].text.trim() : '')));

  // 커서의 행·열
  const curLine = state.doc.lineAt(pos);
  const lineIndex = Math.min(Math.max(curLine.number - first.number, 0), lines.length - 1);
  const col0 = pos - lines[lineIndex].from;
  const cellsHere = parsed[lineIndex];
  let col = cellsHere.findIndex((c) => col0 <= c.to);
  if (col < 0) col = cellsHere.length - 1;
  // rows에는 구분선 줄이 없으므로: 0 = 머리글, 1.. = 본문 (구분선 줄에 있으면 첫 본문 행 앞으로 본다)
  const row = lineIndex === 0 ? 0 : lineIndex === 1 ? 0.5 : lineIndex - 1;
  return { from: first.from, to: lines[lines.length - 1].to, rows, aligns, row, col: Math.min(col, cols - 1) };
}

// ───────── 표 쓰기 ─────────
/** 정렬에 맞춰 공백을 채운다 → { str, lead: 내용 앞 공백 수 } */
function pad(text, width, align) {
  const gap = Math.max(0, width - textWidth(text));
  const lead = align === 'right' ? gap : align === 'center' ? Math.floor(gap / 2) : 0;
  return { str: ' '.repeat(lead) + text + ' '.repeat(gap - lead), lead };
}

/** 표를 열 너비에 맞춰 다시 쓴다 → { text, cellAt(row, col) = 표 시작 기준 셀 내용 위치 } */
export function formatTable(rows, aligns) {
  const cols = aligns.length;
  const widths = Array.from({ length: cols }, (_, c) => Math.max(3, ...rows.map((r) => textWidth(r[c] ?? ''))));
  const out = [];
  const starts = []; // starts[row][col] = 셀 내용 시작 위치(표 시작 기준)
  let offset = 0;
  const writeRow = (cells, rowIndex) => {
    let line = '|';
    const s = [];
    for (let c = 0; c < cols; c++) {
      line += ' ';
      const text = cells[c] ?? '';
      const { str, lead } = pad(text, widths[c], aligns[c]);
      s.push(offset + line.length + lead);
      line += str + ' |';
    }
    if (rowIndex != null) starts[rowIndex] = s;
    out.push(line);
    offset += line.length + 1;
  };
  writeRow(rows[0], 0);
  const delim = aligns.map((a, c) => {
    const w = widths[c];
    if (a === 'center') return ':' + '-'.repeat(w - 2) + ':';
    if (a === 'right') return '-'.repeat(w - 1) + ':';
    if (a === 'left') return ':' + '-'.repeat(w - 1);
    return '-'.repeat(w);
  });
  out.push('| ' + delim.join(' | ') + ' |');
  offset += out[1].length + 1;
  for (let r = 1; r < rows.length; r++) writeRow(rows[r], r);
  return { text: out.join('\n'), cellAt: (r, c) => starts[r][c] };
}

/** 표를 고쳐 쓰고 (row, col) 셀로 커서를 옮긴다. 셀에 글자가 있으면 선택한다. */
function commit(view, t, rows, aligns, row, col, extra = {}) {
  const { text, cellAt } = formatTable(rows, aligns);
  const at = t.from + cellAt(row, col);
  const len = (rows[row][col] ?? '').length;
  view.dispatch({
    changes: { from: t.from, to: t.to, insert: text },
    selection: EditorSelection.range(at, at + len),
    scrollIntoView: true,
    userEvent: 'input',
    ...extra,
  });
  return true;
}

const emptyRow = (cols) => Array.from({ length: cols }, () => '');

// ───────── 키 ─────────
export function tableNextCell(view) {
  const t = tableAt(view.state);
  if (!t) return false;
  const rows = t.rows.map((r) => [...r]);
  const cols = t.aligns.length;
  let row = Math.ceil(t.row);
  let col = t.row === 0.5 ? 0 : t.col + 1;
  if (t.row === 0.5) row = 1;
  if (col >= cols) {
    col = 0;
    row++;
  }
  if (row >= rows.length) rows.push(emptyRow(cols));
  return commit(view, t, rows, t.aligns, row, col);
}

export function tablePrevCell(view) {
  const t = tableAt(view.state);
  if (!t) return false;
  let row = Math.floor(t.row);
  let col = t.row === 0.5 ? t.aligns.length : t.col - 1;
  if (col < 0) {
    if (row === 0) return commit(view, t, t.rows, t.aligns, 0, 0);
    row--;
    col = t.aligns.length - 1;
  }
  return commit(view, t, t.rows, t.aligns, row, Math.min(col, t.aligns.length - 1));
}

export function tableEnter(view) {
  const t = tableAt(view.state);
  if (!t || view.state.selection.ranges.length > 1) return false;
  const rows = t.rows.map((r) => [...r]);
  const cols = t.aligns.length;
  const row = Math.ceil(t.row);
  const isLast = row === rows.length - 1;
  // 비어 있는 마지막 본문 행에서 Enter → 그 행을 지우고 표 밖으로
  if (isLast && row > 0 && rows[row].every((c) => !c)) {
    rows.pop();
    // 표 다음에는 빈 줄이 있어야 이어 쓰는 글이 표의 행으로 읽히지 않는다
    // (이미 빈 줄이 있으면 한 줄만 더해서 커서를 빈 줄 아래에 둔다)
    const { text } = formatTable(rows, t.aligns);
    const blankAfter = view.state.sliceDoc(t.to, t.to + 2) === '\n\n';
    view.dispatch({
      changes: { from: t.from, to: t.to, insert: text + (blankAfter ? '\n' : '\n\n') },
      selection: EditorSelection.cursor(t.from + text.length + 2),
      scrollIntoView: true,
      userEvent: 'input',
    });
    return true;
  }
  if (isLast) rows.push(emptyRow(cols));
  return commit(view, t, rows, t.aligns, row + 1, t.row === 0.5 ? 0 : t.col);
}

// ───────── 메뉴 명령 ─────────
/** @returns {string|null} 실패하면 사용자에게 보여 줄 문장 */
export function tableCommand(view, op) {
  const t = tableAt(view.state);
  if (!t) return '표 안에 커서를 두고 사용하세요';
  const rows = t.rows.map((r) => [...r]);
  const aligns = [...t.aligns];
  const cols = aligns.length;
  const row = Math.ceil(t.row);
  const col = t.col;
  switch (op) {
    case 'rowAbove':
      if (row === 0) return '머리글 위에는 행을 추가할 수 없습니다';
      rows.splice(row, 0, emptyRow(cols));
      commit(view, t, rows, aligns, row, col);
      return null;
    case 'rowBelow':
      rows.splice(row + 1, 0, emptyRow(cols));
      commit(view, t, rows, aligns, row + 1, col);
      return null;
    case 'colLeft':
    case 'colRight': {
      const at = op === 'colLeft' ? col : col + 1;
      rows.forEach((r) => r.splice(at, 0, ''));
      aligns.splice(at, 0, '');
      commit(view, t, rows, aligns, row, at);
      return null;
    }
    case 'deleteRow':
      if (row === 0) return '머리글 행은 지울 수 없습니다';
      rows.splice(row, 1);
      commit(view, t, rows, aligns, Math.min(row, rows.length - 1), col);
      return null;
    case 'deleteCol':
      if (cols === 1) return '열이 하나뿐이라 지울 수 없습니다';
      rows.forEach((r) => r.splice(col, 1));
      aligns.splice(col, 1);
      commit(view, t, rows, aligns, row, Math.min(col, cols - 2));
      return null;
    case 'alignLeft':
    case 'alignCenter':
    case 'alignRight':
      aligns[col] = { alignLeft: 'left', alignCenter: 'center', alignRight: 'right' }[op];
      commit(view, t, rows, aligns, row, col);
      return null;
    case 'format':
      commit(view, t, rows, aligns, row, col);
      return null;
    default:
      return null;
  }
}
