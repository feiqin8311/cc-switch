import {
  type ButtonHTMLAttributes,
  type ReactNode,
  useEffect,
  useId,
  useRef,
} from "react";
import { Inbox, X } from "lucide-react";
import { BrandMark } from "./BrandMark";
import { describeError } from "../lib/format";

// ---------------------------------------------------------------------------
// Buttons & inputs
// ---------------------------------------------------------------------------

type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-primary text-primary-foreground hover:bg-primary/90 active:scale-[0.98] shadow-xs disabled:opacity-50",
  secondary:
    "border border-border bg-card text-foreground hover:bg-muted hover:text-foreground active:scale-[0.98] shadow-2xs disabled:opacity-50",
  danger:
    "bg-destructive text-destructive-foreground hover:bg-destructive/90 active:scale-[0.98] shadow-xs disabled:opacity-50",
  ghost:
    "text-muted-foreground hover:bg-muted hover:text-foreground active:scale-[0.98] disabled:opacity-50",
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
    size === "sm"
      ? "h-7 px-2.5 text-xs rounded-md gap-1"
      : "h-8 px-3 text-sm rounded-lg gap-1.5";
  return (
    <button
      type={type}
      className={`inline-flex shrink-0 items-center justify-center font-medium whitespace-nowrap transition-colors cursor-pointer disabled:cursor-not-allowed ${sizing} ${BUTTON_VARIANTS[variant]} ${className}`}
      {...props}
    />
  );
}

export const inputClass =
  "h-8 w-full rounded-lg border border-input bg-card px-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground transition-colors focus:border-ring focus:ring-1 focus:ring-ring disabled:bg-muted disabled:text-muted-foreground aria-[invalid=true]:border-destructive shadow-2xs";

export const textareaClass =
  "min-h-24 w-full rounded-lg border border-input bg-card p-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground transition-colors focus:border-ring focus:ring-1 focus:ring-ring disabled:bg-muted disabled:text-muted-foreground aria-[invalid=true]:border-destructive shadow-2xs";

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
    <div className={`flex flex-col gap-1 ${className}`}>
      <label
        htmlFor={htmlFor}
        className="text-[11px] font-medium text-muted-foreground tracking-tight"
      >
        {label}
        {required && <span className="ml-0.5 text-destructive">*</span>}
      </label>
      {children}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : hint ? (
        <p className="text-[11px] text-muted-foreground">{hint}</p>
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
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 ${
        checked ? "bg-brand" : "bg-muted-foreground/30"
      }`}
    >
      <span
        className={`inline-block size-4 rounded-full bg-white shadow-sm transition-transform ${
          checked ? "translate-x-4.5" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

type BadgeTone = "gray" | "green" | "red" | "blue" | "amber" | "purple";

const BADGE_TONES: Record<BadgeTone, string> = {
  gray: "bg-muted text-muted-foreground",
  green: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  red: "bg-destructive/10 text-destructive",
  blue: "bg-brand/10 text-brand",
  amber: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  purple: "bg-purple-500/10 text-purple-600 dark:text-purple-400",
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
      className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap tracking-tight ${BADGE_TONES[tone]}`}
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
    <div className="flex items-center justify-center gap-2 py-12 text-muted-foreground">
      <Spinner />
      <span className="text-xs">{label}</span>
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
    <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
      <div className="size-10 rounded-xl bg-muted flex items-center justify-center text-muted-foreground mb-2.5">
        {icon ?? <Inbox className="size-5 stroke-[1.5]" />}
      </div>
      {title && (
        <h3 className="font-serif text-sm font-medium text-foreground mb-0.5">
          {title}
        </h3>
      )}
      <div className="text-xs text-muted-foreground max-w-sm">
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
      className="flex flex-col items-center gap-2.5 py-12 text-destructive"
    >
      <span className="text-xs">加载失败：{describeError(error)}</span>
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
      className="rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-1.5 text-xs text-destructive"
    >
      {children}
    </div>
  );
}

export function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-brand/20 bg-brand/5 px-3.5 py-2 text-xs text-foreground leading-relaxed">
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
        <div className="flex items-center gap-2.5">
          <BrandMark className="size-6 text-brand" />
          <h1 className="font-serif text-2xl font-normal tracking-tight text-foreground md:text-[28px]">
            {title}
          </h1>
        </div>
        {description && (
          <p className="mt-1 text-xs text-muted-foreground leading-relaxed max-w-2xl">
            {description}
          </p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2 pt-0.5">{actions}</div>}
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
      className={`rounded-2xl border border-border/80 bg-card p-5 shadow-sm ${className}`}
    >
      {children}
    </div>
  );
}

export const tableClass = "w-full border-collapse text-left text-xs";
export const thClass =
  "sticky top-0 border-b border-border/60 bg-muted/40 px-3 py-2 text-[11px] font-medium whitespace-nowrap text-muted-foreground uppercase tracking-wider";
export const tdClass =
  "border-b border-border/40 px-3 py-2.5 align-middle text-foreground";
export const trClass = "hover:bg-muted/40 transition-colors";

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
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 backdrop-blur-xs p-4 pt-[8vh]">
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`w-full ${width} rounded-2xl border border-border/80 bg-card shadow-xl outline-none overflow-hidden`}
      >
        <div className="flex items-center justify-between border-b border-border/50 px-5 py-3.5">
          <h2 id={titleId} className="font-serif text-base font-normal text-foreground">
            {title}
          </h2>
          <button
            type="button"
            aria-label="关闭"
            onClick={onClose}
            className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors cursor-pointer"
          >
            <X className="size-3.5" />
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer && (
          <div className="flex justify-end gap-2 border-t border-border/50 px-5 py-3 bg-muted/20">
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
      <div className="text-xs text-muted-foreground leading-relaxed">
        {message}
      </div>
    </Dialog>
  );
}
