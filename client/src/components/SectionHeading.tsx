import type { ReactNode } from "react";
import { Typography } from "@mui/material";

/**
 * The small caps label above an inset-grouped card — a task group ("Overdue ·
 * 2") or a section of Settings. One component so the two can't drift apart.
 */
export default function SectionHeading({ children, tone }: { children: ReactNode; tone?: "error" }) {
  return (
    <Typography
      variant="overline"
      component="h2"
      sx={{
        display: "block",
        fontSize: 12.5,
        fontWeight: 700,
        letterSpacing: "0.04em",
        lineHeight: 2,
        px: 1,
        color: tone === "error" ? "error.main" : "text.secondary",
        mb: 0.25,
      }}
    >
      {children}
    </Typography>
  );
}
