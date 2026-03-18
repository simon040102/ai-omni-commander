const { execSync } = require('child_process');
const iconv = require('iconv-lite');
const path = require('path');

const svnPath = 'C:/Program Files/TortoiseSVN/bin/svn.exe';
const username = 'simonhuang';
const password = 'Pchome2313678023056';
const authArgs = `--username "${username}" --password "${password}" --non-interactive --trust-server-cert --no-auth-cache`;

const frontendRoot = 'https://svn01.universalec.com.tw/svn/UEC-F發票平台Oracle/2-SA/6-需求規格書(前端SPEC)';

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

function findMatchingFiles(allFiles, code) {
  const codePattern = new RegExp(`(?<![A-Z0-9])${escapeRegex(code)}(?![0-9])`, 'i');
  const matched = [];

  for (const file of allFiles) {
    if (file.endsWith('/')) continue;
    const ext = path.extname(file).toLowerCase();
    if (!SPEC_EXTENSIONS.has(ext)) continue;

    const parts = file.split('/');
    if (parts.some(p => p.toLowerCase() === 'old')) continue;

    const basename = path.basename(file);
    if (codePattern.test(basename)) {
      matched.push(file);
      continue;
    }
    if (parts.length > 1) {
      if (codePattern.test(parts[0])) {
        matched.push(file);
        continue;
      }
    }
  }
  return matched;
}

// Get top-level folders
console.log('=== Listing top-level folders ===');
const topText = svnList(frontendRoot);
const folders = topText.split('\n').map(l => l.trim()).filter(Boolean);
const ovFolder = folders.find(f => f.toUpperCase().startsWith('OV'));
console.log('Matched folder:', ovFolder);

if (ovFolder) {
  const folderName = ovFolder.endsWith('/') ? ovFolder.slice(0, -1) : ovFolder;
  const folderUrl = `${frontendRoot}/${folderName}`;
  console.log('\n=== Recursive listing ===');
  const allText = svnList(folderUrl, true);
  const allFiles = allText.split('\n').map(l => l.trim()).filter(Boolean);

  console.log('\n=== Testing OV02 match ===');
  const matchedOV02 = findMatchingFiles(allFiles, 'OV02');
  console.log('Matched files:', matchedOV02);

  console.log('\n=== Testing OV0101 match (hypothetical) ===');
  const matchedOV0101 = findMatchingFiles(allFiles, 'OV01');
  console.log('Matched files:', matchedOV0101);

  console.log('\n=== Testing OV06 match ===');
  const matchedOV06 = findMatchingFiles(allFiles, 'OV06');
  console.log('Matched files:', matchedOV06);
}
