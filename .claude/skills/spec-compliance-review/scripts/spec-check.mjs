#!/usr/bin/env node
// 規格回對的「程式」那一半：預檢（抓字面錯字）與證據重驗（防 AI 唬爛）。
// 零依賴，node >= 18。
//
//   node spec-check.mjs precheck checklist.json --fe <path> --be <path> [-o precheck.json]
//   node spec-check.mjs verify   checklist.json review.json --fe <path> --be <path> [--precheck precheck.json]

import fs from 'node:fs';
import path from 'node:path';

const SRC_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.java', '.kt', '.sql', '.xml', '.yml', '.yaml', '.json', '.vue', '.html', '.properties',
]);
// 產物目錄的命中不算數——編譯出來的東西不是原始碼
const SKIP_DIR = new Set([
  'node_modules', 'dist', 'build', 'target', '.git', 'out', 'coverage', '.next', '.gradle', 'bin', 'obj',
  // IDE 目錄：.idea/dataSources/*.xml 是一份完整的 DB schema dump，
  // 任何欄位名丟進去幾乎必中。拿 IDE 快取當「程式碼證據」是假符合的最大來源。
  '.idea', '.vscode', '.vs', '.settings',
]);

// 測試與假資料：命中算數但**只算弱證據**——規格文字只出現在測試裡，不代表正式程式做了。
// 不直接排除的理由：logic 項拿測試案例當證據是合理的。
const TEST_PATH = /(^|[\\/])(__tests__|__mocks__|__fixtures__|fixtures?|mocks?|mock-data|e2e|cypress|tests?|spec)([\\/]|$)/i;
const isTestPath = (f) => TEST_PATH.test(f) || /\.(test|spec)\.[jt]sx?$/i.test(f) || /Test\.java$/.test(f);
const EVIDENCE_WINDOW = 10; // AI 給的行號 ±10 行內找得到就算數

// ---------- 檔案收集 ----------

function collect(root, acc = []) {
  let ents;
  try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch { return acc; }
  for (const e of ents) {
    if (e.isDirectory()) {
      if (!SKIP_DIR.has(e.name)) collect(path.join(root, e.name), acc);
    } else if (SRC_EXT.has(path.extname(e.name))) {
      acc.push(path.join(root, e.name));
    }
  }
  return acc;
}

// 檢查表動輒數百項，每項都重讀整個 workspace 會慢到不能用——快取住
const _lines = new Map();
const readLines = (f) => {
  if (_lines.has(f)) return _lines.get(f);
  let v = null;
  try { v = fs.readFileSync(f, 'utf8').split(/\r?\n/); } catch { v = null; }
  _lines.set(f, v);
  return v;
};

// ---------- 比對規則 ----------

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 識別字用 word boundary：pageSize 不可被 pageSizeX 充數
const wordHit = (line, id) => new RegExp(`(^|[^A-Za-z0-9_$])${escRe(id)}([^A-Za-z0-9_$]|$)`).test(line);

// 規格閱讀寫法 → 程式碼字面的候選推導。完整字面永遠優先；
// 嚴禁退成任意 substring——那會把假不符換成更糟的假符合。
function candidates(content, itemType) {
  const out = [content];
  if (itemType === 'ui_text') return out;
  const c = content.trim();
  if (/\[\]\./.test(c)) out.push(c.split('.').pop());              // resultList[].oid → oid
  if (/^[A-Z0-9_]+\.[A-Z0-9_]+$/.test(c)) out.push(c.split('.')[1]); // ADM_CUST_LOG.OID → OID（表名單獨不算）
  if (c.includes('.') && !out.includes(c.split('.').pop())) out.push(c.split('.').pop());
  const struct = c.match(/[A-Za-z_$][A-Za-z0-9_$]*/g);
  if (/[:[{]/.test(c) && struct) out.push(...struct);              // items:[{uuid}] → items, uuid
  return [...new Set(out.filter(Boolean))];
}

// 佔位符等價：{id} = :id = ${id}；尾斜線不計
const normPath = (p) =>
  p.trim().replace(/\$\{[^}]+\}/g, '{}').replace(/\{[^}]*\}/g, '{}').replace(/:[A-Za-z0-9_]+/g, '{}')
    .replace(/\/+$/, '').toLowerCase();

