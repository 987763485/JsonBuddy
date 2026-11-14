import { AlertTriangle, Check, X } from "lucide-react";
import { useAppStore } from "../store";

export function Toast() {
  const toast = useAppStore((state) => state.toast);
  const dismiss = useAppStore((state) => state.dismissToast);
  if (!toast) return null;
  return (
    <div className={`toast toast-${toast.kind}`} role="status" aria-live="polite">
      <span className="toast-icon">
        {toast.kind === "success" ? <Check size={15} /> : <AlertTriangle size={15} />}
      </span>
      <span className="toast-copy">
        <strong>{toast.message}</strong>
        {toast.detail ? <small>{toast.detail}</small> : null}
      </span>
      <button
        type="button"
        className="toast-close"
        onClick={dismiss}
        aria-label="Dismiss"
      >
        <X size={14} />
      </button>
    </div>
  );
}
