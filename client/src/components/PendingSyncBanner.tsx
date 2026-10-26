import { useState } from "react";
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Collapse,
  IconButton,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import { CloudOffIcon, DeleteOutlinedIcon as DeleteOutlineIcon, RefreshIcon } from "../icons";
import {
  OUTBOX_RESOURCES,
  discardEntry,
  flushOutbox,
  retryEntry,
  type OutboxEntry,
} from "../api/outbox";
import { useOutbox } from "../hooks/useOutbox";
import { useNotification } from "../hooks/useNotification";
import { formatRelativeTime } from "../utils/dateTime";

/**
 * What the app is holding that the server hasn't got.
 *
 * The counterpart to the stale-data banner beside it, and the same principle
 * running the other way. That one exists because what's on screen may be
 * older than it looks; this one because part of it may be newer than anyone
 * else can see. A task added in a dead zone is real on this device and
 * invisible to the user's others, and the only dishonest version of this
 * screen is the one that doesn't say which is which.
 *
 * It is also the only place a queued task can be inspected as a queued task —
 * its list shows it where it belongs, which is right for planning the day but
 * not for answering "did that actually save?".
 */

/** A one-line description of what a queued entry is. */
function describe(entry: OutboxEntry): { label: string; when: string } {
  const resource = OUTBOX_RESOURCES[entry.resource];
  const title = entry.body.title;
  return {
    label: typeof title === "string" && title ? title : resource.label,
    when: formatRelativeTime(new Date(entry.queuedAt).toISOString()),
  };
}

function EntryRow({
  entry,
  onDiscard,
  onRetry,
}: {
  entry: OutboxEntry;
  onDiscard: () => void;
  onRetry?: () => void;
}) {
  const { label, when } = describe(entry);
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 1, py: 0.25 }}>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography sx={{ fontSize: 12.5, fontWeight: 600, lineHeight: 1.3 }} noWrap>
          {label} · {when}
        </Typography>
        {entry.failure && (
          <Typography sx={{ fontSize: 11, opacity: 0.85, lineHeight: 1.3 }}>
            {entry.failure}
          </Typography>
        )}
      </Box>
      {onRetry && (
        <Tooltip title="Try sending this again">
          <IconButton size="small" onClick={onRetry} aria-label={`Retry ${label}`}>
            <RefreshIcon sx={{ fontSize: 16 }} />
          </IconButton>
        </Tooltip>
      )}
      <Tooltip title="Discard this task">
        <IconButton size="small" onClick={onDiscard} aria-label={`Discard ${label}`}>
          <DeleteOutlineIcon sx={{ fontSize: 16 }} />
        </IconButton>
      </Tooltip>
    </Box>
  );
}

export default function PendingSyncBanner() {
  const entries = useOutbox();
  const { notify } = useNotification();
  const [expanded, setExpanded] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const waiting = entries.filter((entry) => !entry.failure);
  const failed = entries.filter((entry) => entry.failure);

  if (entries.length === 0) return null;

  const handleSyncNow = async () => {
    setSyncing(true);
    try {
      const summary = await flushOutbox();
      if (summary.synced > 0) {
        notify(
          `Synced ${summary.synced} ${summary.synced === 1 ? "task" : "tasks"}.`,
          "success",
        );
      } else if (summary.stoppedBecause === "offline") {
        notify("Still can't reach the server — they'll go out automatically.", "warning");
      } else if (summary.rejected > 0) {
        notify("The server wouldn't accept some tasks — see below.", "error");
      }
    } finally {
      setSyncing(false);
    }
  };

  return (
    <>
      {waiting.length > 0 && (
        <Alert
          severity="info"
          variant="outlined"
          icon={<CloudOffIcon fontSize="inherit" />}
          sx={{ mb: 2, alignItems: "center" }}
          action={
            <Stack direction="row" spacing={0.5}>
              <Button color="inherit" size="small" onClick={() => setExpanded((v) => !v)}>
                {expanded ? "Hide" : "Show"}
              </Button>
              <Button color="inherit" size="small" onClick={handleSyncNow} disabled={syncing}>
                {syncing ? "Syncing…" : "Sync now"}
              </Button>
            </Stack>
          }
        >
          {waiting.length} {waiting.length === 1 ? "task is" : "tasks are"} saved on this
          device and haven't reached the server yet — nobody else can see{" "}
          {waiting.length === 1 ? "it" : "them"}. Retrying automatically.
          <Collapse in={expanded}>
            <Box sx={{ mt: 1 }}>
              {waiting.map((entry) => (
                <EntryRow
                  key={entry.localId}
                  entry={entry}
                  onDiscard={() => discardEntry(entry.localId)}
                />
              ))}
            </Box>
          </Collapse>
        </Alert>
      )}

      {failed.length > 0 && (
        <Alert severity="error" variant="outlined" sx={{ mb: 2 }}>
          {/* Kept rather than dropped, and shown rather than retried: the
              server has rejected these in a way another attempt won't fix, so
              the only honest options are the user's — send it again once
              whatever it complained about is sorted, or throw it away
              deliberately. */}
          <AlertTitle sx={{ fontSize: 13.5 }}>
            {failed.length} {failed.length === 1 ? "task" : "tasks"} couldn't be saved
          </AlertTitle>
          {failed.map((entry) => (
            <EntryRow
              key={entry.localId}
              entry={entry}
              onDiscard={() => discardEntry(entry.localId)}
              onRetry={() => retryEntry(entry.localId)}
            />
          ))}
        </Alert>
      )}
    </>
  );
}