const METHOD_HINT = {
  GET: [/@GetMapping/i, /\.get\s*\(/, /getApi\s*\(/, /method:\s*['"]get/i],
  POST: [/@PostMapping/i, /\.post\s*\(/, /postApi\s*\(/, /method:\s*['"]post/i],
  PUT: [/@PutMapping/i, /\.put\s*\(/, /putApi\s*\(/, /method:\s*['"]put/i],
  DELETE: [/@DeleteMapping/i, /\.delete\s*\(/, /deleteApi\s*\(/, /method:\s*['"]delete/i],
};

// api 命中：整條 path 在單行，或框架拆分（類別層 prefix + 方法層 suffix，必須同一檔案）
function findApi(files, content) {
  const m = content.trim().match(/^(GET|POST|PUT|DELETE|PATCH)\s+(\S+)$/i);
  const method = m ? m[1].toUpperCase() : null;
  const full = normPath(m ? m[2] : content);
  const segs = full.split('/').filter(Boolean);

  for (const f of files) {
    const lines = readLines(f);
    if (!lines) continue;
    const norm = lines.map(normPath);

    const test = isTestPath(f);
    const testNote = test ? '命中位置在測試／假資料檔（mock 路由表之類），不代表正式程式有串接' : null;

    for (let i = 0; i < lines.length; i++) {
      if (!norm[i].includes(full)) continue;
      const near = lines.slice(Math.max(0, i - 3), i + 4).join('\n');
      const methodOk = !method || (METHOD_HINT[method] || []).some((re) => re.test(near));
      const rs = [];
      if (!methodOk) rs.push(`找到路徑但附近 3 行內沒有 ${method} 的跡象`);
      if (testNote) rs.push(testNote);
      return { file: f, line: i + 1, weak: !methodOk || test, reason: rs.join('；') || null };
    }
    // 框架拆分：路徑可能被切成兩層（類別 + 方法），也可能三層以上
    //（gateway／context-path 的全域前綴 + 類別層 @RequestMapping + 方法層 @PostMapping）。
    // 全域前綴根本不會出現在 Controller 檔裡，所以只要求「尾段命中」，
    // 中間段能對上幾個就記幾個，對不上的寫進 reason 交人工確認。
    if (segs.length >= 2) {
      const suf = '/' + segs[segs.length - 1];
      const si = norm.findIndex((l) => l.includes(suf));
      if (si >= 0) {
        const near = lines.slice(Math.max(0, si - 3), si + 4).join('\n');
        const methodOk = !method || (METHOD_HINT[method] || []).some((re) => re.test(near));
        const mid = segs.slice(0, -1);
        const hitMid = mid.filter((sg) => norm.some((l) => l.includes('/' + sg)));
        const missMid = mid.filter((sg) => !hitMid.includes(sg));
        const note = missMid.length
          ? `只對上尾段 ${suf}${hitMid.length ? `與中間段 /${hitMid.join(' /')}` : ''}；`
            + `/${missMid.join(' /')} 不在此檔（可能是 gateway 或 context-path 的全域前綴）`
          : '路徑由框架拆分組成（類別層 + 方法層）';
        const rs2 = [note];
        if (!methodOk) rs2.push(`附近沒有 ${method} 的跡象`);
        if (testNote) rs2.push(testNote);
        return { file: f, line: si + 1, weak: true, reason: rs2.join('；') };
      }
    }
  }
  return null;
}

function findText(files, content, itemType) {
  const cands = candidates(content, itemType);
  for (const cand of cands) {
    const exact = cand === content;
    for (const f of files) {
      const lines = readLines(f);
      if (!lines) continue;
      for (let i = 0; i < lines.length; i++) {
        const hit = itemType === 'ui_text' ? lines[i].includes(cand) : wordHit(lines[i], cand);
        if (hit) {
          const test = isTestPath(f);
          const reasons = [];
          if (!exact) reasons.push(`以弱化候選「${cand}」命中，非規格完整字面`);
          if (test) reasons.push('命中位置在測試／假資料檔，不代表正式程式做了');
          return { file: f, line: i + 1, weak: !exact || test, reason: reasons.join('；') || null };
        }
      }
    }
  }
  return null;
}

// ---------- 預檢 ----------

function precheck(checklist, roots) {
  const files = {
    frontend: roots.fe ? collect(roots.fe) : [],
    backend: roots.be ? collect(roots.be) : [],
  };
  const results = [];
  for (const it of checklist.items) {
    if (it.itemType === 'logic') {
      results.push({ itemId: it.id, status: 'manual', reason: '行為規則，程式比對看不懂，交 AI 判定' });
      continue;
    }
    const pool = files[it.side] || [];
    if (!pool.length) {
      results.push({ itemId: it.id, status: 'manual', reason: `side=${it.side} 沒有對應的 workspace 可掃描` });
      continue;
    }
    const hit = it.itemType === 'api' ? findApi(pool, it.content) : findText(pool, it.content, it.itemType);
    if (hit) {
      results.push({
        itemId: it.id, status: 'matched',
        evidence: [{ file: path.relative(roots[it.side === 'frontend' ? 'fe' : 'be'], hit.file).replace(/\\/g, '/'), line: hit.line }],
        weak: !!hit.weak, reason: hit.reason,
      });
    } else {
      results.push({ itemId: it.id, status: 'missing', reason: '掃遍 workspace 原始碼找不到這段字面' });
    }
  }
  return results;
}

// ---------- 證據重驗 ----------

function verify(checklist, review, roots) {
  const byId = new Map(checklist.items.map((i) => [String(i.id), i]));
  for (const extra of review.addedByReverseScan || []) byId.set(String(extra.id), extra);

  const all = [...(review.results || []), ...(review.addedByReverseScan || []).map((e) => ({ itemId: e.id, ...e }))];
  const bad = [];        // 造假：整批退回
  const fixable = [];     // 行號偏了：改那一筆就好
  const weakEvidence = [];
  let checked = 0;

  for (const r of all) {
    if (r.status !== 'matched') continue;
    const it = byId.get(String(r.itemId));
    if (!it) { bad.push({ itemId: r.itemId, why: '檢查表裡沒有這個 id' }); continue; }
    if (!r.evidence?.length) { bad.push({ itemId: r.itemId, why: '判 matched 卻沒附證據' }); continue; }

    const root = it.side === 'frontend' ? roots.fe : roots.be;
    let ok = false, why = '';
    for (const ev of r.evidence) {
      checked++;
      const abs = path.resolve(root, ev.file);
      if (path.relative(root, abs).startsWith('..')) { why = `證據路徑跑出 workspace：${ev.file}`; continue; }
      if (abs.split(/[\\/]/).some((s) => SKIP_DIR.has(s))) { why = `證據指向產物目錄：${ev.file}`; continue; }
      const lines = readLines(abs);
      if (!lines) { why = `檔案不存在：${ev.file}`; continue; }
      if (!(ev.line >= 1 && ev.line <= lines.length)) { why = `行號超出檔案範圍：${ev.file}:${ev.line}（共 ${lines.length} 行）`; continue; }
      // logic 的 content 是行為描述，不是程式碼裡會出現的字串——
      // 只驗「這個位置真的存在」，行為對不對是 AI 的判斷，程式證明不了。
      if (it.itemType === 'logic') { ok = true; break; }
      const win = lines.slice(Math.max(0, ev.line - 1 - EVIDENCE_WINDOW), ev.line + EVIDENCE_WINDOW).join('\n');
      let found;
      if (it.itemType === 'api') {
        // 完整路徑常被框架拆開（Spring 的 addPathPrefix + 類別層 @RequestMapping +
        // 方法層 @PostMapping），沒有任何一行含完整字串。接受「最後一段命中」，
        // 但標記為弱證據——這種項目要在報告裡講清楚為什麼逐行比對抓不到。
        const full = normPath(it.content.split(/\s+/)[1] || it.content);
        const nw = normPath(win);
        if (nw.includes(full)) found = true;
        else {
          const segs = full.split('/').filter((s) => s && s !== '{}');
          const last = segs[segs.length - 1];
          if (last && nw.includes('/' + last)) { found = true; weakEvidence.push({ itemId: r.itemId, content: it.content, why: `完整路徑不在單行——以最後一段 /${last} 確認（路徑由框架前綴＋類別層＋方法層組成）` }); }
        }
      } else {
        found = candidates(it.content, it.itemType).some((c) => (it.itemType === 'ui_text' ? win.includes(c) : wordHit(win, c)));
      }
      if (found) { ok = true; break; }

      // 罰則分級：整份檔案都找不到那串字 = 造假（整批退）；
      // 檔案裡找得到、只是行號偏了 = 手抖（標記修正那一筆就好）。
      // 把兩者罰成一樣，結果是誠實但手抖的判定被判死，
      // 而拿 IDE 快取當證據的判定反而全過。
      const whole = lines.join('\n');
      const elsewhere = it.itemType === 'api'
        ? normPath(whole).includes(normPath(it.content.split(/\s+/)[1] || it.content))
        : candidates(it.content, it.itemType).some((c) =>
            (it.itemType === 'ui_text' ? whole.includes(c) : wordHit(whole, c)));
      if (elsewhere) {
        const cands = it.itemType === 'api'
          ? [normPath(it.content.split(/\s+/)[1] || it.content)]
          : candidates(it.content, it.itemType);
        const at = lines.findIndex((l) => cands.some((c) => (
          it.itemType === 'api' ? normPath(l).includes(c)
            : it.itemType === 'ui_text' ? l.includes(c)
            : wordHit(l, c))));
        fixable.push({
          itemId: r.itemId, content: it.content,
          why: `${ev.file}:${ev.line} 行號偏了${at >= 0 ? `，實際在第 ${at + 1} 行` : '（同檔案別處找得到）'}`,
        });
        ok = true;
        break;
      }
      // 走到這裡代表 elsewhere === false：整份檔案都找不到，這才是造假。
      // 原本這裡連續賦值兩次，把上一句蓋掉，結果被整批退回的人看到的理由是
      // 「±10 行內找不到」——那是隔壁輕罰分支的語意，讀起來像只是手抖。
      why = `${ev.file}:${ev.line} 整份檔案都找不到「${it.content}」（不只是行號偏了）`;
    }
    if (!ok) bad.push({ itemId: r.itemId, content: it.content, why });
  }
  return { checked, bad, fixable, weakEvidence };
}

// ---------- 實體 DB 核對 ----------

// 規格寫法 → 表名 / 欄位名。只認明確形式，不猜：
//   ADM_CUST_LOG.OID → 表 ADM_CUST_LOG、欄位 OID
//   dbo.T.COL        → 表 T、欄位 COL（schema 前綴丟掉）
//   OID              → 沒有表名，只能問「有沒有任何表有這個欄位」
function parseDbFieldRef(content) {
  const cleaned = String(content).trim().replace(/[（(].*?[)）]/g, '').trim();
  const m = cleaned.match(/([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)/);
  if (!m) return { table: null, column: cleaned };
  const parts = m[1].split('.');
  return { table: parts.length >= 2 ? parts[parts.length - 2] : null, column: parts[parts.length - 1] };
}

// schema 快照：INFORMATION_SCHEMA.COLUMNS 的 CSV 或 JSON 匯出。
// 欄位順序不重要，認標題名；sqlcmd 的 -W 會留下一排 --- 分隔線，跳掉。
function loadSchema(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  if (file.toLowerCase().endsWith('.json')) {
    const j = JSON.parse(raw);
    return (Array.isArray(j) ? j : j.columns || j.rows || []).map(normalizeSchemaRow);
  }
  const lines = raw.split(/\r?\n/).filter((l) => l.trim() && !/^-+[,\s-]*$/.test(l));
  const head = lines.shift().split(',').map((h) => h.trim().toUpperCase());
  return lines.map((l) => {
    const cells = l.split(',');
    const row = {};
    head.forEach((h, i) => { row[h] = (cells[i] ?? '').trim(); });
    return normalizeSchemaRow(row);
  }).filter((r) => r.table && r.column);
}

const pick = (row, ...keys) => {
  for (const k of keys) {
    for (const rk of Object.keys(row)) if (rk.toUpperCase() === k) return row[rk];
  }
  return undefined;
};
function normalizeSchemaRow(row) {
  const num = (v) => (v === '' || v == null || v === 'NULL' ? null : Number(v));
  return {
    table: String(pick(row, 'TABLE_NAME', 'TABLE') ?? '').trim(),
    column: String(pick(row, 'COLUMN_NAME', 'COLUMN') ?? '').trim(),
    dataType: String(pick(row, 'DATA_TYPE') ?? '').trim(),
    maxLength: num(pick(row, 'CHARACTER_MAXIMUM_LENGTH')),
    precision: num(pick(row, 'NUMERIC_PRECISION')),
    scale: num(pick(row, 'NUMERIC_SCALE')),
    nullable: String(pick(row, 'IS_NULLABLE') ?? '').toUpperCase() === 'YES',
  };
}

function describeColumn(c) {
  let t = c.dataType.toUpperCase();
  if (c.maxLength != null && /CHAR|BINARY/i.test(c.dataType)) t += `(${c.maxLength === -1 ? 'MAX' : c.maxLength})`;
  else if (c.precision != null && /DECIMAL|NUMERIC/i.test(c.dataType)) t += `(${c.precision}${c.scale != null ? `,${c.scale}` : ''})`;
  return `${t} ${c.nullable ? 'NULL' : 'NOT NULL'}`;
}

function dbcheck(checklist, columns) {
  const byTable = new Map(), byColumn = new Map();
  for (const c of columns) {
    const t = c.table.toUpperCase(), col = c.column.toUpperCase();
    if (!byTable.has(t)) byTable.set(t, new Map());
    byTable.get(t).set(col, c);
    if (!byColumn.has(col)) byColumn.set(col, []);
    byColumn.get(col).push(c.table);
  }
  return checklist.items.filter((i) => i.itemType === 'db_field').map((it) => {
    const { table, column } = parseDbFieldRef(it.content);
    const colU = column.toUpperCase();
    const base = { id: it.id, content: it.content, table, column };
    if (table) {
      const cols = byTable.get(table.toUpperCase());
      // 這張表整個不在快照裡 → 無從判定，不是「不存在」。絕不當成通過。
      if (!cols) return { ...base, verdict: 'unknown', why: `快照裡沒有資料表 ${table}，無從判定` };
      const actual = cols.get(colU);
      return actual
        ? { ...base, verdict: 'ok', why: `${table}.${actual.column} ${describeColumn(actual)}` }
        : { ...base, verdict: 'no', why: `資料表 ${table} 實際沒有欄位 ${column}` };
    }
    const found = byColumn.get(colU);
    return found?.length
      ? { ...base, verdict: 'ok-weak', why: `檢查項沒寫表名；欄位 ${column} 出現在 ${[...new Set(found)].slice(0, 5).join(', ')}` }
      : { ...base, verdict: 'no', why: `快照裡沒有任何表有欄位 ${column}` };
  });
}

// ---------- CLI ----------

const argv = process.argv.slice(2);
const cmd = argv.shift();
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const positional = argv.filter((a, i) => !a.startsWith('-') && !(i > 0 && argv[i - 1].startsWith('-')));
const roots = { fe: flag('--fe'), be: flag('--be') };
const readJson = (f) => {
  if (!f) { console.error('錯誤：缺少檔案參數，用法見下方。'); process.exit(2); }
  let raw;
  try { raw = fs.readFileSync(f, 'utf8'); }
  catch { console.error(`錯誤：讀不到檔案 ${f}（路徑打錯了？）`); process.exit(2); }
  try { return JSON.parse(raw.replace(/^\uFEFF/, '')); }
  catch (e) { console.error(`錯誤：${f} 不是合法的 JSON —— ${e.message}`); process.exit(2); }
};

/**
 * workspace 路徑檢查。打錯字會讓整批項目靜默變「需人工」，
 * 畫面上跟「這批真的都要人工判斷」長得一模一樣——所以要主動報並中止。
 */
function reportRoots(roots, files) {
  const lines = [];
  for (const [k, label] of [['fe', 'frontend'], ['be', 'backend']]) {
    if (!roots[k]) { lines.push(`  ${label}：未指定（該 side 的項目一律「需人工」）`); continue; }
    if (!fs.existsSync(roots[k])) { lines.push(`  ${label}：**路徑不存在** ${roots[k]}`); continue; }
    lines.push(`  ${label}：${files[label].length} 個原始碼檔　${roots[k]}`);
  }
  console.log('掃描範圍：');
  console.log(lines.join('\n'));
  const bad = (roots.fe && !fs.existsSync(roots.fe)) || (roots.be && !fs.existsSync(roots.be));
  const empty = (roots.fe && files.frontend.length === 0) || (roots.be && files.backend.length === 0);
  if (bad || empty) {
    console.error('\n✗ workspace 路徑無效或掃不到任何原始碼——這次的結果不可用。先修路徑再跑。');
    return false;
  }
  return true;
}

if (cmd === 'precheck') {
  const checklist = readJson(positional[0]);
  const roughFiles = {
    frontend: roots.fe && fs.existsSync(roots.fe) ? collect(roots.fe) : [],
    backend: roots.be && fs.existsSync(roots.be) ? collect(roots.be) : [],
  };
  if (!reportRoots(roots, roughFiles)) process.exit(2);
  console.log('');

  const results = precheck(checklist, roots);
  const n = (s) => results.filter((r) => r.status === s).length;
  const out = flag('-o');
  if (out) fs.writeFileSync(out, JSON.stringify({ results }, null, 2), 'utf8');
  console.log(`預檢：共 ${results.length} 項　符合 ${n('matched')}　不符 ${n('missing')}　需人工 ${n('manual')}`);

  const miss = results.filter((r) => r.status === 'missing');
  if (miss.length) {
    console.log('\n找不到字面的（下一步 AI 會重判，這裡只是提示）：');
    for (const r of miss) console.log(`  ✗ ${r.itemId} — ${r.reason}`);
  }

  // 這個腳本真正的失效模式是**假符合**，不是假不符：
  // 假不符下一步 AI 會抓到，假符合會被當成「這幾項不用細看了」。
  // 所以弱證據要逐項印在畫面上，不能只印總數、藏在 -o 的 JSON 裡。
  const weak = results.filter((r) => r.weak);
  if (weak.length) {
    console.log(`\n⚠ 以下 ${weak.length} 項雖然算「符合」，但證據薄弱，一定要人工看一眼：`);
    for (const r of weak) {
      console.log(`  ? ${r.itemId} — ${r.reason}`);
      const ev = r.evidence && r.evidence[0];
      if (ev) console.log(`      ${ev.file}:${ev.line}`);
    }
  }
  console.log('\n⚠ 預檢結果不算數，只用來抓錯字。判定依據是第三步的獨立 AI 驗證。');
} else if (cmd === 'verify') {
  // 先驗 workspace 路徑再驗證據。順序反了的話，一個路徑錯字會把
  // 每筆證據都判成「檔案不存在」＝造假，整批退回——冤枉的是使用者。
  {
    const files = {
      frontend: roots.fe && fs.existsSync(roots.fe) ? collect(roots.fe) : [],
      backend: roots.be && fs.existsSync(roots.be) ? collect(roots.be) : [],
    };
    if (!reportRoots(roots, files)) {
      console.error('（證據重驗尚未執行——路徑修好再跑，不然會把正確的判定誤判成造假。）');
      process.exit(2);
    }
    console.log('');
  }
  const checklist = readJson(positional[0]);
  const review = readJson(positional[1]);
  const { checked, bad, fixable, weakEvidence } = verify(checklist, review, roots);
  console.log(`證據重驗：開檔核對 ${checked} 筆`);
  if (bad.length) {
    console.log(`\n✗ ${bad.length} 筆引用不實 —— 整批退回重審：`);
    for (const b of bad) console.log(`  ${b.itemId}${b.content ? ` 「${b.content}」` : ''}：${b.why}`);
    process.exitCode = 1;
  } else {
    console.log('✓ 沒有造假的證據');
  }
  if (fixable.length) {
    console.log(`\n${fixable.length} 筆行號偏了（判定成立，改行號就好，不用整批退）：`);
    for (const f of fixable) console.log(`  ~ ${f.itemId}「${f.content}」：${f.why}`);
  }
  if (weakEvidence.length) {
    console.log(`
弱證據 ${weakEvidence.length} 筆（判定成立，但報告要寫清楚為什麼逐行比對抓不到）：`);
    for (const w of weakEvidence) console.log(`  ${w.itemId}「${w.content}」：${w.why}`);
  }
  const pf = flag('--precheck');
  if (pf) {
    const pre = new Map(readJson(pf).results.map((r) => [String(r.itemId), r.status]));
    const diverge = (review.results || []).filter((r) => {
      const p = pre.get(String(r.itemId));
      return p && p !== 'manual' && p !== r.status;
    });
    if (diverge.length) {
      console.log(`\n分歧偵測：${diverge.length} 項程式預檢與 AI 判定相反（人工抽查靶點）`);
      for (const d of diverge) console.log(`  ${d.itemId}：預檢 ${pre.get(String(d.itemId))} / AI ${d.status}`);
    }
  }
} else if (cmd === 'dbcheck') {
  const checklist = readJson(positional[0]);
  const results = dbcheck(checklist, loadSchema(positional[1]));
  const n = (v) => results.filter((r) => r.verdict === v).length;
  const out = flag('-o');
  if (out) fs.writeFileSync(out, JSON.stringify({ results }, null, 2), 'utf8');
  console.log(`實體 DB 核對：共 ${results.length} 個資料表欄位　實體 DB 確實有 ${n('ok') + n('ok-weak')}　實體 DB 沒有 ${n('no')}　無從判定 ${n('unknown')}`);
  const no = results.filter((r) => r.verdict === 'no');
  if (no.length) {
    console.log(`\n✗ 實體 DB 沒有這些欄位（對應的檢查項一律判不符）：`);
    for (const r of no) console.log(`  ${r.id}「${r.content}」：${r.why}`);
  }
  const unk = results.filter((r) => r.verdict === 'unknown');
  if (unk.length) {
    console.log(`\n⚠ 無從判定 ${unk.length} 項——**不可當成通過**，快照沒撈到這些表：`);
    console.log('  ' + [...new Set(unk.map((r) => r.table))].join(', '));
  }
  const weak = results.filter((r) => r.verdict === 'ok-weak');
  if (weak.length) console.log(`\n${weak.length} 項檢查項沒寫表名，只確認得了「某張表有這個欄位」，資訊量較弱`);
  console.log('\n> 型別／長度／可否為空與規格不符時不算缺陷（欄位確實存在），列進報告的「規格矛盾／未定義」交使用者裁決。');
} else {
  console.log(`用法:
  node spec-check.mjs precheck checklist.json --fe <前端路徑> --be <後端路徑> [-o precheck.json]
  node spec-check.mjs verify   checklist.json review.json --fe <前端路徑> --be <後端路徑> [--precheck precheck.json]
  node spec-check.mjs dbcheck  checklist.json schema.csv [-o dbcheck.json]

  schema.csv = INFORMATION_SCHEMA.COLUMNS 的匯出（CSV 或 JSON），取得方式見 SKILL.md 第四步`);
  process.exitCode = 2;
}
