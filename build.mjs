// 렌더러 번들 + 정적 파일/벤더 복사.
// 오프라인에서도 동작하도록 렌더링 의존성을 모두 dist/ 안에 로컬로 포함시킨다(CDN 사용 안 함).
import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';

const watch = process.argv.includes('--watch');

await rm('dist', { recursive: true, force: true });
await mkdir('dist/vendor', { recursive: true });

await Promise.all([
  cp('src/renderer/index.html', 'dist/index.html'),
  cp('src/renderer/styles.css', 'dist/styles.css'),
  cp('src/renderer/sample.md', 'dist/sample.md'),
  cp('node_modules/katex/dist/katex.min.css', 'dist/vendor/katex/katex.min.css'),
  cp('node_modules/katex/dist/fonts', 'dist/vendor/katex/fonts', { recursive: true }),
  // Mermaid는 무거워서(5MB) 문서에 mermaid 블록이 있을 때만 지연 로드한다.
  cp('node_modules/mermaid/dist/mermaid.min.js', 'dist/vendor/mermaid.min.js'),
]);

const options = {
  entryPoints: ['src/renderer/app.js'],
  bundle: true,
  outfile: 'dist/app.js',
  format: 'iife',
  platform: 'browser',
  target: 'chrome130',
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  loader: { '.css': 'text' },
  logLevel: 'info',
};

if (watch) {
  const { context } = await import('esbuild');
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
}
