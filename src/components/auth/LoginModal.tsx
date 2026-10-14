import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Building2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/contexts/AuthContext";

const DEFAULT_SERVER_URL =
  (import.meta.env?.VITE_ENTERPRISE_SERVER_URL as string | undefined) ||
  "http://127.0.0.1:28473";

interface LoginModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function EnterpriseLoginForm({
  active,
  variant = "dialog",
  onCancel,
  onLoggedIn,
}: {
  active: boolean;
  /** `page` is the blocking first screen: no cancel, plain heading. */
  variant?: "dialog" | "page";
  onCancel?: () => void;
  onLoggedIn?: () => void;
}) {
  const { t } = useTranslation();
  const { state, login } = useAuth();
  const [serverUrl, setServerUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!active) return;
    setServerUrl(state.serverUrl ?? DEFAULT_SERVER_URL);
    setPassword("");
    setError(null);
  }, [active, state.serverUrl]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await login(serverUrl.trim(), username.trim(), password);
      setPassword("");
      onLoggedIn?.();
    } catch (err) {
      setError(String(err) || t("enterprise.loginFailed"));
    } finally {
      setSubmitting(false);
    }
  };

  const title = (
    <>
      <Building2 className="h-5 w-5 text-fg-1" />
      {t("enterprise.loginTitle")}
    </>
  );
  const hint = t(
    variant === "page" ? "enterprise.loginRequired" : "enterprise.loginHint",
  );

  return (
    <form onSubmit={handleSubmit}>
      {variant === "page" ? (
        <div className="flex flex-col gap-1 px-6 pb-3 pt-5 text-start">
          <h1 className="flex items-center gap-2 text-title font-semibold text-fg-1">
            {title}
          </h1>
        </div>
      ) : (
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">{title}</DialogTitle>
        </DialogHeader>
      )}
      <div className="space-y-4 px-6 py-5">
        {variant === "page" ? (
          <p className="text-sm text-fg-2">{hint}</p>
        ) : (
          <DialogDescription>{hint}</DialogDescription>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="enterprise-server">{t("enterprise.serverUrl")}</Label>
          <Input
            id="enterprise-server"
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
            placeholder="https://ai.example.com"
            autoComplete="url"
            required
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="enterprise-username">
            {t("enterprise.username")}
          </Label>
          <Input
            id="enterprise-username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoFocus
            required
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="enterprise-password">
            {t("enterprise.password")}
          </Label>
          <Input
            id="enterprise-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </div>
        {error && (
          <p role="alert" className="text-body text-danger">
            {error}
          </p>
        )}
      </div>
      <DialogFooter>
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
        )}
        <Button type="submit" disabled={submitting}>
          {submitting ? t("enterprise.loggingIn") : t("enterprise.login")}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function LoginModal({ open, onOpenChange }: LoginModalProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" zIndex="top">
        <EnterpriseLoginForm
          active={open}
          onCancel={() => onOpenChange(false)}
          onLoggedIn={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

export function LoginFormCard({ children }: { children: ReactNode }) {
  return (
    <div className="w-full max-w-md rounded-dialog border border-border bg-surface text-fg-1 shadow-v7-lg">
      {children}
    </div>
  );
}
