import type { ReactNode } from "react";
import { Typography, type SxProps, type Theme } from "@mui/material";

/**
 * An iOS large title, shared by every page so they all read as one app.
 *
 * On a short screen — the open iPhone Duo is 626 points tall, a slab phone
 * held sideways less — it would push the first task below the fold, so it
 * drops to a compact size there.
 *
 * `h1` by default; the second view beside the page on an open foldable passes
 * `h2`, so a screen reader still finds one page heading.
 */
export default function PageTitle({
  children,
  component = "h1",
  sx,
}: {
  children: ReactNode;
  component?: "h1" | "h2";
  sx?: SxProps<Theme>;
}) {
  return (
    <Typography
      component={component}
      sx={[
        {
          fontSize: 30,
          lineHeight: 1.15,
          fontWeight: 800,
          letterSpacing: "-0.025em",
          "@media (max-height: 640px)": { fontSize: 24 },
        },
        ...(Array.isArray(sx) ? sx : [sx]),
      ]}
    >
      {children}
    </Typography>
  );
}
