/**
 * Axure Share Crawler — Phase 1: Extract coordinate data
 *
 * 只負責爬取和提取座標資料，存成 JSON。
 * HTML 生成由 AI subagent 在 Phase 2 處理。
 *
 * Usage:
 *   node crawl-axure.mjs [axure_url] [output_dir]
 *
 * Output:
 *   {output_dir}/_sitemap.json         — 完整頁面清單
 *   {output_dir}/_data/{code}-{type}.json — 每頁的座標資料
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { chromium } = require('D:/fork/lb-fedi-ui_node24/nodejs24/npm-global/node_modules/@playwright/mcp/node_modules/playwright');
import fs from 'fs';
import path from 'path';

const AXURE_URL = process.argv[2] || 'https://r56y9h.axshare.com/?id=iyw13y&p=sl01_%E7%99%BB%E5%85%A5&g=1';
const OUTPUT_DIR = process.argv[3] || 'D:/暫存檔/claude code/ai-omni-commander-v5/docs/axure-snapshots/a642923d-2807-42ac-bb6f-2cb2c2f0fc7d';
const AXURE_HOST = new URL(AXURE_URL).origin; // e.g. https://406hty.axshare.com
const DATA_DIR = path.join(OUTPUT_DIR, '_data');

fs.mkdirSync(DATA_DIR, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 6000 } });
let page = await context.newPage();

// ========== Sitemap ==========
console.log('=== Getting sitemap ===');
await page.goto(AXURE_URL, { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForTimeout(3000);
const sitemapTree = await page.evaluate(() => {
  const collect = (nodes) => nodes.map(n => ({
    id: n.id, url: n.url, name: n.pageName,
    children: n.children ? collect(n.children) : []
  }));
  try { return collect(window.$axure.document.sitemap.rootNodes); } catch { return null; }
});
if (!sitemapTree) { console.error('Failed to get sitemap'); await browser.close(); process.exit(1); }

function extractModuleCode(name) { const m = name.match(/^([A-Za-z]+\d+)/); return m ? m[1].toLowerCase() : null; }
function flattenWithCode(nodes, parentCode = null, parentModuleName = null) {
  const result = [];
  for (const node of nodes) {
    const nodeCode = extractModuleCode(node.name);
    const code = nodeCode || parentCode;
    const modName = nodeCode ? node.name.replace(/^[A-Za-z]+\d+[_]?/, '') : parentModuleName;
    if (node.id) {
      let pt = node.name;
      if (modName && pt.startsWith(modName)) pt = pt.slice(modName.length).replace(/^[-_]/, '');
      if (nodeCode) pt = node.name.replace(/^[A-Za-z]+\d+[_]?/, '');
      result.push({ id: node.id, name: node.name, moduleCode: code || 'misc', pageType: pt || node.name });
    }
    if (node.children.length > 0) result.push(...flattenWithCode(node.children, code, modName));
  }
  return result;
}
const pages = flattenWithCode(sitemapTree);
console.log('Found ' + pages.length + ' pages');
fs.writeFileSync(path.join(OUTPUT_DIR, '_sitemap.json'), JSON.stringify(pages, null, 2), 'utf8');

// ========== Extraction JS ==========
// UNIVERSAL: No project-specific filters. Extracts ALL visible elements.
// Filtering is done by AI in Phase 2.
const EXTRACT_JS = `(() => {
  const doc = document.querySelector('iframe#mainFrame')?.contentDocument || document;
  const base = doc.querySelector('#base');
  if (!base) return null;

  const items = [];
  const seen = new Set();

  // Skip only truly non-content tags
  const SKIP_TAGS = new Set(['SCRIPT','STYLE','SVG','LINK','NOSCRIPT','DEFS','G','PATH','PATTERN','MASK','STYLE']);
  // Skip only Axure internal classes (hidden elements, annotations, SVG fills)
  const SKIP_CLS = ['ax_default_hidden', 'annnote', 'stroke', 'fill', 'generatedImage'];

  for (const el of base.querySelectorAll('*')) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    if (el.offsetParent === null && !['INPUT','SELECT','TEXTAREA'].includes(el.tagName)) continue;

    const cls = typeof el.className === 'string' ? el.className : (el.className?.baseVal || '');
    const tag = el.tagName;

    if (SKIP_TAGS.has(tag)) continue;
    if (SKIP_CLS.some(c => cls.includes(c))) continue;

    // INPUT / SELECT / TEXTAREA
    if (['INPUT','SELECT','TEXTAREA'].includes(tag)) {
      const item = {
        y: Math.round(rect.y), x: Math.round(rect.x), w: Math.round(rect.width), h: Math.round(rect.height),
        type: tag === 'SELECT' ? 'select' : (el.type === 'checkbox' ? 'checkbox' : (el.type === 'radio' ? 'radio' : 'input')),
        inputType: el.type || 'text',
        value: el.value || '',
        placeholder: el.placeholder || '',
      };
      if (tag === 'SELECT') {
        item.options = [...el.options].map(o => ({ text: o.text.trim(), selected: o.selected }));
      }
      items.push(item);
      continue;
    }

    // IMG — capture src for reference
    if (tag === 'IMG') {
      items.push({ y: Math.round(rect.y), x: Math.round(rect.x), w: Math.round(rect.width), h: Math.round(rect.height), type: 'image', src: el.src || '' });
      continue;
    }

    // Text-bearing leaf elements: P, SPAN (no children), DIV (no children)
    const isTextLeaf = (tag === 'P') ||
      (tag === 'SPAN' && el.children.length === 0 && el.textContent?.trim()) ||
      (tag === 'DIV' && el.children.length === 0 && el.textContent?.trim());
    if (isTextLeaf) {
      const text = el.textContent?.trim();
      if (!text) continue;
      // Dedup: round y/x to nearest 10px to catch P/SPAN/DIV duplicates
      const ry = Math.round(Math.round(rect.y) / 10) * 10;
      const rx = Math.round(Math.round(rect.x) / 10) * 10;
      const key = text.slice(0, 50) + '|' + ry + '|' + rx;
      if (seen.has(key)) continue;
      seen.add(key);

      // Detect role from Axure class chain (universal — works for any Axure project)
      let role = 'text';
      let p = el.parentElement;
      while (p && p !== base) {
        const pc = typeof p.className === 'string' ? p.className : (p.className?.baseVal || '');
        if (pc.includes('primary_button')) { role = 'btn-primary'; break; }
        if (pc.includes('button') && !pc.includes('radio') && !pc.includes('check')) { role = 'btn-secondary'; break; }
        if (pc.includes('flow_shape')) { role = 'section-title'; break; }
        if (pc.includes('heading')) { role = 'heading'; break; }
        if (pc.includes('table_cell')) { role = 'table-cell'; break; }
        if (pc.includes('menu_item')) { role = 'menu-item'; break; }
        if (pc.includes('label') || pc.includes('_文字段落')) { role = 'label'; break; }
        if (pc.includes('text_field')) { role = 'input-label'; break; }
        if (pc.includes('droplist')) { role = 'select-label'; break; }
        p = p.parentElement;
      }

      items.push({ y: Math.round(rect.y), x: Math.round(rect.x), w: Math.round(rect.width), h: Math.round(rect.height), type: role, text });
      continue;
    }

    // Checkbox/Radio with SVG (Axure renders these as custom elements)
    if (cls.includes('checkbox') || cls.includes('btn_check') || cls.includes('radio_button')) {
      const textDiv = el.querySelector('.text');
      const cleanText = textDiv ? textDiv.textContent?.trim() : '';
      if (!cleanText) continue;
      const ry = Math.round(Math.round(rect.y) / 5) * 5;
      const rx = Math.round(Math.round(rect.x) / 5) * 5;
      const key = 'chk|' + cleanText + '|' + ry + '|' + rx;
      if (seen.has(key)) continue;
      seen.add(key);
      const isChecked = cls.includes('selected');
      items.push({ y: Math.round(rect.y), x: Math.round(rect.x), w: Math.round(rect.width), h: Math.round(rect.height),
                   type: cls.includes('radio') ? 'radio-label' : 'checkbox-label', text: cleanText, checked: isChecked });
    }
  }

  items.sort((a, b) => a.y - b.y || a.x - b.x);

  // Dedup: if checkbox-label and text have same text at same y, keep only checkbox-label
  const deduped = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.type === 'text' || item.type === 'label') {
      const dup = items.find(other =>
        other !== item &&
        (other.type === 'checkbox-label' || other.type === 'radio-label') &&
        other.text === item.text &&
        Math.abs(other.y - item.y) < 10
      );
      if (dup) continue;
    }
    deduped.push(item);
  }

  // Group into visual rows (y within 15px = same row)
  const rows = [];
  let currentRow = [deduped[0]];
  for (let i = 1; i < deduped.length; i++) {
    if (Math.abs(deduped[i].y - currentRow[0].y) < 15) {
      currentRow.push(deduped[i]);
    } else {
      rows.push(currentRow);
      currentRow = [deduped[i]];
    }
  }
  if (currentRow.length > 0) rows.push(currentRow);

  // Return rows instead of flat list — each row has items sorted by x
  return rows.map(row => {
    row.sort((a, b) => a.x - b.x);
    return { y: row[0].y, items: row };
  });
})()`;

// ========== Crawl ==========
let stuckCount = 0, extracted = 0, skipped = 0;

for (const p of pages) {
  if (stuckCount >= 3) { console.log('\n!!! Stuck 3x, stopping !!!'); break; }

  const safeType = p.pageType.replace(/[<>:"/\\|?*]/g, '_').replace(/&/g, '_');
  const outName = p.moduleCode + '-' + safeType + '.json';
  const outPath = path.join(DATA_DIR, outName);

  if (fs.existsSync(outPath)) { extracted++; continue; }

  process.stdout.write(p.moduleCode + '|' + p.pageType + ' ');

  try {
    const enc = encodeURIComponent(p.name);
    const resp = await page.goto(AXURE_HOST + '/' + enc + '.html', { waitUntil: 'networkidle', timeout: 20000 });
    if (!resp || resp.status() === 404) {
      await page.goto(AXURE_HOST + '/?id=' + p.id + '&p=' + enc, { waitUntil: 'networkidle', timeout: 20000 });
      await page.waitForTimeout(2000);
    } else {
      await page.waitForTimeout(1500);
    }

    const items = await page.evaluate(EXTRACT_JS);
    if (!items || items.length === 0) { console.log('[empty]'); skipped++; continue; }

    const data = { page: p, items };
    fs.writeFileSync(outPath, JSON.stringify(data, null, 2), 'utf8');
    console.log('[ok] ' + items.length + ' items');
    extracted++;
  } catch (err) {
    console.log('[ERROR] ' + err.message.slice(0, 60));
    if (err.message.includes('crash') || err.message.includes('Target closed')) {
      try { await page.close(); } catch {}
      page = await context.newPage();
    }
    stuckCount++;
  }
}

await browser.close();
console.log('\n=== Phase 1 done: ' + extracted + ' extracted, ' + skipped + ' empty, ' + stuckCount + ' errors ===');
console.log('JSON data saved to: ' + DATA_DIR);
console.log('Next: run Phase 2 (AI subagent) to generate HTML from JSON');
