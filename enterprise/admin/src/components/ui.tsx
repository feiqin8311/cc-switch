import {
  type ButtonHTMLAttributes,
  type ReactNode,
  useEffect,
  useId,
  useRef,
} from "react";
import { Inbox, X } from "lucide-react";
import { describeError } from "../lib/format";

// ---------------------------------------------------------------------------
// Buttons & inputs
// ---------------------------------------------------------------------------

type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-[#1f1e1d] text-white hover:bg-[#34322e] active:scale-[0.98] shadow-xs disabled:bg-[#1f1e1d]/50 dark:bg-[#f5f3ed] dark:text-[#1f1e1d] dark:hover:bg-[#e2dfd5]",
  secondary:
    "border border-[#ded9ce] bg-white text-[#24221f] hover:bg-[#f7f5ef] active:scale-[0.98] shadow-2xs dark:border-[#383630] dark:bg-[#201f1b] dark:text-[#f5f3ed] dark:hover:bg-[#282622]",
  danger:
    "bg-[#dc382d] text-white hover:bg-[#c5281e] active:scale-[0.98] shadow-xs disabled:bg-[#dc382d]/50 dark:bg-[#dc382d] dark:hover:bg-[#c5281e]",
  ghost:
    "text-[#696459] hover:bg-[#ede9df] hover:text-[#24221f] active:scale-[0.98] dark:text-[#9e9a8f] dark:hover:bg-[#282622] dark:hover:text-[#f5f3ed]",
};

export function Button({
  variant = "secondary",
  size = "md",
  className = "",
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: "sm" | "md";
}) {
  const sizing =
    size === "sm" ? "h-7.5 px-2.5 text-xs rounded-lg" : "h-9 px-3.5 text-sm rounded-xl";
  return (
    <button
      type={type}
      className={`inline-flex shrink-0 items-center justify-center gap-1.5 font-medium whitespace-nowrap transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-60 cursor-pointer ${sizing} ${BUTTON_VARIANTS[variant]} ${className}`}
      {...props}
    />
  );
}

export const inputClass =
  "h-9 w-full rounded-xl border border-[#ded9ce] bg-white px-3 text-sm text-[#24221f] outline-none placeholder:text-[#a09c91] transition-all focus:border-[#c9643b] focus:ring-2 focus:ring-[#c9643b]/15 disabled:bg-[#f5f3ec] disabled:text-[#a09c91] aria-[invalid=true]:border-[#dc382d] shadow-2xs dark:border-[#383630] dark:bg-[#181715] dark:text-[#f5f3ed] dark:placeholder:text-[#6e6b62] dark:disabled:bg-[#22211e] dark:focus:border-[#d97746] dark:focus:ring-[#d97746]/20";

export const textareaClass =
  "min-h-24 w-full rounded-xl border border-[#ded9ce] bg-white p-3 text-sm text-[#24221f] outline-none placeholder:text-[#a09c91] transition-all focus:border-[#c9643b] focus:ring-2 focus:ring-[#c9643b]/15 disabled:bg-[#f5f3ec] disabled:text-[#a09c91] aria-[invalid=true]:border-[#dc382d] shadow-2xs dark:border-[#383630] dark:bg-[#181715] dark:text-[#f5f3ed] dark:placeholder:text-[#6e6b62] dark:disabled:bg-[#22211e] dark:focus:border-[#d97746] dark:focus:ring-[#d97746]/20";

