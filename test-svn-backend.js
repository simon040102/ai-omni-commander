const { execSync } = require('child_process');
const iconv = require('iconv-lite');
const path = require('path');

const svnPath = 'C:/Program Files/TortoiseSVN/bin/svn.exe';
const username = 'simonhuang';
const password = 'Pchome2313678023056';
const authArgs = `--username "${username}" --password "${password}" --non-interactive --trust-server-cert --no-auth-cache`;

// Normalize the VisualSVN URL
const rawUrl = 'https://svn01.universalec.com.tw/!/#UEC-F%E7%99%BC%E7%A5%A8%E5%B9%B3%E5%8F%B0Oracle/view/head/3-SD/6-%E7%A8%8B%E5%BC%8F%E8%A6%8F%E6%A0%BC(%E5%BE%8C%E7%AB%AFAPI-SPEC)';
const match = rawUrl.match(/^(https?:\/\/[^/]+)\/!\/(?:#|%23)([^/]+)\/view\/head\/?(.*)?$/i);
let backendRoot;
if (match) {
  const [, origin, repo, rest] = match;
  backendRoot = rest ? `${origin}/svn/${decodeURIComponent(repo)}/${decodeURIComponent(rest)}` : `${origin}/svn/${decodeURIComponent(repo)}`;
}
console.log('Backend root:', backendRoot);

const SPEC_EXTENSIONS = new Set(['.docx', '.doc', '.pdf', '.md', '.txt']);

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function svnList(url, recursive = false) {
  const rFlag = recursive ? ' -R' : '';
  const cmd = `"${svnPath}" list${rFlag} "${url}" ${authArgs}`;
  const buf = execSync(cmd, { encoding: 'buffer', timeout: 60000, maxBuffer: 10 * 1024 * 1024 });
  const utf8 = buf.toString('utf-8');
  if (!utf8.includes('\uFFFD')) return utf8;
  return iconv.decode(buf, 'cp950');
}

// Extract function code from "OV02.需檢核有相同匯率，才可合併產生草稿-前端"
const parentName = 'OV02.需檢核有相同匯率，才可合併產生草稿';
const codeMatch = parentName.match(/\b([A-Za-z]{2,}[0-9]*)\b/);
const functionCode = codeMatch ? codeMatch[1].toUpperCase() : null;
const rootCode = functionCode ? functionCode.match(/^[A-Z]+/)?.[0] : null;

console.log('parentName:', parentName);
console.log('functionCode:', functionCode);
console.log('rootCode:', rootCode);

// Step 1: List top-level
console.log('\n=== Backend SVN top-level ===');
const topText = svnList(backendRoot);
const folders = topText.split('\n').map(l => l.trim()).filter(Boolean);
console.log(folders.join('\n'));

// Find OV folder
const ovFolder = folders.find(f => {
  const upper = f.toUpperCase();
  return upper.startsWith(rootCode + '.') || upper.startsWith(rootCode + '_') || upper.startsWith(rootCode + '/');
});
console.log('\nMatched folder:', ovFolder || 'NOT FOUND');

if (ovFolder) {
  const folderName = ovFolder.endsWith('/') ? ovFolder.slice(0, -1) : ovFolder;
  const folderUrl = `${backendRoot}/${folderName}`;
  console.log('\n=== Recursive list ===');
  const allText = svnList(folderUrl, true);
  const allFiles = allText.split('\n').map(l => l.trim()).filter(Boolean);

  // Match with new logic
  const codePattern = new RegExp(`(?<![A-Z0-9])${escapeRegex(functionCode)}(?![0-9])`, 'i');
  const matched = [];
  for (const file of allFiles) {
    if (file.endsWith('/')) continue;
    const ext = path.extname(file).toLowerCase();
    if (!SPEC_EXTENSIONS.has(ext)) continue;
    const parts = file.split('/');
    if (parts.some(p => p.toLowerCase() === 'old')) continue;

    const basename = path.basename(file);
    if (codePattern.test(basename)) { matched.push(file); continue; }
    if (parts.length > 1 && codePattern.test(parts[0])) { matched.push(file); continue; }
  }

  console.log('\n=== Files matching', functionCode, '===');
  if (matched.length > 0) {
    matched.forEach(f => console.log(' ', f));
  } else {
    console.log('  No matches found');
    console.log('\nAll files for reference:');
    allFiles.slice(0, 30).forEach(f => console.log(' ', f));
  }
}
