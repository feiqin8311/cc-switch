import { Asterisk } from "lucide-react";

export function BrandMark({ className = "size-5 text-brand" }: { className?: string }) {
  return (
    <Asterisk
      aria-hidden="true"
      strokeWidth={2.75}
      className={className}
    />
  );
}
