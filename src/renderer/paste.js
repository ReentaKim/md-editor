// 붙여넣기 도우미
// - 웹·Confluence·Notion·Word·구글 문서에서 복사한 서식 있는 글(HTML)을 마크다운으로 바꿔 넣는다.
// - 글자를 선택한 채 URL을 붙여넣으면 [선택한 글자](URL) 링크로 만든다.
// - 코드 블록 안이거나, 서식이 없는 글이면 평소처럼 일반 텍스트로 붙여넣는다.
import TurndownService from 'turndown';
import { gfm } from '@joplin/turndown-plugin-gfm';
import DOMPurify from 'dompurify';
import { syntaxTree } from '@codemirror/language';

// 이런 요소가 하나라도 있어야 "서식 있는 글"로 본다. 없으면 일반 텍스트로 붙여넣는다.
// (VS Code 같은 편집기는 색만 입힌 span으로 HTML을 만들기 때문에 여기서 걸러진다)
const STRUCTURE = 'h1,h2,h3,h4,h5,h6,ul,ol,table,a[href],strong,b,em,i,blockquote,pre,img,hr,del,s,strike';
const CODE_NODES = new Set(['FencedCode', 'CodeBlock', 'InlineCode', 'CodeText', 'HTMLBlock', 'CommentBlock']);
const URL_RE = /^https?:\/\/[^\s<>"]+$/i;

const styleOf = (n) => (n.getAttribute?.('style') || '').toLowerCase();
const isBoldStyle = (s) => /font-weight:\s*(bold|[6-9]00)\b/.test(s);
const isItalicStyle = (s) => /font-style:\s*italic\b/.test(s);
const isStrikeStyle = (s) => /text-decoration[^;]*line-through/.test(s);

/** 조상 중에 이미 같은 서식이 있으면 다시 감싸지 않는다 (****굵게**** 방지) */
function hasAncestor(node, test) {
  for (let p = node.parentNode; p && p.nodeType === 1; p = p.parentNode) if (test(p)) return true;
  return false;
}
const boldEl = (n) => (['B', 'STRONG'].includes(n.nodeName) && !/font-weight:\s*(normal|[1-4]00)\b/.test(styleOf(n))) || (n.nodeName === 'SPAN' && isBoldStyle(styleOf(n)));
const italicEl = (n) => ['I', 'EM'].includes(n.nodeName) || (n.nodeName === 'SPAN' && isItalicStyle(styleOf(n)));

/** 앞뒤 공백은 기호 바깥에 둔다: "** 굵게 **"는 마크다운에서 굵게가 아니다 */
function surround(content, mark) {
  const m = content.match(/^(\s*)([\s\S]*?)(\s*)$/);
  return m[2] ? `${m[1]}${mark}${m[2]}${mark}${m[3]}` : content;
}

let service = null;
function turndown() {
  if (service) return service;
  const td = new TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
    strongDelimiter: '**',
  });
  td.use(gfm);
  td.remove(['style', 'script', 'noscript', 'meta', 'title', 'head', 'template']);

  // 구글 문서는 내용 전체를 <b style="font-weight:normal">로 감싼다 → 굵게가 아님
  td.addRule('notBold', {
    filter: (n) => ['B', 'STRONG'].includes(n.nodeName) && /font-weight:\s*(normal|[1-4]00)\b/.test(styleOf(n)),
    replacement: (content) => content,
  });
  td.addRule('strongOnce', {
    filter: (n) => boldEl(n) && hasAncestor(n, boldEl),
    replacement: (content) => content,
  });
  td.addRule('emOnce', {
    filter: (n) => italicEl(n) && hasAncestor(n, italicEl),
    replacement: (content) => content,
  });
  // 구글 문서·Word는 굵게/기울임/취소선을 <span style>로 표시한다
  td.addRule('styledSpan', {
    filter: (n) => n.nodeName === 'SPAN' && (isBoldStyle(styleOf(n)) || isItalicStyle(styleOf(n)) || isStrikeStyle(styleOf(n))),
    replacement: (content, n) => {
      const s = styleOf(n);
      let out = content;
      if (isStrikeStyle(s)) out = surround(out, '~~');
      if (isItalicStyle(s) && !hasAncestor(n, italicEl)) out = surround(out, '*');
      if (isBoldStyle(s) && !hasAncestor(n, boldEl)) out = surround(out, '**');
      return out;
    },
  });
  // 목록 기호 뒤 공백은 한 칸: "-   항목" 대신 "- 항목", 하위 항목은 기호 너비만큼 들여쓰기
  td.addRule('listItem', {
    filter: 'li',
    replacement: (content, node) => {
      const parent = node.parentNode;
      let prefix = '- ';
      if (parent.nodeName === 'OL') {
        const start = Number(parent.getAttribute('start')) || 1;
        prefix = `${start + [...parent.children].indexOf(node)}. `;
      }
      const isParagraph = /\n$/.test(content);
      let body = content.replace(/^\n+/, '').replace(/\n+$/, '') + (isParagraph ? '\n' : '');
      body = body.replace(/^(\[[ xX]\]) +/, '$1 '); // 체크박스 뒤 공백 한 칸
      return prefix + body.replace(/\n/g, '\n' + ' '.repeat(prefix.length)) + (node.nextSibling ? '\n' : '');
    },
  });
  // data: 이미지(수 MB의 base64)가 문서에 통째로 들어가지 않도록 대체 텍스트만 남긴다
  td.addRule('dataImage', {
    filter: (n) => n.nodeName === 'IMG' && /^data:/i.test(n.getAttribute('src') || ''),
    replacement: (_c, n) => n.getAttribute('alt') || '',
  });
  service = td;
  return td;
}

