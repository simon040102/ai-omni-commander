import { getDb } from '../connection.js';

export function bindDocumentToTask(taskId: string, documentId: string): void {
  const db = getDb();
  db.prepare(`
    INSERT OR IGNORE INTO task_documents (task_id, document_id)
    VALUES (?, ?)
  `).run(taskId, documentId);
}

export function getDocumentsForTask(taskId: string): Array<{
  documentId: string;
  filename: string;
  filePath: string;
  fileType: string | null;
  docType: string | null;
  parsedText: string | null;
  source: string;
  sourceUrl: string | null;
}> {
  const db = getDb();
  const rows = db.prepare(`
    SELECT d.id AS document_id, d.filename, d.file_path, d.file_type,
           d.doc_type, d.parsed_text, d.source, d.source_url
    FROM task_documents td
    JOIN documents d ON d.id = td.document_id
    WHERE td.task_id = ?
    ORDER BY d.created_at ASC
  `).all(taskId) as Record<string, unknown>[];

  return rows.map(r => ({
    documentId: r['document_id'] as string,
    filename: r['filename'] as string,
    filePath: r['file_path'] as string,
    fileType: (r['file_type'] as string | null) ?? null,
    docType: (r['doc_type'] as string | null) ?? null,
    parsedText: (r['parsed_text'] as string | null) ?? null,
    source: (r['source'] as string) || 'upload',
    sourceUrl: (r['source_url'] as string | null) ?? null,
  }));
}

export function getTasksForDocument(documentId: string): string[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT task_id FROM task_documents WHERE document_id = ?
  `).all(documentId) as Array<{ task_id: string }>;
  return rows.map(r => r.task_id);
}

export function unbindDocumentFromTask(taskId: string, documentId: string): void {
  const db = getDb();
  db.prepare(`
    DELETE FROM task_documents WHERE task_id = ? AND document_id = ?
  `).run(taskId, documentId);
}
