import './check-node.mjs';
// Set this before importing Vite: the desktop terminal can inherit development mode.
process.env.NODE_ENV = 'production';
const { createHash } = await import('node:crypto');
const { build } = await import('vite');
await build({ mode: 'production' });

// 产出离线预缓存清单：让 Service Worker 在安装阶段缓存全部懒加载 chunk，
// 断网时首次切换到任何页签都能加载（否则动态 import 会 504）。
const { readdirSync, readFileSync, statSync, writeFileSync } = await import('node:fs');
const { join, relative } = await import('node:path');
const dist = 'dist';
const files = [];
const urls = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else {
      files.push(full);
      urls.push('/' + relative(dist, full).split('\\').join('/'));
    }
  }
};
walk(join(dist, 'assets'));
for (const extra of ['fonts', 'data', 'favicon.svg']) {
  const target = join(dist, extra);
  try {
    if (statSync(target).isDirectory()) walk(target);
    else {
      files.push(target);
      urls.push('/' + relative(dist, target).split('\\').join('/'));
    }
  } catch { /* 文件/目录不存在则跳过 */ }
}
// SW 的字节内容决定版本号：任何外壳、懒加载 chunk、字体或快照变化都会触发浏览器升级，
// 避免 manifest 变了但 VERSION 固定导致旧 SW 继续拦截离线请求。
const swPath = join(dist, 'sw.js');
const sw = readFileSync(swPath, 'utf8');
const hash = createHash('sha256');
for (const file of files.sort()) hash.update(relative(dist, file)).update(readFileSync(file));
hash.update(readFileSync(join(dist, 'index.html')));
hash.update(sw);
const version = 'topicscope-' + hash.digest('hex').slice(0, 12);
if (!sw.includes('const VERSION = "topicscope-v2";')) throw new Error('Service Worker 版本占位符已变化，请同步构建脚本');
writeFileSync(swPath, sw.replace('const VERSION = "topicscope-v2";', `const VERSION = "${version}";`));
writeFileSync(join(dist, 'precache-manifest.json'), JSON.stringify({ version, urls }, null, 1));
console.log('precache manifest:', urls.length, 'urls; service worker:', version);