export function Field({
  label,
  htmlFor,
  error,
  hint,
  required,
  children,
  className = "",
}: {
  label: ReactNode;
  htmlFor?: string;
  error?: string;
  hint?: ReactNode;
  required?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex flex-col gap-1.5 ${className}`}>
      <label
        htmlFor={htmlFor}
        className="text-xs font-medium text-[#5c584d] dark:text-[#a39f93] tracking-tight"
      >
        {label}
        {required && <span className="ml-0.5 text-[#dc382d]">*</span>}
      </label>
      {children}
      {error ? (
        <p role="alert" className="text-xs text-[#dc382d] dark:text-[#f28b82]">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-[#7c776c] dark:text-[#9e9a8f]">{hint}</p>
      ) : null}
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  disabled,
  label,
  id,
}: {
  checked: boolean;
  onChange(next: boolean): void;
  disabled?: boolean;
  label: string;
  id?: string;
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 ${checked ? "bg-[#c9643b] dark:bg-[#d97746]" : "bg-[#ded9ce] dark:bg-[#383630]"}`}
    >
      <span
        className={`inline-block size-4 rounded-full bg-white shadow-sm transition-transform ${checked ? "translate-x-4.5" : "translate-x-0.5"}`}
      />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

type BadgeTone = "gray" | "green" | "red" | "blue" | "amber" | "purple";

const BADGE_TONES: Record<BadgeTone, string> = {
  gray: "bg-[#f0ece3] text-[#5c584d] dark:bg-[#2b2925] dark:text-[#b0ac9f]",
  green:
    "bg-[#e6f4ea] text-[#137333] dark:bg-[#163821] dark:text-[#81c995]",
  red: "bg-[#fce8e6] text-[#c5221f] dark:bg-[#3d1e1c] dark:text-[#f28b82]",
  blue: "bg-[#faece3] text-[#c9643b] dark:bg-[#38231a] dark:text-[#e8906c]",
  amber: "bg-[#fef7e0] text-[#b06000] dark:bg-[#3a2f18] dark:text-[#fdd663]",
  purple:
    "bg-[#f3e8fd] text-[#7627bb] dark:bg-[#2e1d3d] dark:text-[#d7aefb]",
};

export function Badge({
  tone = "gray",
  children,
}: {
  tone?: BadgeTone;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap tracking-tight ${BADGE_TONES[tone]}`}
    >
      {children}
    </span>
  );
}

export function Spinner({ className = "" }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`inline-block size-4 animate-spin rounded-full border-2 border-current border-t-transparent ${className}`}
    />
  );
}

export function LoadingState({ label = "加载中…" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-[#7c776c] dark:text-[#9e9a8f]">
      <Spinner />
      <span className="text-sm">{label}</span>
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  children,
}: {
  icon?: ReactNode;
  title?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
      <div className="size-12 rounded-2xl bg-[#f2efe8] text-[#8c877b] flex items-center justify-center mb-3.5 shadow-2xs dark:bg-[#282622] dark:text-[#8e8a7f]">
        {icon ?? <Inbox className="size-6 stroke-[1.5]" />}
      </div>
      {title && (
        <h3 className="font-serif text-base font-medium text-[#24221f] dark:text-[#f5f3ed] mb-1">
          {title}
        </h3>
      )}
      <div className="text-sm text-[#7c776c] dark:text-[#9e9a8f] max-w-sm">
        {children}
      </div>
    </div>
  );
}

export function ErrorState({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex flex-col items-center gap-3 py-16 text-[#c5221f] dark:text-[#f28b82]"
    >
      <span className="text-sm">加载失败：{describeError(error)}</span>
      {onRetry && (
        <Button size="sm" onClick={onRetry}>
          重试
        </Button>
      )}
    </div>
  );
}

export function InlineError({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <div
      role="alert"
      className="rounded-xl border border-[#fad2cf] bg-[#fdf2f2] px-3.5 py-2 text-sm text-[#c5221f] dark:border-[#4a1f1d] dark:bg-[#2d1615] dark:text-[#f28b82]"
    >
      {children}
    </div>
  );
}

export function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-xl border border-[#f0dacd] bg-[#fbf5f0] px-4 py-2.5 text-sm text-[#8a4220] dark:border-[#42291d] dark:bg-[#2b1b14] dark:text-[#e8906c]">
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="font-serif text-[28px] md:text-[32px] leading-tight tracking-tight font-normal text-[#24221f] dark:text-[#f5f3ed]">
          {title}
        </h1>
        {description && (
          <p className="mt-1.5 text-sm text-[#7c776c] dark:text-[#9e9a8f] leading-relaxed max-w-2xl">
            {description}
          </p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2 pt-1">{actions}</div>}
    </div>
  );
}

export function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-2xl border border-[#ebe7df] bg-white shadow-xs dark:border-[#2e2c28] dark:bg-[#201f1b] ${className}`}
    >
      {children}
    </div>
  );
}

export const tableClass = "w-full border-collapse text-left text-sm";
export const thClass =
  "sticky top-0 border-b border-[#ebe7df] bg-[#faf8f5]/95 backdrop-blur-xs px-4 py-3 text-xs font-medium whitespace-nowrap text-[#7c776c] tracking-tight dark:border-[#2e2c28] dark:bg-[#181715]/95 dark:text-[#9e9a8f]";
export const tdClass =
  "border-b border-[#f2efe8] px-4 py-3.5 align-middle text-[#24221f] dark:border-[#282622] dark:text-[#f5f3ed]";
export const trClass = "hover:bg-[#faf8f5] transition-colors dark:hover:bg-[#262420]";

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

export function Dialog({
  open,
  title,
  onClose,
  children,
  footer,
  width = "max-w-lg",
}: {
  open: boolean;
  title: string;
  onClose(): void;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
}) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const first = panel.current?.querySelector<HTMLElement>(
      "input:not([disabled]), select:not([disabled]), textarea:not([disabled])",
    );
    (first ?? panel.current)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/35 backdrop-blur-xs p-4 pt-[8vh]">
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`w-full ${width} rounded-2xl border border-[#ebe7df] bg-white shadow-2xl outline-none dark:border-[#2e2c28] dark:bg-[#201f1b] overflow-hidden`}
      >
        <div className="flex items-center justify-between border-b border-[#ebe7df] px-6 py-4 dark:border-[#2e2c28]">
          <h2 id={titleId} className="font-serif text-lg font-medium text-[#24221f] dark:text-[#f5f3ed]">
            {title}
          </h2>
          <button
            type="button"
            aria-label="关闭"
            onClick={onClose}
            className="flex size-7 items-center justify-center rounded-lg text-[#7c776c] hover:bg-[#f2efe8] hover:text-[#24221f] transition-colors cursor-pointer dark:text-[#9e9a8f] dark:hover:bg-[#282622] dark:hover:text-[#f5f3ed]"
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="px-6 py-5">{children}</div>
        {footer && (
          <div className="flex justify-end gap-2.5 border-t border-[#ebe7df] px-6 py-4 bg-[#fbfaf7] dark:bg-[#181715] dark:border-[#2e2c28]">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "确定",
  danger,
  pending,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  pending?: boolean;
  onConfirm(): void;
  onCancel(): void;
  }) {
  return (
    <Dialog
      open={open}
      title={title}
      onClose={onCancel}
      width="max-w-md"
      footer={
        <>
          <Button onClick={onCancel} disabled={pending}>
            取消
          </Button>
          <Button
            variant={danger ? "danger" : "primary"}
            onClick={onConfirm}
            disabled={pending}
          >
            {pending && <Spinner className="size-3" />}
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-sm text-[#5c584d] dark:text-[#a39f93] leading-relaxed">
        {message}
      </div>
    </Dialog>
  );
}
