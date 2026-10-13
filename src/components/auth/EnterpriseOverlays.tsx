import { RetentionNoticeDialog } from "./RetentionNoticeDialog";

/**
 * Enterprise dialogs and background hooks that must be mounted once,
 * independent of the current view. Each enterprise feature adds one line here.
 */
export function EnterpriseOverlays() {
  return (
    <>
      <RetentionNoticeDialog />
    </>
  );
}
