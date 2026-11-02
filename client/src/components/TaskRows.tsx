import type { ReactNode } from "react";
import { Paper } from "@mui/material";

/**
 * The inset-grouped card a run of `TaskItem`s sits in.
 *
 * The separators are drawn here, not by the row: they start at the title the
 * way iOS draws them, and the last row has none. A row can't tell it is last
 * when a page wraps each one in a box of its own (Completed does, to pin the
 * completion time over it) — `:last-of-type` on the row matched every row
 * there and drew no separators at all. From the card, "every child but the
 * last" holds whatever the child is.
 */
export default function TaskRows({ children }: { children: ReactNode }) {
  return (
    <Paper
      variant="outlined"
      sx={{
        overflow: "hidden",
        "& > :not(:last-child) .task-text": { borderBottom: 1, borderColor: "divider" },
      }}
    >
      {children}
    </Paper>
  );
}
