import { useToastStore } from '../../stores/toastStore';

const TYPE_STYLES: Record<string, { bg: string; border: string; icon: string }> = {
  info: { bg: 'bg-blue-500/10', border: 'border-blue-500/30', icon: 'i' },
  success: { bg: 'bg-green-500/10', border: 'border-green-500/30', icon: '\u2713' },
  error: { bg: 'bg-red-500/10', border: 'border-red-500/30', icon: '\u2717' },
  warning: { bg: 'bg-yellow-500/10', border: 'border-yellow-500/30', icon: '!' },
};

const TYPE_TEXT: Record<string, string> = {
  info: 'text-blue-400',
  success: 'text-green-400',
  error: 'text-red-400',
  warning: 'text-yellow-400',
};

export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts);
  const removeToast = useToastStore((s) => s.removeToast);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[9999] flex flex-col gap-2 max-w-sm">
      {toasts.map((toast) => {
        const style = TYPE_STYLES[toast.type] || TYPE_STYLES.info;
        const textColor = TYPE_TEXT[toast.type] || TYPE_TEXT.info;

        return (
          <div
            key={toast.id}
            className={`${style.bg} ${style.border} border rounded-lg px-4 py-3 shadow-lg backdrop-blur-sm animate-in slide-in-from-top-5 duration-200`}
          >
            <div className="flex items-start gap-3">
              <span className={`${textColor} font-bold text-sm mt-0.5 w-4 text-center shrink-0`}>
                {style.icon}
              </span>
              <div className="flex-1 min-w-0">
                <p className={`${textColor} text-sm font-medium`}>{toast.title}</p>
                {toast.message && (
                  <p className="text-xs text-muted-foreground mt-1 break-words">
                    {toast.message}
                  </p>
                )}
              </div>
              <button
                onClick={() => removeToast(toast.id)}
                className="text-muted-foreground hover:text-foreground text-sm shrink-0 ml-2"
              >
                x
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
