/**
 * create_asana_task：在 Asana 建任務（**客戶看得到**）。同意機制比照 add_asana_comment。
 *
 * 流程刻意分兩段：先把分區、自訂欄位、原單連結、附件檔全部解析驗證完（任何一項對不到就回錯、
 * 一個字都不寫），dryRun 停在這裡回預覽；正式送出才依序「建任務 → 上傳附件 → 原單留言」，
 * 每一步各自記成功／失敗——任務建好但後面失敗時不可整體回 ok（單已經在客戶面前了）。
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { getMcpDb } from '../db.js';
import { getAsanaPat, getDataDir, ASANA_API_BASE, ASANA_FETCH_TIMEOUT_MS } from '../helpers.js';
import { logTaskOutput } from '../flow-gate.js';
import { uploadAsanaFile, checkUploadableFile } from '../asana-upload.js';

const err = (text: string) => ({ content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true as const });

type FieldValue = string | number | string[];
interface ResolvedField { name: string; gid: string; type: string; value: string | number | string[] | { date: string }; display: string }
interface CustomFieldDef {
  gid: string; name: string; resource_subtype?: string;
  enum_options?: Array<{ gid: string; name: string; enabled?: boolean }>;
}

/** 分區：完全符合（不分大小寫）優先；否則部分符合唯一一筆才採用。不猜、不自動建。 */
export function matchSection(sections: Array<{ gid: string; name: string }>, wanted: string):
  { ok: true; section: { gid: string; name: string } } | { ok: false; message: string } {
  const w = wanted.trim().toLowerCase();
  const all = sections.map(s => `「${s.name}」`).join('、') || '（此專案沒有分區）';
  const exact = sections.filter(s => s.name.trim().toLowerCase() === w);
  if (exact.length === 1) return { ok: true, section: exact[0]! };
  const partial = sections.filter(s => s.name.toLowerCase().includes(w));
  if (partial.length === 1) return { ok: true, section: partial[0]! };
  if (partial.length > 1) {
    return { ok: false, message: `分區「${wanted}」部分符合多個分區：${partial.map(s => `「${s.name}」`).join('、')}——請給更完整的名稱。` };
  }
  return { ok: false, message: `找不到分區「${wanted}」（不會自動建立）。此專案可用的分區：${all}` };
}

/** 自訂欄位：名稱與選項都要完全相符（已停用的選項不算）。對不到就回錯並列出可用的，不猜。 */
export function resolveCustomFields(defs: CustomFieldDef[], wanted: Record<string, FieldValue>):
  { ok: true; fields: ResolvedField[] } | { ok: false; message: string } {
  const fields: ResolvedField[] = [];
  for (const [name, raw] of Object.entries(wanted)) {
    const def = defs.find(d => d.name.trim() === name.trim());
    if (!def) {
      return { ok: false, message: `此專案沒有自訂欄位「${name}」。可用的欄位：${defs.map(d => `「${d.name}」`).join('、') || '（無）'}` };
    }
    const type = def.resource_subtype ?? 'text';
    const enabled = (def.enum_options ?? []).filter(o => o.enabled !== false);
    const pick = (optName: string) => enabled.find(o => o.name.trim() === optName.trim());
    const optList = enabled.map(o => `「${o.name}」`).join('、') || '（無）';
    switch (type) {
      case 'text':
        if (typeof raw !== 'string') return { ok: false, message: `欄位「${name}」是文字欄位，值必須是字串。` };
        fields.push({ name, gid: def.gid, type, value: raw, display: raw });
        break;
      case 'number': {
        const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
        if (!Number.isFinite(n)) return { ok: false, message: `欄位「${name}」是數字欄位，值「${String(raw)}」不是數字。` };
        fields.push({ name, gid: def.gid, type, value: n, display: String(n) });
        break;
      }
      case 'enum': {
        if (typeof raw !== 'string') return { ok: false, message: `欄位「${name}」是單選欄位，值必須是選項名稱。可用的選項：${optList}` };
        const opt = pick(raw);
        if (!opt) return { ok: false, message: `欄位「${name}」沒有可用的選項「${raw}」。可用的選項：${optList}` };
        fields.push({ name, gid: def.gid, type, value: opt.gid, display: opt.name });
        break;
      }
      case 'multi_enum': {
        const names = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : null;
        if (!names) return { ok: false, message: `欄位「${name}」是多選欄位，值必須是選項名稱陣列。可用的選項：${optList}` };
        const gids: string[] = [];
        for (const n of names) {
          const opt = pick(n);
          if (!opt) return { ok: false, message: `欄位「${name}」沒有可用的選項「${n}」。可用的選項：${optList}` };
          gids.push(opt.gid);
        }
        fields.push({ name, gid: def.gid, type, value: gids, display: names.join('、') });
        break;
      }
      case 'date':
        if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return { ok: false, message: `欄位「${name}」是日期欄位，值必須是 YYYY-MM-DD。` };
        fields.push({ name, gid: def.gid, type, value: { date: raw }, display: raw });
        break;
      default:
        return { ok: false, message: `欄位「${name}」的類型「${type}」目前不支援由工具填寫，請在 Asana 手動設定。` };
    }
  }
  return { ok: true, fields };
}

