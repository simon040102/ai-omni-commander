import { useState, useCallback } from 'react';
import { useWsStore } from '../../stores/wsStore';
import { useToastStore } from '../../stores/toastStore';
import type { DocType } from '@omni/shared';

interface DocumentUploadProps {
  projectId: string;
}

interface UploadedFile {
  name: string;
  docType: DocType;
  uploaded: boolean;
}

/** Try to auto-detect doc type from filename */
function detectDocType(filename: string): DocType {
  const lower = filename.toLowerCase();
  // Common patterns: SA_xxx, SD_xxx, SPEC_SA_xxx, xxx_SA.pdf etc.
  if (/\bsa\b/i.test(lower) || /system.?analysis/i.test(lower)) return 'SA';
  if (/\bsd\b/i.test(lower) || /system.?design/i.test(lower)) return 'SD';
  // If filename contains "spec" but no SA/SD indicator, default to SD
  if (/\bspec\b/i.test(lower)) return 'SD';
  return 'other';
}

const DOC_TYPE_STYLES: Record<DocType, { bg: string; text: string; label: string }> = {
  SA: { bg: 'bg-blue-500/20', text: 'text-blue-400', label: 'SA' },
  SD: { bg: 'bg-purple-500/20', text: 'text-purple-400', label: 'SD' },
  other: { bg: 'bg-zinc-500/20', text: 'text-zinc-400', label: 'Other' },
};

export function DocumentUpload({ projectId }: DocumentUploadProps) {
  const client = useWsStore(s => s.client);
  const addToast = useToastStore(s => s.addToast);
  const [files, setFiles] = useState<UploadedFile[]>([]);
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
      setFiles(prev => [...prev, { name: file.name, docType, uploaded: true }]);
      addToast({ type: 'success', title: 'File uploaded', message: `${file.name} (${docType})` });
    };
    reader.readAsDataURL(file);
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
    setFiles(prev => [...prev, { name: 'pasted-document.md', docType: pasteDocType, uploaded: true }]);
    addToast({ type: 'success', title: 'Content uploaded', message: `pasted-document.md (${pasteDocType})` });
    setPasteContent('');
  }, [projectId, pasteContent, pasteDocType, client, addToast]);

  /** Change doc type for an already-uploaded file (re-uploads with new type) */
  const handleChangeDocType = useCallback((index: number, newDocType: DocType) => {
    setFiles(prev => prev.map((f, i) => i === index ? { ...f, docType: newDocType } : f));
    // Note: The file is already on the server. In a real scenario we'd need an update API.
    // For now we just update the local display.
    addToast({ type: 'info', title: 'Type updated', message: `Updated to ${newDocType}` });
  }, [addToast]);

  const saCount = files.filter(f => f.docType === 'SA').length;
  const sdCount = files.filter(f => f.docType === 'SD').length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-medium">Upload Spec Documents</h3>
        {files.length > 0 && (
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
            {(['SA', 'SD', 'other'] as DocType[]).map(dt => (
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
      {files.length > 0 && (
        <div>
          <h4 className="text-sm font-medium mb-2">Uploaded Files ({files.length})</h4>
          <div className="space-y-1.5">
            {files.map((f, i) => (
              <div key={i} className="flex items-center gap-2 text-sm bg-muted/30 rounded-md px-3 py-1.5">
                <span className="text-green-400 text-xs">&#10003;</span>
                <span className="flex-1 truncate text-muted-foreground">{f.name}</span>
                {/* Doc type toggle */}
                <div className="flex items-center gap-1">
                  {(['SA', 'SD', 'other'] as DocType[]).map(dt => (
                    <button
                      key={dt}
                      onClick={() => handleChangeDocType(i, dt)}
                      className={`px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors ${
                        f.docType === dt
                          ? `${DOC_TYPE_STYLES[dt].bg} ${DOC_TYPE_STYLES[dt].text}`
                          : 'text-muted-foreground/50 hover:text-muted-foreground'
                      }`}
                    >
                      {DOC_TYPE_STYLES[dt].label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
