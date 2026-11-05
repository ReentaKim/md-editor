// DMG 빌드 후 남는 압축 해제본(.app)을 지운다.
// 남겨두면 Spotlight/Launchpad에 "MD Editor"가 여러 개 보이기 때문.
import { readdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
const { version } = JSON.parse(await (await import('node:fs/promises')).readFile('package.json', 'utf8'));
const outDir = path.resolve('release', version);

for (const entry of await readdir(outDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const dir = path.join(outDir, entry.name);
  if (entry.name.startsWith('mac')) {
    for (const app of (await readdir(dir)).filter((n) => n.endsWith('.app'))) {
      try { execFileSync(LSREGISTER, ['-u', path.join(dir, app)]); } catch { /* 등록 안 된 경우 무시 */ }
    }
  }
  if (entry.name.startsWith('mac') || entry.name === '.icon-icns') await rm(dir, { recursive: true, force: true });
}
console.log(`정리 완료: ${outDir} 에는 DMG만 남았습니다`);