/** 原單連結附在描述最後；html_notes 要放在 </body> 之前（沒包 <body> 就自動包）。 */
export function buildNotes(notes: string, htmlNotes: string | undefined, relatedUrl: string | null):
  { notes?: string; html_notes?: string } {
  if (htmlNotes !== undefined) {
    const inner = htmlNotes.trim().replace(/^<body>/i, '').replace(/<\/body>$/i, '');
    const link = relatedUrl ? `\n原單：<a href="${relatedUrl}">${relatedUrl}</a>` : '';
    return { html_notes: `<body>${inner}${link}</body>` };
  }
  return { notes: relatedUrl ? `${notes}\n\n原單：${relatedUrl}` : notes };
}

/** 稽核：任何建立都寫專案層稽核檔（新單不在 omni 裡，沒有任務可掛）；原單／母單在 omni 裡時另寫任務紀錄。 */
function writeAudit(db: Database.Database, entry: Record<string, unknown>, omniTask: { id: string; project_id: string } | undefined, line: string): void {
  const dir = path.join(getDataDir(), 'audit');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'asana-create-task.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', 'utf8');
  if (omniTask) logTaskOutput(db, omniTask.id, omniTask.project_id, line);
}

export function registerAsanaCreateTools(server: McpServer): void {
  server.tool(
    'create_asana_task',
    '在 Asana 建立任務（**寫入客戶看得到的地方**）。可放進指定分區、建成某張單的 subtask、填自訂欄位、附檔，並可與原單雙向連結（新單描述附原單網址、原單留言附新單網址）。\n\n'
      + '⚠ **送出前必須先把標題、描述全文、分區、指派對象、自訂欄位、附件清單、以及原單留言全文給使用者看過並取得明確同意**，再帶 userApproved=true 呼叫——這是外部可見、事後難以撤回的動作。使用者沒看過內容就呼叫屬於違規；不確定就先問。'
      + '建議先用 dryRun=true 取得完整預覽（含解析後的分區與欄位，不打任何寫入 API、不需 userApproved），把預覽給使用者看，同意後再正式送出。\n\n'
      + '附檔（attachmentPaths）前**你必須先自己用 Read tool 看過每個檔案**——可能含有不該外流的資料。\n\n'
      + '分區（部分符合）、自訂欄位名稱與選項（完全符合）對不到時會回錯並列出可用的，**不會自動建立、也不會猜**。任務建好但附件或原單留言失敗時回 isError 並逐步列出哪一步失敗（單已經建立，不可重送，否則會重複開單）。每次建立都寫稽核紀錄（[ASANA_CREATE_TASK]）。',
    {
      projectId: z.string().describe('omni 專案 ID（用該專案設定的 Asana project GID）'),
      name: z.string().min(1).describe('任務標題'),
      notes: z.string().min(1).describe('任務描述（純文字）'),
      htmlNotes: z.string().optional().describe('任務描述（Asana 富文字 HTML）。有帶就以它送出（notes 仍需提供，供預覽與稽核）'),
      section: z.string().optional().describe('分區名稱（部分符合；完全符合優先）。找不到回錯並列出可用分區，不會自動建立'),
      parentTaskGid: z.string().optional().describe('有帶就建成該任務的 subtask'),
      relatedTaskGid: z.string().optional().describe('原單 GID：新單描述最後附「原單：<原單 URL>」，並在原單留言「已另開單：<新單 URL>」（此留言也要列在給使用者的預覽中）'),
      assigneeGid: z.string().optional().describe('指派對象的 Asana user GID；不帶就不指派'),
      customFields: z.record(z.string(), z.union([z.string(), z.number(), z.array(z.string())])).optional()
        .describe('{ 欄位名稱: 值 }，例如 { "問題單號": "ODAS-120", "處理狀態": "待處理" }。單選填選項名稱、多選填名稱陣列、日期填 YYYY-MM-DD。名稱或選項對不到回錯'),
      attachmentPaths: z.array(z.string()).optional().describe('建立後上傳為附件的檔案絕對路徑（每個上限 100MB）。你必須先自己 Read 看過'),
      userApproved: z.literal(true).optional().describe('正式送出時必須為 true，代表已把完整內容（含原單留言與附件）給使用者看過並取得明確同意。dryRun 不需要'),
      approvalNote: z.string().optional().describe('使用者同意的情境摘要，會寫入稽核紀錄'),
      dryRun: z.boolean().optional().describe('true=只回傳將建立的完整內容（含解析後的分區／欄位 GID），不呼叫任何 Asana 寫入 API。預設 false'),
    },
    { title: 'Create Asana Task', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async (args) => {
      const { projectId, name, notes, htmlNotes, section, parentTaskGid, relatedTaskGid, assigneeGid, customFields, attachmentPaths, userApproved, approvalNote, dryRun } = args;
      const db = getMcpDb();

      // 同意檢查放在任何網路動作之前：沒同意的正式送出連查詢都不必做
      if (!dryRun && userApproved !== true) {
        return err('正式建立必須帶 userApproved=true（代表完整內容已給使用者看過並取得明確同意）。還沒給使用者看過，先用 dryRun=true 取得預覽。');
      }

      const project = db.prepare('SELECT id, asana_project_gid FROM projects WHERE id = ?').get(projectId) as { id: string; asana_project_gid: string | null } | undefined;
      if (!project) return err(`Project "${projectId}" not found`);
      if (!project.asana_project_gid) return err(`專案「${projectId}」沒有設定 Asana project GID，無法建立任務。`);
      const projectGid = project.asana_project_gid;

      const pat = getAsanaPat(db);
      if (!pat) return err('Asana PAT not configured. Use set_global_config to set asana.pat.');
      const headers = { 'Authorization': `Bearer ${pat}`, 'Accept': 'application/json' };
      const get = async (url: string) => {
        const r = await fetch(url, { headers, signal: AbortSignal.timeout(ASANA_FETCH_TIMEOUT_MS) });
        if (!r.ok) throw new Error(`Asana API error: ${r.status} ${await r.text()}（GET ${url.replace(ASANA_API_BASE, '')}）`);
        return ((await r.json()) as { data?: unknown }).data;
      };
      const post = async (url: string, data: Record<string, unknown>) => {
        const r = await fetch(url, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ data }),
          signal: AbortSignal.timeout(ASANA_FETCH_TIMEOUT_MS),
        });
        if (!r.ok) {
          const hint = r.status === 403 ? '（403 通常代表 PAT 沒有寫入權限）' : '';
          throw new Error(`Asana API error: ${r.status} ${await r.text()}${hint}`);
        }
        return ((await r.json()) as { data?: Record<string, unknown> }).data ?? {};
      };

      // ── 第一段：解析與驗證（任何一項失敗都不寫入）──
      const files = attachmentPaths ?? [];
      for (const p of files) {
        const problem = checkUploadableFile(p);
        if (problem) return err(problem);
      }

      let resolvedSection: { gid: string; name: string } | null = null;
      let fields: ResolvedField[] = [];
      let relatedUrl: string | null = null;
      try {
        if (section !== undefined) {
          const sections = (await get(`${ASANA_API_BASE}/projects/${encodeURIComponent(projectGid)}/sections?opt_fields=name`)) as Array<{ gid: string; name: string }> ?? [];
          const m = matchSection(sections, section);
          if (!m.ok) return err(m.message);
          resolvedSection = m.section;
        }
        if (customFields && Object.keys(customFields).length > 0) {
          const settings = (await get(`${ASANA_API_BASE}/projects/${encodeURIComponent(projectGid)}/custom_field_settings?opt_fields=custom_field.gid,custom_field.name,custom_field.resource_subtype,custom_field.enum_options.gid,custom_field.enum_options.name,custom_field.enum_options.enabled`)) as Array<{ custom_field?: CustomFieldDef }> ?? [];
          const r = resolveCustomFields(settings.map(s => s.custom_field).filter((d): d is CustomFieldDef => !!d), customFields);
          if (!r.ok) return err(r.message);
          fields = r.fields;
        }
        if (relatedTaskGid) {
          const rel = (await get(`${ASANA_API_BASE}/tasks/${encodeURIComponent(relatedTaskGid)}?opt_fields=name,permalink_url`)) as { permalink_url?: string } | undefined;
          relatedUrl = rel?.permalink_url ?? null;
          if (!relatedUrl) return err(`取不到原單 ${relatedTaskGid} 的網址，無法建立雙向連結。`);
        }
      } catch (e: unknown) {
        return err(e instanceof Error ? e.message : String(e));
      }

      const noteFields = buildNotes(notes, htmlNotes, relatedUrl);
      const body: Record<string, unknown> = { name, ...noteFields };
      if (parentTaskGid) body['parent'] = parentTaskGid;
      // Asana 建立時必須帶 workspace／parent／projects 其一——只帶 memberships 會 400（實際踩過）。
      // 一般任務一律帶 projects；subtask 只有指定分區時才加進專案（Asana 預設 subtask 不屬於專案）。
      // 分區不在建立時指定，建好後走文件明載的 POST /sections/{gid}/addTask。
      if (!parentTaskGid || resolvedSection) body['projects'] = [projectGid];
      if (assigneeGid) body['assignee'] = assigneeGid;
      if (fields.length > 0) body['custom_fields'] = Object.fromEntries(fields.map(f => [f.gid, f.value]));

      const warnings: string[] = [];
      if (parentTaskGid && !resolvedSection && fields.length > 0) {
        warnings.push('subtask 沒有指定分區就不會加進專案，Asana 可能拒絕寫入專案的自訂欄位——需要欄位的話請一併指定分區。');
      }
      const preview = {
        project: projectGid,
        name,
        ...(noteFields.html_notes !== undefined ? { htmlNotes: noteFields.html_notes } : {}),
        notes: noteFields.notes ?? notes,
        section: resolvedSection,
        parentTaskGid: parentTaskGid ?? null,
        assigneeGid: assigneeGid ?? null,
        customFields: fields.map(({ name: n, gid, value, display }) => ({ name: n, gid, value, display })),
        attachments: files.map(p => ({ path: p, bytes: fs.statSync(p).size })),
        // 原單留言也是客戶看得到的內容，要一起給使用者看
        relatedComment: relatedTaskGid ? '已另開單：<建立後的新單 URL>' : null,
        relatedTask: relatedTaskGid ? { gid: relatedTaskGid, url: relatedUrl } : null,
        ...(warnings.length > 0 ? { warnings } : {}),
      };
      if (dryRun) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({
          dryRun: true,
          preview,
          next: '把以上內容（標題、描述、分區、指派、欄位、附件、原單留言）給使用者看過並取得明確同意後，帶 userApproved=true 與相同參數（不帶 dryRun）正式送出。',
        }, null, 2) }] };
      }

      // ── 第二段：建立 → 附件 → 原單留言（逐步記錄）──
      let created: Record<string, unknown>;
      try {
        created = await post(`${ASANA_API_BASE}/tasks`, body);
      } catch (e: unknown) {
        return err(`建立任務失敗（沒有建立任何東西）：${e instanceof Error ? e.message : String(e)}`);
      }
      const gid = String(created['gid'] ?? '');
      const permalinkUrl = (created['permalink_url'] as string | undefined) ?? null;

      let sectionStep: { ok: boolean; sectionGid: string; section: string; error?: string } | null = null;
      if (resolvedSection) {
        try {
          await post(`${ASANA_API_BASE}/sections/${encodeURIComponent(resolvedSection.gid)}/addTask`, { task: gid });
          sectionStep = { ok: true, sectionGid: resolvedSection.gid, section: resolvedSection.name };
        } catch (e: unknown) {
          sectionStep = { ok: false, sectionGid: resolvedSection.gid, section: resolvedSection.name, error: e instanceof Error ? e.message : String(e) };
        }
      }

      const attachmentSteps: Array<{ path: string; ok: boolean; gid?: string | null; error?: string }> = [];
      for (const p of files) {
        try {
          const up = await uploadAsanaFile(pat, gid, p);
          attachmentSteps.push({ path: p, ok: true, gid: up.gid });
        } catch (e: unknown) {
          attachmentSteps.push({ path: p, ok: false, error: e instanceof Error ? e.message : String(e) });
        }
      }

      let relatedStep: { ok: boolean; storyGid?: string | null; error?: string } | null = null;
      if (relatedTaskGid) {
        try {
          const story = await post(`${ASANA_API_BASE}/tasks/${encodeURIComponent(relatedTaskGid)}/stories`, { text: `已另開單：${permalinkUrl ?? gid}` });
          relatedStep = { ok: true, storyGid: (story['gid'] as string | undefined) ?? null };
        } catch (e: unknown) {
          relatedStep = { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      }

      // 指派給自己 → 下次同步會進 omni（同步只收派給我的單）。查不到目前使用者不影響建立結果
      let syncHint: string | undefined;
      if (assigneeGid) {
        try {
          const me = (await get(`${ASANA_API_BASE}/users/me?opt_fields=gid`)) as { gid?: string } | undefined;
          if (me?.gid && me.gid === assigneeGid) syncHint = '這張單派給你自己——下次 sync_asana_tasks 會把它匯入 omni。';
        } catch { /* best-effort */ }
      }

      const failed = [...(sectionStep && !sectionStep.ok ? [`放進分區「${sectionStep.section}」`] : []), ...attachmentSteps.filter(s => !s.ok).map(s => `附件 ${path.basename(s.path)}`), ...(relatedStep && !relatedStep.ok ? ['原單留言'] : [])];
      const omniTask = (relatedTaskGid || parentTaskGid)
        ? db.prepare("SELECT id, project_id FROM tasks WHERE source = 'asana' AND source_ref IN (?, ?) ORDER BY source_ref = ? DESC LIMIT 1")
            .get(relatedTaskGid ?? '', parentTaskGid ?? '', relatedTaskGid ?? '') as { id: string; project_id: string } | undefined
        : undefined;
      const preview500 = notes.length > 500 ? `${notes.slice(0, 500)}…（共 ${notes.length} 字）` : notes;
      writeAudit(db, {
        projectId, gid, permalinkUrl, name, section: resolvedSection?.name ?? null, parentTaskGid: parentTaskGid ?? null,
        relatedTaskGid: relatedTaskGid ?? null, assigneeGid: assigneeGid ?? null,
        customFields: fields.map(f => ({ name: f.name, display: f.display })),
        attachments: attachmentSteps, relatedComment: relatedStep, approvalNote: approvalNote?.trim() || null, notes: preview500,
      }, omniTask,
        `[ASANA_CREATE_TASK] 已在 Asana 建立任務 ${gid}：${name}\n網址：${permalinkUrl ?? '(無)'}\n使用者同意：${approvalNote?.trim() || '(未填 approvalNote)'}`
        + (sectionStep ? `\n分區：${sectionStep.section}（${sectionStep.ok ? '已放入' : '放入失敗'}）` : '')
        + (fields.length > 0 ? `\n欄位：${fields.map(f => `${f.name}=${f.display}`).join('、')}` : '')
        + (files.length > 0 ? `\n附件：${attachmentSteps.map(s => `${path.basename(s.path)}(${s.ok ? 'ok' : '失敗'})`).join('、')}` : '')
        + (relatedStep ? `\n原單留言：${relatedStep.ok ? '已留言' : '失敗'}` : '')
        + (failed.length > 0 ? `\n⚠ 失敗的步驟：${failed.join('、')}` : '')
        + `\n描述：\n${preview500}`);

      const result = {
        ok: failed.length === 0,
        gid, permalinkUrl,
        section: resolvedSection?.name ?? null,
        relatedCommented: relatedStep ? relatedStep.ok : null,
        steps: { createTask: { ok: true, gid, permalinkUrl }, addToSection: sectionStep, attachments: attachmentSteps, relatedComment: relatedStep },
        ...(syncHint ? { syncHint } : {}),
        audited: omniTask ? `稽核檔＋omni 任務 ${omniTask.id} 的紀錄` : '稽核檔',
      };
      if (failed.length > 0) {
        return { content: [{ type: 'text' as const, text:
          `⚠ 部分成功：任務已建立（${permalinkUrl ?? gid}），但以下步驟失敗：${failed.join('、')}。**不要重送整支工具**（會重複開單）——分區沒放進去請在 Asana 手動拖進該分區（單已在專案裡）、失敗的附件改用 upload_asana_attachment(taskGid="${gid}") 補傳、原單留言改用 add_asana_comment 補留（都要再經使用者同意）。\n`
          + JSON.stringify(result, null, 2) }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  );
}
