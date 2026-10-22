/**
 * Asana 附件上傳（upload_asana_attachment、add_asana_comment 的內嵌圖、create_asana_task 共用）。
 * 一份邏輯，三個寫入點行為一致。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ASANA_API_BASE } from './helpers.js';
import { readImageSize, mimeTypeForImage, type ImageSize } from '../utils/imageSize.js';

/** Asana 附件上限（官方 100MB） */
export const ASANA_ATTACHMENT_MAX_BYTES = 100 * 1024 * 1024;
/** 上傳比一般 API 慢，另給較長的 timeout */
export const ASANA_UPLOAD_TIMEOUT_MS = 120_000;

export interface UploadedAsanaFile {
  gid: string | null; name: string; permanentUrl: string | null; bytes: number; size: ImageSize | null;
}

/**
 * 上傳單一檔案為 Asana 任務附件。parent 只能是 task/project/project_brief
 * （API 限制，不能掛在 story 上——連網頁版 Ctrl+V 貼進留言的圖也是任務附件）。
 * 走 POST /tasks/{gid}/attachments，file part 帶正確 MIME type（缺 type 會讓
 * Asana 算不出圖片 metadata）。回傳的 size 用於 inline 圖的 data-src-* 屬性。
 */
export async function uploadAsanaFile(asanaPat: string, taskGid: string, filePath: string): Promise<UploadedAsanaFile> {
  const stat = fs.statSync(filePath);
  const filename = path.basename(filePath);
  const bytes = fs.readFileSync(filePath);

  const form = new FormData();
  form.append('file', new Blob([bytes], { type: mimeTypeForImage(filename) }), filename);

  // 不手動設 Content-Type — 讓 fetch 自己帶 multipart boundary
  const res = await fetch(`${ASANA_API_BASE}/tasks/${taskGid}/attachments`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${asanaPat}`, 'Accept': 'application/json' },
    body: form,
    signal: AbortSignal.timeout(ASANA_UPLOAD_TIMEOUT_MS),
  });
  if (!res.ok) {
    const hint = res.status === 403 ? '（403 通常代表 PAT 沒有該任務的寫入權限）' : '';
    throw new Error(`upload failed for ${filename}: ${res.status} ${await res.text()}${hint}`);
  }
  const data = await res.json() as { data?: { gid?: string; name?: string; permanent_url?: string } };
  return {
    gid: data.data?.gid ?? null,
    name: data.data?.name ?? filename,
    permanentUrl: data.data?.permanent_url ?? null,
    bytes: stat.size,
    size: readImageSize(bytes),
  };
}

/** 檔案前置檢查（存在、是檔案、未超過上限）。回傳錯誤訊息，通過則回 null。 */
export function checkUploadableFile(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return `File not found: ${filePath}`;
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) return `Not a file: ${filePath}`;
  if (stat.size > ASANA_ATTACHMENT_MAX_BYTES) return `File too large (${stat.size} bytes): ${filePath}。Asana 附件上限 100MB。`;
  return null;
}
