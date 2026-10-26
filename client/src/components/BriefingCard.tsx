import { useEffect, useState } from "react";
import { Box, Paper, Tooltip, Typography } from "@mui/material";
import { AutoAwesomeRoundedIcon } from "../icons";
import { fetchBriefing } from "../api/tasks";
import { useDataRefresh } from "../hooks/useDataRefresh";
import type { Briefing } from "../types/models";

/**
 * Today's briefing, at the top of the Today page.
 *
 * Fetched with `getOptional`, so a failure costs the card and nothing else —
 * no stale banner, no retry loop. Renders nothing before the digest hour has
 * written one. The sparkle marks an AI-written briefing; the template gets
 * none, since it isn't.
 */
export default function BriefingCard() {
  const { refreshKey } = useDataRefresh();
  const [briefing, setBriefing] = useState<Briefing | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchBriefing()
      .then((b) => {
        if (!cancelled) setBriefing(b);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  if (!briefing) return null;

  return (
    <Paper variant="outlined" sx={{ p: 2, mb: 2, display: "flex", gap: 1.5, alignItems: "flex-start" }}>
      <Typography sx={{ fontSize: 14.5, lineHeight: 1.5, flex: 1 }}>{briefing.body}</Typography>
      {briefing.source === "ai" && (
        <Tooltip title="Written by AI from your task counts">
          <Box component="span" sx={{ color: "text.secondary", display: "inline-flex" }}>
            <AutoAwesomeRoundedIcon sx={{ fontSize: 16 }} aria-label="AI-written" />
          </Box>
        </Tooltip>
      )}
    </Paper>
  );
}
