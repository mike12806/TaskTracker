import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Badge,
  Box,
  Button,
  CircularProgress,
  Divider,
  Drawer,
  IconButton,
  Typography,
  useTheme,
} from "@mui/material";
import {
  AlarmRoundedIcon,
  CloseRoundedIcon,
  MarkEmailUnreadRoundedIcon,
  NotificationsNoneRoundedIcon,
  NotificationsOffRoundedIcon,
} from "../icons";
import { dismissAlert, fetchAlerts, markAlertsRead, restoreAlert, unreadAlert } from "../api/alerts";
import { useDataRefresh } from "../hooks/useDataRefresh";
import { usePushNotifications } from "../hooks/usePushNotifications";
import { useNotification } from "../hooks/useNotification";
import { formatRelativeTime } from "../utils/dateTime";
import { closeAnsweredReminderNotifications } from "../utils/reminderNotifications";
import { buildCategoryColors, type CategoryKey } from "../theme/categoryColors";
import type { Alert } from "../types/models";

/**
 * The alerts bell, and the drawer behind it.
 *
 * This is the app's own copy of the notifications it sends — see
 * `server/src/alerts.ts` for why the push alone was not enough. Two things
 * follow from that and are worth not undoing:
 *
 *  - **It is a record, not a second decision.** Nothing here works out whether
 *    a reminder is due; it renders the sentence the server sent, as sent.
 *  - **It is never cached**, like every other read in this app. A closed
 *    drawer holds whatever the last fetch returned, and the feed refetches
 *    with everything else on `refreshKey`.
 *  - **It tidies the lock screen.** A push is a copy of an alert that lives on
 *    the device, and nothing the server does can retract it. Every successful
 *    fetch closes the reminder notifications this feed no longer accounts for,
 *    so the phone stops nagging about a task once it is done — see
 *    `utils/reminderNotifications.ts`.
 *  - **Dismissing hides, never deletes.** The row is the record of what fired,
 *    and a mis-tap on a small row on a phone is routine, so it comes with an
 *    undo.
 */

const KIND_ICON: Record<Alert["kind"], { icon: React.ReactNode; category: CategoryKey }> = {
  reminder: { icon: <AlarmRoundedIcon sx={{ fontSize: 18 }} />, category: "reminder" },
};