/** HTML → 마크다운. 서식 있는 글이 아니면 null */
export function htmlToMarkdown(html) {
  const body = DOMPurify.sanitize(html, { RETURN_DOM: true, WHOLE_DOCUMENT: false });
  if (!body.textContent.trim() && !body.querySelector('img')) return null;
  const hasStructure = body.querySelector(STRUCTURE) || [...body.querySelectorAll('span[style]')].some((s) => isBoldStyle(styleOf(s)) || isItalicStyle(styleOf(s)));
  if (!hasStructure) return null;
  // 엑셀·구글 시트 표는 머리글(<th>)이 없다 → 첫 행을 머리글로 써야 마크다운 표가 된다
  // (브라우저가 끼워 넣는 <colgroup>·<tbody> 때문에 첫 행을 <thead>로 옮겨야 머리글로 인식된다)
  for (const table of body.querySelectorAll('table')) {
    if (table.querySelector('thead')) continue;
    const first = table.querySelector('tr');
    if (!first || (table.querySelector('th') && [...first.children].some((c) => c.nodeName !== 'TH'))) continue;
    for (const td of [...first.children]) {
      if (td.nodeName === 'TH') continue;
      const th = body.ownerDocument.createElement('th');
      th.append(...td.childNodes);
      td.replaceWith(th);
    }
    table.querySelectorAll('colgroup, col').forEach((n) => n.remove());
    const thead = body.ownerDocument.createElement('thead');
    thead.append(first);
    table.prepend(thead);
  }
  // IDE에서 복사한 코드처럼 내용 전체가 <pre> 하나뿐이면 코드를 그대로 붙여넣는다
  const pres = body.querySelectorAll('pre');
  if (pres.length === 1 && pres[0].textContent.trim() === body.textContent.trim()) return null;
  const md = turndown()
    .turndown(body)
    .replace(/ /g, ' ')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return md || null;
}

function inCode(state, pos) {
  for (let n = syntaxTree(state).resolveInner(pos, -1); n; n = n.parent) if (CODE_NODES.has(n.name)) return true;
  return false;
}

/** 편집기 paste 이벤트 처리. 직접 넣었으면 true (기본 붙여넣기 취소) */
export function handlePaste(view, data) {
  if (!data) return false;
  const { state } = view;
  const sel = state.selection.main;
  if (state.selection.ranges.length > 1 || inCode(state, sel.from)) return false;

  const text = data.getData('text/plain') || '';
  let insert = null;

  // 글자를 선택한 채 URL을 붙여넣으면 링크로
  const url = text.trim();
  const selected = state.sliceDoc(sel.from, sel.to);
  if (!sel.empty && URL_RE.test(url) && !selected.includes('\n') && !URL_RE.test(selected.trim())) {
    insert = `[${selected}](${url})`;
  } else {
    const html = data.getData('text/html');
    if (html) insert = htmlToMarkdown(html);
  }
  if (insert == null) return false;

  view.dispatch(state.replaceSelection(insert), { userEvent: 'input.paste', scrollIntoView: true });
  return true;
}
