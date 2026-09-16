import { useEffect, useRef, useState } from 'react';
import { useCopilotOptional } from '@/components/copilot/CopilotProvider';
import { X, Upload, Trash2, FileText, Loader2, Info } from 'lucide-react';

interface KBDoc {
  id: string;
  title: string;
  file_name: string;
  file_type: string;
  file_size_bytes: number;
  chunk_count: number;
  processing_status: 'pending' | 'processing' | 'completed' | 'failed';
  processing_error: string | null;
  plant_id: string | null;
  equipment_type: string | null;
  manufacturer: string | null;
  model_number: string | null;
  created_at: string;
  /** Globally seeded manual (visible to every org, not deletable here). */
  shared?: boolean;
}

export function KnowledgeBaseDrawer({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const copilot = useCopilotOptional();
  const activePlantId = copilot?.pageContext.plantId ?? null;
  const activePlantName = copilot?.pageContext.plantName ?? null;

  const [docs, setDocs] = useState<KBDoc[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  /** When true and we're on a plant page, scope upload + list to this plant. */
  const [scopeToPlant, setScopeToPlant] = useState<boolean>(true);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const refresh = async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/chat/kb');
      const d = await r.json();
      setDocs(d.documents ?? []);
    } catch {
      setDocs([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) refresh();
  }, [open]);

  const onUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    setUploadError(null);
    try {
      for (const f of Array.from(files)) {
        const fd = new FormData();
        fd.append('file', f);
        fd.append('title', f.name);
        if (activePlantId && scopeToPlant) {
          fd.append('plantId', activePlantId);
        }
        const res = await fetch('/api/chat/kb/upload', {
          method: 'POST',
          body: fd,
        });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          throw new Error(d.error ?? `HTTP ${res.status}`);
        }
      }
      await refresh();
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const onDelete = async (id: string) => {
    if (!confirm('Delete this document and all its embeddings?')) return;
    const res = await fetch(`/api/chat/kb/${id}`, { method: 'DELETE' });
    if (res.ok) refresh();
  };

  if (!open) return null;

  // Filter the visible list when scoped to a plant. "Org-wide" docs (plant_id
  // null) always shown, they apply everywhere.
  const visibleDocs = activePlantId && scopeToPlant
    ? docs.filter((d) => d.plant_id === activePlantId || d.plant_id === null)
    : docs;

  return (
    <div className="fixed inset-0 z-50 flex overflow-hidden">
      <div
        className="flex-1 bg-black/40 backdrop-blur-sm transition-opacity"
        onClick={onClose}
        aria-hidden
      />
      <aside className="flex h-full w-full max-w-md flex-col border-l border-gray-200 bg-white text-gray-900 shadow-2xl animate-in slide-in-from-right duration-300">
        <header className="flex items-start justify-between border-b border-gray-100 bg-white px-6 py-5">
          <div>
            <h2 className="text-lg font-bold text-gray-900">Knowledge Base</h2>
            <p className="mt-1 text-xs text-gray-500 leading-relaxed">
              Upload plant manuals, datasheets, or O&M runbooks to give Shams context.
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-gray-400 hover:bg-gray-50 hover:text-gray-900 rounded-lg transition-colors"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </header>

        {/* Scope toggle when on a plant page */}
        {activePlantId && (
          <div className="bg-blue-50/50 px-6 py-3">
            <label className="flex cursor-pointer items-center gap-2.5">
              <input
                type="checkbox"
                checked={scopeToPlant}
                onChange={(e) => setScopeToPlant(e.target.checked)}
                className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              <div className="text-xs">
                <span className="text-gray-700">Scope to </span>
                <span className="font-bold text-blue-700">{activePlantName ?? activePlantId}</span>
              </div>
            </label>
          </div>
        )}

        <div className="px-6 py-6 border-b border-gray-100">
          <label className="group relative flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-gray-200 bg-gray-50 px-4 py-8 text-center transition-all hover:border-blue-400 hover:bg-blue-50/50">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".txt.md.pdf"
              onChange={(e) => onUpload(e.target.files)}
              disabled={uploading}
              className="hidden"
            />
            {uploading ? (
              <div className="flex flex-col items-center gap-2">
                <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
                <span className="text-sm font-medium text-gray-900">Uploading & Embedding...</span>
                <span className="text-xs text-gray-500">This may take a moment</span>
              </div>
            ) : (
              <>
                <div className="mb-3 rounded-full bg-white p-3 shadow-sm group-hover:scale-110 transition-transform">
                  <Upload className="h-6 w-6 text-blue-600" />
                </div>
                <span className="text-sm font-semibold text-gray-900">Click to upload documents</span>
                <span className="mt-1 text-xs text-gray-500">PDF, MD, or TXT (max 25MB)</span>
              </>
            )}
          </label>
          {uploadError && (
            <div className="mt-3 flex items-center gap-2 rounded-lg bg-red-50 p-3 text-xs text-red-600">
              <Info className="h-4 w-4" />
              {uploadError}
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto bg-white">
          <div className="px-6 py-4">
            <h3 className="text-xs font-bold uppercase tracking-widest text-gray-400 mb-4">
              Stored Documents ({visibleDocs.length})
            </h3>
            
            {loading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-6 w-6 animate-spin text-gray-300" />
              </div>
            ) : visibleDocs.length === 0 ? (
              <div className="text-center py-12">
                <FileText className="h-10 w-10 text-gray-200 mx-auto mb-3" />
                <p className="text-sm text-gray-400">No documents found</p>
              </div>
            ) : (
              <div className="space-y-3">
                {visibleDocs.map((d) => (
                  <div
                    key={d.id}
                    className="group flex items-start gap-4 rounded-xl border border-gray-100 p-4 transition-all hover:border-blue-100 hover:bg-blue-50/30"
                  >
                    <div className="mt-0.5 rounded-lg bg-gray-100 p-2 text-gray-500 group-hover:bg-blue-100 group-hover:text-blue-600 transition-colors">
                      <FileText className="h-5 w-5" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="truncate text-sm font-bold text-gray-900">
                          {d.title}
                        </span>
                        <StatusPill status={d.processing_status} />
                      </div>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-gray-500 font-medium">
                        <span>{prettySize(d.file_size_bytes)}</span>
                        <span>•</span>
                        <span>{d.chunk_count} segments</span>
                        {d.shared ? (
                          <>
                            <span>•</span>
                            <span className="text-emerald-600 uppercase tracking-tight">Shared library</span>
                          </>
                        ) : d.plant_id === null ? (
                          <>
                            <span>•</span>
                            <span className="text-blue-600 uppercase tracking-tight">Org-wide</span>
                          </>
                        ) : null}
                      </div>
                      {d.processing_error && (
                        <div className="mt-2 text-[11px] text-red-600 font-medium bg-red-50 p-2 rounded">
                          {d.processing_error}
                        </div>
                      )}
                    </div>
                    {!d.shared && (
                      <button
                        onClick={() => onDelete(d.id)}
                        className="opacity-0 group-hover:opacity-100 p-2 text-gray-400 hover:bg-red-50 hover:text-red-600 rounded-lg transition-all"
                        title="Delete document"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </aside>
    </div>
  );
}

function StatusPill({ status }: { status: KBDoc['processing_status'] }) {
  const map: Record<KBDoc['processing_status'], { bg: string, text: string }> = {
    pending: { bg: 'bg-gray-100', text: 'text-gray-600' },
    processing: { bg: 'bg-amber-100', text: 'text-amber-700' },
    completed: { bg: 'bg-emerald-100', text: 'text-emerald-700' },
    failed: { bg: 'bg-red-100', text: 'text-red-700' },
  };
  const colors = map[status];
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider ${colors.bg} ${colors.text}`}
    >
      {status}
    </span>
  );
}

function prettySize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
