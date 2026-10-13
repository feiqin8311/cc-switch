import { useEffect, useState, type FormEvent } from "react";
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

export function LoginModal({ open, onOpenChange }: LoginModalProps) {
  const { t } = useTranslation();
  const { state, login } = useAuth();
  const [serverUrl, setServerUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setServerUrl(state.serverUrl ?? DEFAULT_SERVER_URL);
    setPassword("");
    setError(null);
  }, [open, state.serverUrl]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await login(serverUrl.trim(), username.trim(), password);
      setPassword("");
      onOpenChange(false);
    } catch (err) {
      setError(String(err) || t("enterprise.loginFailed"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" zIndex="top">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Building2 className="h-5 w-5 text-fg-1" />
              {t("enterprise.loginTitle")}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 px-6 py-5">
            <DialogDescription>{t("enterprise.loginHint")}</DialogDescription>
            <div className="space-y-1.5">
              <Label htmlFor="enterprise-server">
                {t("enterprise.serverUrl")}
              </Label>
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
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? t("enterprise.loggingIn") : t("enterprise.login")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
