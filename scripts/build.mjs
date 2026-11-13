import './check-node.mjs';
// Set this before importing Vite: the desktop terminal can inherit development mode.
process.env.NODE_ENV = 'production';
const { build } = await import('vite');
await build({ mode: 'production' });

// 产出离线预缓存清单：让 Service Worker 在安装阶段缓存全部懒加载 chunk，
// 断网时首次切换到任何页签都能加载（否则动态 import 会 504）。
const { readdirSync, statSync, writeFileSync } = await import('node:fs');
const { join, relative } = await import('node:path');
const dist = 'dist';
const urls = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else urls.push('/' + relative(dist, full).split('\\').join('/'));
  }
};
walk(join(dist, 'assets'));
for (const extra of ['fonts', 'data']) {
  const dir = join(dist, extra);
  try { walk(dir); } catch { /* 目录不存在则跳过 */ }
}
writeFileSync(join(dist, 'precache-manifest.json'), JSON.stringify({ version: Date.now(), urls }, null, 1));
console.log('precache manifest:', urls.length, 'urls');
