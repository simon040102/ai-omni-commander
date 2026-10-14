// 打包 Jev MCP 獨立發佈版：server/src/jev/standalone-entry.ts → release/jev-mcp.mjs（單檔、零依賴，只要 Node 20+）
// 再把安裝腳本與說明一起放進 release/，Windows 上順便壓成 release/jev-mcp.zip。
// 用法（repo 根目錄）：pnpm build:jev-mcp
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const out = path.join(here, 'release');
const version = JSON.parse(readFileSync(path.join(here, 'package.json'), 'utf8')).version;

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const result = await build({
  entryPoints: [path.join(repo, 'server', 'src', 'jev', 'standalone-entry.ts')],
  outfile: path.join(out, 'jev-mcp.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  minify: false,
  legalComments: 'none',
  // 部分 CJS 依賴在 ESM bundle 裡會呼叫 require
  banner: { js: `// Jev MCP v${version} — https://typesafe.ai （由 ai-omni-commander 打包）\nimport { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);` },
  metafile: true,
  logLevel: 'warning',
});

// 防呆：獨立版絕不可帶進原生模組或 omni 的 DB 程式
const inputs = Object.keys(result.metafile.inputs);
const forbidden = inputs.filter(f => /better-sqlite3|omni-key|mcp[\\/]db\.ts/.test(f));
if (forbidden.length > 0) {
  console.error('獨立版不可包含：\n' + forbidden.join('\n'));
  process.exit(1);
}

for (const f of ['install.ps1', 'install.cmd', 'install.sh', 'README.md']) {
  cpSync(path.join(here, f), path.join(out, f));
}

if (process.platform === 'win32') {
  const zip = path.join(here, 'jev-mcp.zip');
  rmSync(zip, { force: true });
  const r = spawnSync('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${out}\\*' -DestinationPath '${zip}'`], { stdio: 'inherit' });
  if (r.status === 0 && existsSync(zip)) console.log(`zip: ${zip}`);
}
const kb = (readFileSync(path.join(out, 'jev-mcp.mjs')).length / 1024).toFixed(0);
console.log(`built release/jev-mcp.mjs (${kb} KB, ${inputs.length} modules)`);
