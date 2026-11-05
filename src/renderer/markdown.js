// 마크다운 → 안전한 HTML.
// markdown-it + 플러그인(각주·정의 목록·약어·체크리스트·KaTeX) + highlight.js 구성에
// 소스 줄 번호(data-line, 스크롤 동기화·체크박스 토글용)와 Mermaid를 더했다.
import MarkdownIt from 'markdown-it';
import footnote from 'markdown-it-footnote';
import deflist from 'markdown-it-deflist';
import abbr from 'markdown-it-abbr';
import taskLists from 'markdown-it-task-lists';
import katexPlugin from '@vscode/markdown-it-katex';
import hljs from 'highlight.js/lib/common';
import DOMPurify from 'dompurify';

const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const md = new MarkdownIt({ html: true, linkify: true, typographer: false, breaks: false });
md.use(footnote)
  .use(deflist)
  .use(abbr)
  .use(taskLists, { enabled: true })
  .use(katexPlugin.default ?? katexPlugin, { throwOnError: false });

// 블록 토큰에 원본 줄 번호를 심는다.
md.core.ruler.push('source_line', (state) => {
  for (const token of state.tokens) {
    if (token.map && token.nesting !== -1 && token.level === 0) token.attrSet('data-line', String(token.map[0]));
    if (token.map && token.type === 'list_item_open') token.attrSet('data-line', String(token.map[0]));
  }
});

md.renderer.rules.fence = (tokens, idx) => {
  const token = tokens[idx];
  const lang = token.info.trim().split(/\s+/)[0].toLowerCase();
  const line = token.map ? ` data-line="${token.map[0]}"` : '';
  const code = token.content;
  if (lang === 'mermaid') {
    return `<div class="mermaid-block"${line} data-src="${escapeHtml(encodeURIComponent(code))}"><pre class="mermaid-src">${escapeHtml(code)}</pre></div>`;
  }
  let body;
  if (lang && hljs.getLanguage(lang)) {
    try {
      body = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    } catch {
      body = escapeHtml(code);
    }
  } else {
    body = escapeHtml(code);
  }
  const label = lang ? `<span class="code-lang">${escapeHtml(lang)}</span>` : '';
  return `<pre class="code-block"${line}>${label}<button class="copy-btn" type="button" title="복사">복사</button><code class="hljs${lang ? ` language-${escapeHtml(lang)}` : ''}">${body}</code></pre>\n`;
};

// 외부 링크는 새 창(=시스템 브라우저)으로
const defaultLinkOpen = md.renderer.rules.link_open || ((t, i, o, e, s) => s.renderToken(t, i, o));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const href = tokens[idx].attrGet('href') || '';
  if (/^https?:/i.test(href)) tokens[idx].attrSet('target', '_blank');
  return defaultLinkOpen(tokens, idx, options, env, self);
};

/** 한글/영문 혼용 제목에서도 안정적인 앵커 id */
export function slugify(text, used) {
  let slug = text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-');
  if (!slug) slug = 'section';
  let unique = slug;
  for (let i = 1; used.has(unique); i++) unique = `${slug}-${i}`;
  used.add(unique);
  return unique;
}

export function renderMarkdown(source) {
  const html = md.render(source);
  return DOMPurify.sanitize(html, {
    ADD_ATTR: ['target', 'data-line', 'data-src'],
    ADD_TAGS: ['input'],
  });
}

// ───────── Mermaid (지연 로드 + 결과 캐시) ─────────
let mermaidLoading = null;
const svgCache = new Map();
let mermaidSeq = 0;

function loadMermaid() {
  if (window.mermaid) return Promise.resolve(window.mermaid);
  if (!mermaidLoading) {
    mermaidLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = new URL('vendor/mermaid.min.js', document.baseURI).href;
      s.onload = () => resolve(window.mermaid);
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }
  return mermaidLoading;
}

export async function renderMermaid(container, dark) {
  const blocks = container.querySelectorAll('.mermaid-block');
  if (!blocks.length) return;
  const mermaid = await loadMermaid();
  const theme = dark ? 'dark' : 'default';
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme, fontFamily: 'inherit' });
  for (const block of blocks) {
    const code = decodeURIComponent(block.dataset.src || '');
    const key = `${theme}\n${code}`;
    let svg = svgCache.get(key);
    if (!svg) {
      try {
        ({ svg } = await mermaid.render(`mmd-${++mermaidSeq}`, code));
        svgCache.set(key, svg);
        if (svgCache.size > 100) svgCache.delete(svgCache.keys().next().value);
      } catch (err) {
        block.classList.add('mermaid-error');
        block.innerHTML = `<pre>Mermaid 오류: ${escapeHtml(String(err.message || err))}</pre>`;
        document.getElementById(`dmmd-${mermaidSeq}`)?.remove();
        continue;
      }
    }
    if (block.isConnected) block.innerHTML = svg;
  }
}
