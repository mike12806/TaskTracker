import { useEffect, useState } from "react";
import { Alert, Button, Snackbar } from "@mui/material";
import { usePushNotifications } from "../hooks/usePushNotifications";
import { isUserBusy } from "../utils/interruptions";

/**
 * A nudge to turn on reminder notifications, shown every time the app is
 * foregrounded while push is still off.
 *
 * Push permission has to be requested from a real user tap (iOS won't grant
 * it otherwise), and the browser only ever asks once — decline it silently
 * by ignoring a one-time prompt and there's no second chance from the OS
 * side. So this keeps asking on the app's own terms instead: dismissing it
 * only closes *this* appearance, not the nudge for good. The permanent
 * toggle lives on the Settings page for anyone who'd rather turn it on from
 * there.
 */
export default function PushNotificationsNudge() {
  const { supported, permission, subscribed, working, subscribe } = usePushNotifications();
  const [open, setOpen] = useState(false);

  const eligible = supported && permission === "default" && !subscribed;

  useEffect(() => {
    if (!eligible) return;

    // A brief delay so this doesn't compete with the page's first paint.
    // Not over an open dialog or a half-typed task: the snackbar sits above
    // modals, and would cover the very field someone is typing in.
    const showSoon = () => {
      window.setTimeout(() => {
        if (!isUserBusy()) setOpen(true);
      }, 2000);
    };

    showSoon();

    const onVisible = () => {
      if (document.visibilityState === "visible") showSoon();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [eligible]);

  if (!eligible) return null;

  const handleEnable = () => {
    subscribe()
      .catch(() => {})
      .finally(() => setOpen(false));
  };

  return (
    <Snackbar
      open={open}
      anchorOrigin={{ vertical: "top", horizontal: "center" }}
      sx={{ top: { xs: "calc(56px + env(safe-area-inset-top) + 8px)", md: "72px" } }}
    >
      <Alert
        severity="info"
        variant="filled"
        onClose={() => setOpen(false)}
        action={
          <Button color="inherit" size="small" onClick={handleEnable} disabled={working} sx={{ fontWeight: 700 }}>
            Enable
          </Button>
        }
        sx={{ alignItems: "center" }}
      >
        Turn on notifications to get task reminders on this device.
      </Alert>
    </Snackbar>
  );
}
