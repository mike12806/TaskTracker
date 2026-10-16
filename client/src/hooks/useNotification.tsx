import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { Alert, Snackbar, type SnackbarCloseReason } from "@mui/material";

type Severity = "error" | "warning" | "info" | "success";

interface NotificationContextType {
  notify: (message: string, severity?: Severity) => void;
  /**
   * A success message with an action beside it — Undo, after a completion.
   * `renderAction` gets a `close` so the action can take the toast down.
   */
  notifyWithAction: (message: string, renderAction: (close: () => void) => ReactNode) => void;
}

const NotificationContext = createContext<NotificationContextType>({
  notify: () => {},
  notifyWithAction: () => {},
});

export function NotificationProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [severity, setSeverity] = useState<Severity>("info");
  const [action, setAction] = useState<((close: () => void) => ReactNode) | null>(null);

  const notify = useCallback((msg: string, sev: Severity = "info") => {
    setMessage(msg);
    setSeverity(sev);
    setAction(null);
    setOpen(true);
  }, []);

  const notifyWithAction = useCallback((msg: string, renderAction: (close: () => void) => ReactNode) => {
    setMessage(msg);
    setSeverity("success");
    // Wrapped: a function passed to a state setter is called as an updater.
    setAction(() => renderAction);
    setOpen(true);
  }, []);

  const close = () => setOpen(false);

  const handleClose = (_event?: React.SyntheticEvent | Event | null, reason?: SnackbarCloseReason) => {
    if (reason === "clickaway") return;
    setOpen(false);
  };

  return (
    <NotificationContext.Provider value={{ notify, notifyWithAction }}>
      {children}
      <Snackbar
        open={open}
        // Longer with an Undo on it: an undo that expires while you are
        // still reading it is not much of an undo.
        autoHideDuration={action ? 8000 : 5000}
        onClose={handleClose}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
        sx={{ bottom: { xs: "calc(84px + env(safe-area-inset-bottom))", md: 24 } }}
      >
        <Alert onClose={handleClose} severity={severity} action={action ? action(close) : undefined} sx={{ width: "100%", alignItems: "center" }}>
          {message}
        </Alert>
      </Snackbar>
    </NotificationContext.Provider>
  );
}

export function useNotification() {
  return useContext(NotificationContext);
}
