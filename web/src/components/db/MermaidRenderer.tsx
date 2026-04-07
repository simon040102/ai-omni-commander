/**
 * Mermaid diagram renderer with Figma-like canvas interaction.
 * Ported from spec-agent, adapted for omni-commander.
 * Supports: scroll=zoom at cursor, drag=pan, dblclick=fit
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import mermaid from 'mermaid';

interface MermaidRendererProps {
  content: string;
  height?: string;
  filename?: string;
}

export default function MermaidRenderer({ content, height = '60vh', filename = 'er-diagram.png' }: MermaidRendererProps) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const svgWrapRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [rendering, setRendering] = useState(true);
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 });
  const [dragging, setDragging] = useState(false);
  const [exporting, setExporting] = useState(false);
  const dragOrigin = useRef({ x: 0, y: 0, tx: 0, ty: 0 });
  const svgSize = useRef({ w: 0, h: 0 });

  // Render mermaid
  useEffect(() => {
    if (!svgWrapRef.current || !content) return;
    let cancelled = false;

    const render = async () => {
      setRendering(true);
      try {
        let cleaned = content.trim();
        if (cleaned.startsWith('```mermaid')) {
          cleaned = cleaned.replace(/^```mermaid\n/, '').replace(/\n```$/, '');
        }
        // Strip leading %% comments
        const lines = cleaned.split('\n');
        let firstDiagramLine = 0;
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (line === '' || line.startsWith('%%')) continue;
          firstDiagramLine = i;
          break;
        }
        if (firstDiagramLine > 0) {
          cleaned = lines.slice(firstDiagramLine).join('\n');
        }
        // Replace full-width characters
        cleaned = cleaned
          .replace(/｜/g, '|')
          .replace(/【/g, '[')
          .replace(/】/g, ']')
          .replace(/：/g, ': ')
          .replace(/，/g, ', ');

        const isDark = document.documentElement.classList.contains('dark');
        mermaid.initialize({
          startOnLoad: false,
          theme: isDark ? 'dark' : 'default',
          securityLevel: 'loose',
          fontFamily: '"Noto Sans TC", "Microsoft JhengHei", system-ui, sans-serif',
          er: { fontSize: 14, useMaxWidth: false },
          themeVariables: isDark ? {
            primaryColor: '#3b82f6', primaryTextColor: '#e5e7eb', primaryBorderColor: '#60a5fa',
            lineColor: '#6b7280', secondaryColor: '#1e3a5f', tertiaryColor: '#1f2937',
            mainBkg: '#1f2937', nodeBorder: '#4b5563', nodeTextColor: '#e5e7eb',
            edgeLabelBackground: '#374151', titleColor: '#f3f4f6',
          } : {
            primaryColor: '#3b82f6', primaryTextColor: '#1f2937', primaryBorderColor: '#93c5fd',
            lineColor: '#6b7280', secondaryColor: '#dbeafe', tertiaryColor: '#f0f9ff',
          },
        });

        const id = `mermaid-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const { svg } = await mermaid.render(id, cleaned);

        if (!cancelled && svgWrapRef.current) {
          svgWrapRef.current.innerHTML = svg;
          setError(null);

          const svgEl = svgWrapRef.current.querySelector('svg');
          if (svgEl) {
            svgEl.style.maxWidth = 'none';
            svgEl.removeAttribute('height');
            const bbox = svgEl.getBBox?.();
            const w = bbox ? bbox.width + bbox.x * 2 + 40 : svgEl.clientWidth || 1200;
            const h = bbox ? bbox.height + bbox.y * 2 + 40 : svgEl.clientHeight || 800;
            svgEl.setAttribute('width', String(Math.max(w, 400)));
            svgEl.setAttribute('height', String(Math.max(h, 300)));
            svgSize.current = { w: Math.max(w, 400), h: Math.max(h, 300) };

            if (canvasRef.current) {
              fitToView();
            }
          }
        }
      } catch (err) {
        if (!cancelled) {
          setError((err as Error).message);
          if (svgWrapRef.current) svgWrapRef.current.innerHTML = '';
        }
      } finally {
        if (!cancelled) setRendering(false);
      }
    };

    render();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content]);

  const fitToView = useCallback(() => {
    if (!canvasRef.current) return;
    const cw = canvasRef.current.clientWidth;
    const ch = canvasRef.current.clientHeight;
    const sw = svgSize.current.w || 1200;
    const sh = svgSize.current.h || 800;
    const scaleX = (cw - 40) / sw;
    const scaleY = (ch - 40) / sh;
    const scale = Math.min(scaleX, scaleY, 1.5);
    const x = (cw - sw * scale) / 2;
    const y = (ch - sh * scale) / 2;
    setTransform({ x, y, scale });
  }, []);

  // Wheel = zoom at cursor
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const delta = e.ctrlKey ? -e.deltaY * 0.01 : -e.deltaY * 0.003;
      const factor = Math.pow(2, delta);
      setTransform((t) => {
        const newScale = Math.max(0.05, Math.min(8, t.scale * factor));
        const ratio = newScale / t.scale;
        return { x: cx - (cx - t.x) * ratio, y: cy - (cy - t.y) * ratio, scale: newScale };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Drag to pan
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    setDragging(true);
    dragOrigin.current = { x: e.clientX, y: e.clientY, tx: transform.x, ty: transform.y };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  }, [transform.x, transform.y]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging) return;
    const dx = e.clientX - dragOrigin.current.x;
    const dy = e.clientY - dragOrigin.current.y;
    setTransform((t) => ({ ...t, x: dragOrigin.current.tx + dx, y: dragOrigin.current.ty + dy }));
  }, [dragging]);

  const handlePointerUp = useCallback(() => setDragging(false), []);
  const handleDoubleClick = useCallback(() => fitToView(), [fitToView]);

  const exportPng = useCallback(async () => {
    const svgEl = svgWrapRef.current?.querySelector('svg');
    if (!svgEl || exporting) return;
    setExporting(true);
    try {
      const w = svgSize.current.w || 1200;
      const h = svgSize.current.h || 800;
      const isDark = document.documentElement.classList.contains('dark');
      // Clone SVG, add background rect
      const clone = svgEl.cloneNode(true) as SVGElement;
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      clone.setAttribute('width', String(w));
      clone.setAttribute('height', String(h));
      const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      bg.setAttribute('x', '0'); bg.setAttribute('y', '0');
      bg.setAttribute('width', String(w)); bg.setAttribute('height', String(h));
      bg.setAttribute('fill', isDark ? '#1f2937' : '#ffffff');
      clone.insertBefore(bg, clone.firstChild);

      const svgStr = new XMLSerializer().serializeToString(clone);
      const blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const scale = 2;
      const canvas = document.createElement('canvas');
      canvas.width = w * scale; canvas.height = h * scale;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.scale(scale, scale);
      await new Promise<void>((resolve, reject) => {
        const img = new Image();
        img.onload = () => { ctx.drawImage(img, 0, 0, w, h); URL.revokeObjectURL(url); resolve(); };
        img.onerror = reject;
        img.src = url;
      });
      const a = document.createElement('a');
      a.download = filename;
      a.href = canvas.toDataURL('image/png');
      a.click();
    } finally {
      setExporting(false);
    }
  }, [filename, exporting]);

  const pct = Math.round(transform.scale * 100);

  const isFullHeight = height === '100%';

  return (
    <div className={`relative flex flex-col ${isFullHeight ? 'h-full' : ''}`}>
      {/* Toolbar */}
      <div className="absolute top-3 right-3 z-10 flex items-center gap-1.5 bg-card/90 backdrop-blur rounded-lg shadow-md border border-border px-2 py-1">
        <button onClick={() => setTransform((t) => {
          const cw = canvasRef.current?.clientWidth || 0;
          const ch = canvasRef.current?.clientHeight || 0;
          const cx = cw / 2; const cy = ch / 2;
          const newScale = Math.max(0.05, t.scale / 1.3);
          const ratio = newScale / t.scale;
          return { x: cx - (cx - t.x) * ratio, y: cy - (cy - t.y) * ratio, scale: newScale };
        })} className="w-7 h-7 flex items-center justify-center rounded hover:bg-muted text-muted-foreground text-sm font-mono">-</button>
        <span className="text-[11px] text-muted-foreground min-w-[2.5rem] text-center tabular-nums">{pct}%</span>
        <button onClick={() => setTransform((t) => {
          const cw = canvasRef.current?.clientWidth || 0;
          const ch = canvasRef.current?.clientHeight || 0;
          const cx = cw / 2; const cy = ch / 2;
          const newScale = Math.min(8, t.scale * 1.3);
          const ratio = newScale / t.scale;
          return { x: cx - (cx - t.x) * ratio, y: cy - (cy - t.y) * ratio, scale: newScale };
        })} className="w-7 h-7 flex items-center justify-center rounded hover:bg-muted text-muted-foreground text-sm font-mono">+</button>
        <div className="w-px h-4 bg-border mx-0.5" />
        <button onClick={fitToView} className="px-2 h-7 flex items-center justify-center rounded hover:bg-muted text-[11px] text-muted-foreground" title="Fit to view (double-click)">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" /></svg>
        </button>
        <button onClick={() => setTransform({ x: 0, y: 0, scale: 1 })} className="px-2 h-7 flex items-center justify-center rounded hover:bg-muted text-[11px] text-muted-foreground" title="1:1">1:1</button>
        <div className="w-px h-4 bg-border mx-0.5" />
        <button
          onClick={exportPng}
          disabled={exporting || rendering || !!error}
          className="px-2 h-7 flex items-center justify-center gap-1 rounded hover:bg-muted text-[11px] text-muted-foreground disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          title="Export as PNG"
        >
          {exporting ? (
            <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
          ) : (
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
          )}
          PNG
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="m-3 p-3 bg-red-500/10 rounded-lg text-sm text-red-500">
          <div className="font-medium mb-1">Mermaid render error</div>
          <div className="text-xs">{error}</div>
          <details className="mt-2">
            <summary className="cursor-pointer text-xs">Raw content</summary>
            <pre className="mt-2 text-xs bg-muted p-2 rounded overflow-auto max-h-48">{content}</pre>
          </details>
        </div>
      )}

      {/* Loading */}
      {rendering && !error && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/50 z-10">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <svg className="w-5 h-5 animate-spin" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            Rendering diagram...
          </div>
        </div>
      )}

      {/* Canvas */}
      <div
        ref={canvasRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onDoubleClick={handleDoubleClick}
        className={`relative overflow-hidden rounded-xl border border-border ${dragging ? 'cursor-grabbing' : 'cursor-grab'}`}
        style={{
          height,
          background: 'radial-gradient(circle, var(--color-border) 1px, transparent 1px)',
          backgroundSize: '20px 20px',
          touchAction: 'none',
        }}
      >
        <div
          ref={svgWrapRef}
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            transformOrigin: '0 0',
            transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
            willChange: 'transform',
          }}
        />
      </div>

      {/* Hints */}
      <div className="flex items-center justify-center gap-4 mt-2 text-[10px] text-muted-foreground">
        <span>Scroll to zoom</span>
        <span>Drag to pan</span>
        <span>Double-click to fit</span>
      </div>
    </div>
  );
}
