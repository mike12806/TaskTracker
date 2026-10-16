import { Box, Tooltip } from "@mui/material";
import CloudOffIcon from "@mui/icons-material/CloudOff";

/**
 * The mark on a task that exists only on this device.
 *
 * Every list in the app mixes saved tasks with queued ones, because leaving a
 * task added ten minutes ago off the list until the wifi comes back would make
 * the day look emptier than it is. What that costs is the guarantee that
 * everything on screen is also on the user's other devices — so it is paid
 * back here, per row, rather than assumed from the banner at the top of the
 * page that may have been scrolled past.
 *
 * Deliberately small and quiet. It is a caveat on a real task, not a warning:
 * the data is fine, it is only somewhere else that it hasn't arrived.
 */
export default function PendingChip({ compact = false }: { compact?: boolean }) {
  return (
    <Tooltip title="Saved on this device — not sent to the server yet">
      <Box
        component="span"
        aria-label="Not synced"
        sx={{
          display: "inline-flex",
          alignItems: "center",
          gap: 0.375,
          flexShrink: 0,
          verticalAlign: "middle",
          px: compact ? 0.5 : 0.625,
          py: 0.125,
          ml: 0.5,
          borderRadius: 1,
          border: 1,
          borderColor: "divider",
          color: "text.secondary",
          fontSize: 9.5,
          fontWeight: 700,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          lineHeight: 1.6,
        }}
      >
        <CloudOffIcon sx={{ fontSize: 11 }} />
        {!compact && "Not synced"}
      </Box>
    </Tooltip>
  );
}