export default function AlertsBell() {
  const [open, setOpen] = useState(false);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  /**
   * The read mark as it stood when the drawer was opened.
   *
   * Opening marks the feed read, which is what clears the badge — but the
   * rows that *were* new still need to be marked for as long as you are
   * looking at them, or the drawer answers "what's new?" with an undifferentiated
   * list. Frozen here for the visit, rather than read from the live feed.
   */
  const [newSince, setNewSince] = useState<string | null>(null);
  /**
   * The alert the undo bar is currently offering to put back.
   *
   * Holds the whole row rather than its id: the list it came out of is
   * rebuilt from the server on every refresh, so by the time Undo is tapped
   * the local copy may be all that is left of it.
   */
  const [undoable, setUndoable] = useState<Alert | null>(null);

  const navigate = useNavigate();
  const { notify } = useNotification();
  const { refreshKey } = useDataRefresh();
  const { supported: pushSupported, subscribed: pushSubscribed, working: pushWorking, subscribe } =
    usePushNotifications();
  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";
  const cat = useMemo(() => buildCategoryColors(isDark), [isDark]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const feed = await fetchAlerts();
      setAlerts(feed.alerts);
      setUnread(feed.unread);
      setFailed(false);
      // The feed is the app's only complete picture of what is still
      // outstanding, so it is also where the lock screen gets tidied: a
      // reminder that has been answered — usually by the task being
      // completed, here or elsewhere — is taken off this device's notifications
      // here. Only on a fetch that succeeded; an empty list from a failed
      // one is not evidence that anything was answered. Not awaited: it is
      // housekeeping, and the badge should not wait on the OS for it.
      void closeAnsweredReminderNotifications(feed.alerts);
      return feed;
    } catch {
      // The bell is garnish next to the numbers on the page behind it — the
      // request is `optional` so it hasn't raised the stale banner, and the
      // badge simply stops claiming a count it can't stand behind.
      setFailed(true);
      setUnread(0);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  // Alongside everything else the app refetches: the foreground poll, coming
  // back to the app, and every save. A bell that only loaded once would go on
  // showing the count from whenever the app was opened.
  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const handleOpen = async () => {
    setOpen(true);
    const feed = await load();
    if (!feed) return;
    setNewSince(feed.last_read_at);
    if (feed.unread === 0) return;
    // Read as far as the newest row that is actually on screen — not "now",
    // which would swallow an alert raised in the seconds since the fetch.
    try {
      await markAlertsRead(feed.alerts[0]?.created_at ?? null);
      setUnread(0);
    } catch {
      // The badge stays up. Better a count that clears on the next visit than
      // one cleared locally against a server that never recorded it.
    }
  };

  /** Closing puts away the undo offer with the list it belongs to. */
  const closeDrawer = () => {
    setOpen(false);
    setUndoable(null);
  };

  const isNew = (alert: Alert) => newSince === null || alert.created_at > newSince;

  /** Newest first, the order the server sends the feed in. */
  const byNewest = (a: Alert, b: Alert) =>
    a.created_at === b.created_at ? b.id - a.id : (a.created_at < b.created_at ? 1 : -1);

  /**
   * Take a row off the list straight away, then tell the server.
   *
   * Optimistic because the alternative is a row that sits there for a round
   * trip after being tapped away. If the server won't take it, the row goes
   * back where it was and the failure is reported — the one thing not to do
   * is leave the screen showing a dismissal that was never recorded.
   */
  const handleDismiss = async (alert: Alert) => {
    setAlerts((current) => current.filter((a) => a.id !== alert.id));
    setUndoable(alert);
    try {
      await dismissAlert(alert.id);
    } catch (err) {
      setAlerts((current) => [...current, alert].sort(byNewest));
      setUndoable(null);
      notify(err instanceof Error ? err.message : "Couldn't dismiss that alert.", "error");
    }
  };

  /**
   * Put a read alert back in front of the read mark.
   *
   * There is no per-alert read flag to flip (see `alerts.ts` on the server) —
   * the mark is a single watermark, so reopening this row necessarily reopens
   * anything raised since it too. `newSince` and `unread` are pushed back to
   * match what the server just recorded, rather than refetching, so the row
   * turns "New" the moment the tap lands.
   */
  const handleMarkUnread = async (alert: Alert) => {
    try {
      const result = await unreadAlert(alert.id);
      setNewSince(result.last_read_at);
      setUnread(alerts.filter((a) => a.created_at > result.last_read_at).length);
    } catch (err) {
      notify(err instanceof Error ? err.message : "Couldn't mark that alert unread.", "error");
    }
  };

  const handleUndo = async (alert: Alert) => {
    setUndoable(null);
    setAlerts((current) => (current.some((a) => a.id === alert.id) ? current : [...current, alert].sort(byNewest)));
    try {
      await restoreAlert(alert.id);
    } catch (err) {
      setAlerts((current) => current.filter((a) => a.id !== alert.id));
      notify(err instanceof Error ? err.message : "Couldn't bring that alert back.", "error");
    }
  };

  const body = (
    <Box sx={{ width: { xs: "86vw", sm: 380 }, maxWidth: 420, display: "flex", flexDirection: "column", height: "100%" }}>
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 1,
          px: 2,
          pt: "calc(env(safe-area-inset-top) + 12px)",
          pb: 1.5,
        }}
      >
        <Typography sx={{ fontSize: 17, fontWeight: 700, letterSpacing: "-0.01em" }}>Alerts</Typography>
        <IconButton size="small" onClick={closeDrawer} aria-label="Close alerts">
          <CloseRoundedIcon sx={{ fontSize: 20 }} />
        </IconButton>
      </Box>
      <Divider />

      <Box sx={{ flex: 1, overflowY: "auto" }}>
        {loading && alerts.length === 0 && (
          <Box sx={{ display: "flex", justifyContent: "center", py: 5 }}>
            <CircularProgress size={22} />
          </Box>
        )}

        {!loading && failed && alerts.length === 0 && (
          <Box sx={{ px: 2.5, py: 5, textAlign: "center" }}>
            <Typography variant="body2" color="text.secondary">
              Couldn't load alerts just now.
            </Typography>
            <Button size="small" onClick={() => void load()} sx={{ mt: 1, textTransform: "none" }}>
              Try again
            </Button>
          </Box>
        )}

        {!loading && !failed && alerts.length === 0 && (
          <Box sx={{ px: 3, py: 6, textAlign: "center" }}>
            <NotificationsNoneRoundedIcon sx={{ fontSize: 34, color: "text.disabled", mb: 1 }} />
            <Typography variant="body2" color="text.secondary">
              Nothing to report.
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.75 }}>
              Task reminders land here when they fire — whether or not this device gets the
              notification.
            </Typography>
          </Box>
        )}

        {alerts.map((alert) => {
          const kind = KIND_ICON[alert.kind] ?? KIND_ICON.reminder;
          const colors = cat[kind.category];
          const fresh = isNew(alert);
          return (
            <Box
              key={alert.id}
              onClick={() => {
                closeDrawer();
                navigate(alert.url || "/");
              }}
              sx={{
                display: "flex",
                gap: 1.5,
                px: 2,
                py: 1.5,
                cursor: "pointer",
                borderBottom: 1,
                borderColor: "divider",
                bgcolor: fresh ? colors.soft : "transparent",
                "&:active": { opacity: 0.75 },
              }}
            >
              <Box
                sx={{
                  flexShrink: 0,
                  width: 32,
                  height: 32,
                  borderRadius: "10px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  bgcolor: colors.tile,
                  color: colors.ink,
                }}
              >
                {kind.icon}
              </Box>
              <Box sx={{ minWidth: 0, flex: 1 }}>
                <Box sx={{ display: "flex", alignItems: "baseline", gap: 1 }}>
                  <Typography sx={{ fontSize: 13, fontWeight: 700, letterSpacing: "-0.005em" }} noWrap>
                    {alert.title}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" sx={{ ml: "auto", flexShrink: 0 }}>
                    {formatRelativeTime(alert.created_at)}
                  </Typography>
                </Box>
                <Typography sx={{ fontSize: 13.5, lineHeight: 1.4, mt: 0.25 }}>{alert.body}</Typography>
                {fresh && (
                  <Typography
                    variant="caption"
                    sx={{ color: colors.ink, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase" }}
                  >
                    New
                  </Typography>
                )}
              </Box>
              {/* stopPropagation on both, or tapping either also navigates
                  away on the same tap — the row itself is the link. Mark-
                  unread only makes sense once a row has actually been read;
                  a fresh one is already what it would produce. */}
              <Box sx={{ display: "flex", flexShrink: 0, alignSelf: "center" }}>
                {!fresh && (
                  <IconButton
                    size="small"
                    aria-label={`Mark unread: ${alert.title}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      void handleMarkUnread(alert);
                    }}
                    sx={{ color: "text.secondary" }}
                  >
                    <MarkEmailUnreadRoundedIcon sx={{ fontSize: 18 }} />
                  </IconButton>
                )}
                <IconButton
                  size="small"
                  aria-label={`Dismiss: ${alert.title}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    void handleDismiss(alert);
                  }}
                  sx={{ color: "text.secondary" }}
                >
                  <CloseRoundedIcon sx={{ fontSize: 18 }} />
                </IconButton>
              </Box>
            </Box>
          );
        })}
      </Box>

      {/* Inline rather than a Snackbar, and deliberately without a timer.
          An open Drawer is a modal, and MUI marks everything outside it
          `aria-hidden` — so a snackbar portalled to the body would be
          invisible to a screen reader for exactly as long as it was on
          offer. In the list it acts on it is reachable, and it waits as long
          as the drawer is open rather than racing a one-handed user. */}
      {undoable && (
        <>
          <Divider />
          <Box sx={{ px: 2, py: 1.25, display: "flex", alignItems: "center", gap: 1 }}>
            <Typography variant="body2" sx={{ fontSize: 12.5, flex: 1 }} color="text.secondary">
              Alert dismissed.
            </Typography>
            <Button
              size="small"
              onClick={() => {
                if (undoable) void handleUndo(undoable);
              }}
              sx={{ textTransform: "none", fontWeight: 700, flexShrink: 0 }}
            >
              Undo
            </Button>
          </Box>
        </>
      )}

      {/* The one place worth saying that push and this list are different
          things: someone reading an alert here days late is exactly the person
          who would rather their phone had told them. */}
      {pushSupported && !pushSubscribed && (
        <>
          <Divider />
          <Box sx={{ px: 2, py: 1.75, display: "flex", alignItems: "center", gap: 1.5 }}>
            <NotificationsOffRoundedIcon sx={{ fontSize: 20, color: "text.secondary", flexShrink: 0 }} />
            <Typography variant="body2" sx={{ fontSize: 12.5, flex: 1 }} color="text.secondary">
              Notifications are off on this device. Alerts still collect here.
            </Typography>
            <Button
              size="small"
              disabled={pushWorking}
              onClick={() => {
                subscribe().catch(() => {});
              }}
              sx={{ textTransform: "none", fontWeight: 700, flexShrink: 0 }}
            >
              Turn on
            </Button>
          </Box>
        </>
      )}
    </Box>
  );

  return (
    <>
      {/* A toggle, not an open button. The app bar sits at `zIndex.drawer + 1`
          (see Layout), so it stays above the drawer's backdrop and the bell
          keeps taking taps while the drawer is open — the backdrop never sees
          them. Without this branch a second tap re-ran the open path against
          an already-open drawer, which from the outside looked like the bell
          had stopped working. */}
      <IconButton
        color="inherit"
        size="small"
        onClick={() => (open ? closeDrawer() : void handleOpen())}
        aria-label={unread > 0 ? `Alerts (${unread} new)` : "Alerts"}
        aria-expanded={open}
        title="Alerts"
        sx={{ minWidth: 36, minHeight: 36 }}
      >
        <Badge
          badgeContent={unread}
          max={99}
          color="error"
          slotProps={{ badge: { sx: { fontSize: 10, height: 16, minWidth: 16 } } }}
        >
          <NotificationsNoneRoundedIcon sx={{ fontSize: 22 }} />
        </Badge>
      </IconButton>

      <Drawer anchor="right" open={open} onClose={closeDrawer}>
        {body}
      </Drawer>
    </>
  );
}
