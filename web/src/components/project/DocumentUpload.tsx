import { useState, useCallback } from 'react';
import { useWsStore } from '../../stores/wsStore';
import { useToastStore } from '../../stores/toastStore';
import { useProjectStore } from '../../stores/projectStore';
import type { DocType } from '@omni/shared';

interface DocumentUploadProps {
  projectId: string;
}

interface UploadedFile {
  name: string;
  docType: DocType;
  uploaded: boolean;
}

/** Auto-detect doc type from filename (SA or SD) */
function detectDocType(filename: string): DocType {
  const upper = filename.toUpperCase();
  // Look for SA patterns
  if (upper.includes('SA') || upper.includes('系統分析') || upper.includes('需求')) return 'SA';
  // Default to SD for everything else
  return 'SD';
}

const DOC_TYPE_STYLES: Record<DocType, { bg: string; text: string; label: string }> = {
  SA: { bg: 'bg-green-500/20', text: 'text-green-400', label: 'SA' },
  SD: { bg: 'bg-purple-500/20', text: 'text-purple-400', label: 'SD' },
};

export function DocumentUpload({ projectId }: DocumentUploadProps) {
  const client = useWsStore(s => s.client);
  const addToast = useToastStore(s => s.addToast);
  const documents = useProjectStore(s => s.documents);
  const [pendingFiles, setPendingFiles] = useState<UploadedFile[]>([]);
  const [pasteContent, setPasteContent] = useState('');
  const [pasteDocType, setPasteDocType] = useState<DocType>('SD');
  const [isDragging, setIsDragging] = useState(false);

  const uploadFile = useCallback((file: File, docType: DocType) => {
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = (reader.result as string).split(',')[1] || '';
      client?.send({
        type: 'project.uploadDocument',
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        payload: {
          projectId,
          filename: file.name,
          content: base64,
          fileType: 'base64',
          docType,
        },
      });
      // Add to pending while waiting for server confirmation
      setPendingFiles(prev => [...prev, { name: file.name, docType, uploaded: true }]);
      addToast({ type: 'success', title: 'File uploaded', message: `${file.name} (${docType})` });
      // Clear pending after a short delay (server will update documents list)
      setTimeout(() => {
        setPendingFiles(prev => prev.filter(f => f.name !== file.name));
      }, 1000);
    };
    reader.readAsDataURL(file);
  }, [projectId, client, addToast]);

  const handleDeleteDocument = useCallback((docId: string, filename: string) => {
    client?.send({
      type: 'project.deleteDocument',
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      payload: { projectId, documentId: docId },
    });
    addToast({ type: 'success', title: 'Document removed', message: filename });
  }, [projectId, client, addToast]);

  const handleFileUpload = useCallback((fileList: FileList | null) => {
    if (!fileList) return;
    for (const file of Array.from(fileList)) {
      const docType = detectDocType(file.name);
      uploadFile(file, docType);
    }
  }, [uploadFile]);

  const handlePaste = useCallback(() => {
    if (!pasteContent.trim()) return;

    client?.send({
      type: 'project.uploadDocument',
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      payload: {
        projectId,
        filename: 'pasted-document.md',
        content: pasteContent,
        fileType: 'text',
        docType: pasteDocType,
      },
    });
    addToast({ type: 'success', title: 'Content uploaded', message: `pasted-document.md (${pasteDocType})` });
    setPasteContent('');
  }, [projectId, pasteContent, pasteDocType, client, addToast]);

  // Combine server documents with pending uploads
  const saCount = documents.filter(d => d.docType === 'SA').length + pendingFiles.filter(f => f.docType === 'SA').length;
  const sdCount = documents.filter(d => d.docType === 'SD').length + pendingFiles.filter(f => f.docType === 'SD').length;
  const totalCount = documents.length + pendingFiles.length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-medium">Upload Spec Documents</h3>
        {totalCount > 0 && (
          <div className="flex items-center gap-2 text-xs">
            <span className={`px-2 py-0.5 rounded ${DOC_TYPE_STYLES.SA.bg} ${DOC_TYPE_STYLES.SA.text}`}>
              SA: {saCount}
            </span>
            <span className={`px-2 py-0.5 rounded ${DOC_TYPE_STYLES.SD.bg} ${DOC_TYPE_STYLES.SD.text}`}>
              SD: {sdCount}
            </span>
          </div>
        )}
      </div>

      {/* Doc type routing info */}
      <div className="text-xs text-muted-foreground bg-muted/50 rounded-md p-3 space-y-1">
        <p className="font-medium text-foreground/70">Document Routing:</p>
        <p>Frontend Agent receives: <span className="text-blue-400">SA</span> + <span className="text-purple-400">SD</span></p>
        <p>Backend Agent receives: <span className="text-purple-400">SD</span> only</p>
        <p className="text-muted-foreground/60 mt-1">Type is auto-detected from filename. You can change it below.</p>
      </div>

      {/* Drag & drop zone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(e) => { e.preventDefault(); setIsDragging(false); handleFileUpload(e.dataTransfer.files); }}
        className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${
          isDragging ? 'border-primary bg-primary/5' : 'border-border hover:border-muted-foreground'
        }`}
        onClick={() => document.getElementById('file-input')?.click()}
      >
        <div className="text-3xl mb-2">{isDragging ? '⬇' : '📄'}</div>
        <p className="text-sm text-muted-foreground">
          {isDragging ? 'Drop files here' : 'Drop files here or click to browse'}
        </p>
        <p className="text-xs text-muted-foreground mt-1">
          Supports PDF, Markdown, and Text files
        </p>
        <input
          id="file-input"
          type="file"
          multiple
          accept=".md,.txt,.pdf,.doc,.docx"
          className="hidden"
          onChange={(e) => { handleFileUpload(e.target.files); e.target.value = ''; }}
        />
      </div>

      {/* Paste area */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <label className="block text-sm font-medium">Or paste document content</label>
          <div className="flex items-center gap-1">
            {(['SA', 'SD'] as DocType[]).map(dt => (
              <button
                key={dt}
                onClick={() => setPasteDocType(dt)}
                className={`px-2 py-0.5 rounded text-xs transition-colors ${
                  pasteDocType === dt
                    ? `${DOC_TYPE_STYLES[dt].bg} ${DOC_TYPE_STYLES[dt].text} ring-1 ring-current`
                    : 'bg-muted text-muted-foreground hover:bg-muted/80'
                }`}
              >
                {DOC_TYPE_STYLES[dt].label}
              </button>
            ))}
          </div>
        </div>
        <textarea
          value={pasteContent}
          onChange={(e) => setPasteContent(e.target.value)}
          placeholder="Paste your SA/SD document content here..."
          className="w-full bg-muted border border-border rounded-md px-3 py-2 text-sm min-h-[120px] resize-y"
        />
        <button
          onClick={handlePaste}
          disabled={!pasteContent.trim()}
          className="mt-2 px-3 py-1.5 bg-secondary text-secondary-foreground rounded-md text-sm disabled:opacity-50 hover:bg-secondary/80 transition-colors"
        >
          Upload as {DOC_TYPE_STYLES[pasteDocType].label}
        </button>
      </div>

      {/* Uploaded files list */}
      {(documents.length > 0 || pendingFiles.length > 0) && (
        <div>
          <h4 className="text-sm font-medium mb-2">Uploaded Files ({totalCount})</h4>
          <div className="space-y-1.5">
            {/* Show documents from server (with delete button) */}
            {documents.map((doc) => (
              <div key={doc.id} className="flex items-center gap-2 text-sm bg-muted/30 rounded-md px-3 py-1.5 group">
                <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${DOC_TYPE_STYLES[doc.docType].bg} ${DOC_TYPE_STYLES[doc.docType].text}`}>
                  {doc.docType}
                </span>
                <span className="flex-1 truncate text-muted-foreground">{doc.filename}</span>
                <button
                  onClick={() => handleDeleteDocument(doc.id, doc.filename)}
                  className="p-1 rounded text-muted-foreground/40 hover:text-red-400 hover:bg-red-500/10 opacity-0 group-hover:opacity-100 transition-all"
                  title="Remove document"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            ))}
            {/* Show pending uploads (uploading indicator) */}
            {pendingFiles.map((f, i) => (
              <div key={`pending-${i}`} className="flex items-center gap-2 text-sm bg-muted/30 rounded-md px-3 py-1.5 opacity-60">
                <span className="text-yellow-400 text-xs animate-pulse">⏳</span>
                <span className="flex-1 truncate text-muted-foreground">{f.name}</span>
                <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${DOC_TYPE_STYLES[f.docType].bg} ${DOC_TYPE_STYLES[f.docType].text}`}>
                  {f.docType}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
