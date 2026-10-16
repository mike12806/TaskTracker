import { createTheme, type Shadows } from "@mui/material/styles";

type Mode = "light" | "dark";

const FONT_FAMILY =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

function buildShadows(mode: Mode): Shadows {
  const c = mode === "light" ? "15, 23, 42" : "0, 0, 0";
  const a = mode === "light" ? 1 : 1.8;
  const soft = (
    y1: number,
    b1: number,
    o1: number,
    y2: number,
    b2: number,
    o2: number,
  ) =>
    `0px ${y1}px ${b1}px rgba(${c}, ${o1 * a}), 0px ${y2}px ${b2}px rgba(${c}, ${o2 * a})`;

  const custom: string[] = [
    "none",
    soft(1, 2, 0.04, 1, 1, 0.03),
    soft(1, 3, 0.05, 2, 4, 0.04),
    soft(2, 6, 0.06, 3, 8, 0.04),
    soft(3, 8, 0.07, 4, 12, 0.05),
    soft(4, 12, 0.08, 6, 16, 0.05),
    soft(6, 16, 0.09, 8, 20, 0.06),
    soft(8, 20, 0.1, 12, 24, 0.06),
    soft(10, 24, 0.11, 16, 32, 0.07),
  ];
  while (custom.length < 25) {
    const i = custom.length;
    custom.push(
      `0px ${i}px ${i * 2}px rgba(${c}, ${0.12 * a}), 0px ${i * 2}px ${i * 4}px rgba(${c}, ${0.07 * a})`,
    );
  }
  return custom as unknown as Shadows;
}

export function buildTheme(mode: Mode) {
  const isLight = mode === "light";
  const borderColor = isLight
    ? "rgba(15, 23, 42, 0.08)"
    : "rgba(255, 255, 255, 0.07)";
  const surfacePaper = isLight ? "#ffffff" : "#161b27";
  // Dialogs sit one step above the page, so use a slightly lighter
  // navy in dark mode to read as "elevated" rather than blending into
  // the page cards.
  const dialogPaper = isLight ? "#ffffff" : "#1c2236";
  const dialogBorder = isLight
    ? "rgba(15, 23, 42, 0.10)"
    : "rgba(255, 255, 255, 0.10)";
  const inputBorder = isLight
    ? "rgba(15, 23, 42, 0.18)"
    : "rgba(255, 255, 255, 0.22)";
  const inputBorderHover = isLight
    ? "rgba(15, 23, 42, 0.32)"
    : "rgba(255, 255, 255, 0.38)";
  const inputBackground = isLight
    ? "rgba(15, 23, 42, 0.02)"
    : "rgba(255, 255, 255, 0.04)";
  const selectedBg = isLight
    ? "rgba(91, 93, 255, 0.10)"
    : "rgba(165, 180, 252, 0.14)";
  const selectedHoverBg = isLight
    ? "rgba(91, 93, 255, 0.16)"
    : "rgba(165, 180, 252, 0.22)";
  const hoverBg = isLight
    ? "rgba(15, 23, 42, 0.04)"
    : "rgba(255, 255, 255, 0.05)";
  const dialogShadow = isLight
    ? "0 24px 56px rgba(15, 23, 42, 0.18), 0 8px 16px rgba(15, 23, 42, 0.10)"
    : "0 32px 72px rgba(0, 0, 0, 0.65), 0 12px 24px rgba(0, 0, 0, 0.45)";
  const backdropColor = isLight
    ? "rgba(15, 23, 42, 0.45)"
    : "rgba(2, 4, 8, 0.65)";

  return createTheme({
    palette: {
      mode,
      primary: { main: isLight ? "#5b5dff" : "#a5b4fc" },
      secondary: { main: "#ec4899" },
      success: { main: "#16a34a" },
      warning: { main: "#d97706" },
      error: { main: "#ef4444" },
      info: { main: "#0284c7" },
      background: isLight
        ? { default: "#f4f3ef", paper: "#ffffff" }
        : { default: "#0c1018", paper: "#161b27" },
      text: isLight
        ? { primary: "#10131c", secondary: "#6a7080" }
        : { primary: "#f1f5f9", secondary: "#8a93a4" },
      divider: borderColor,
    },
    typography: {
      fontFamily: FONT_FAMILY,
      h1: { fontWeight: 700, letterSpacing: "-0.02em" },
      h2: { fontWeight: 700, letterSpacing: "-0.02em" },
      h3: { fontWeight: 700, letterSpacing: "-0.01em" },
      h4: { fontSize: "1.3rem", fontWeight: 700, letterSpacing: "-0.01em" },
      h5: { fontSize: "1.1rem", fontWeight: 600 },
      h6: { fontSize: "1rem", fontWeight: 600 },
      body1: { fontSize: "1rem", fontWeight: 400, lineHeight: 1.5 },
      body2: { fontSize: "0.875rem", fontWeight: 400, lineHeight: 1.5 },
      caption: { fontSize: "0.75rem" },
      button: { textTransform: "none", fontWeight: 600 },
    },
    shape: { borderRadius: 16 },
    shadows: buildShadows(mode),
    components: {
      MuiButton: {
        defaultProps: { disableElevation: true },
        styleOverrides: {
          root: { minHeight: 44, paddingInline: 16, fontWeight: 600 },
        },
      },
      MuiIconButton: {
        styleOverrides: {
          root: {
            minWidth: 44,
            minHeight: 44,
            "&.MuiIconButton-sizeSmall": { minWidth: 36, minHeight: 36 },
          },
        },
      },
      MuiCard: {
        defaultProps: { elevation: 0 },
        styleOverrides: {
          root: { border: "1px solid", borderColor },
        },
      },
      MuiPaper: {
        styleOverrides: {
          rounded: { borderRadius: 16 },
          root: {
            backgroundImage: "none",
          },
        },
      },
      MuiDrawer: {
        styleOverrides: {
          paper: {
            backgroundImage: "none",
            backgroundColor: surfacePaper,
            borderRight: isLight ? `1px solid ${borderColor}` : "none",
          },
        },
      },
      MuiAppBar: {
        defaultProps: { elevation: 0 },
        styleOverrides: {
          root: {
            borderBottom: "1px solid",
            borderColor,
            backgroundColor: isLight
              ? "rgba(244, 243, 239, 0.78)"
              : "rgba(12, 16, 24, 0.72)",
            backdropFilter: "blur(14px) saturate(180%)",
            WebkitBackdropFilter: "blur(14px) saturate(180%)",
            color: isLight ? "#10131c" : "#f1f5f9",
          },
        },
      },
      MuiTextField: {
        defaultProps: { variant: "outlined", size: "medium" },
      },
      MuiChip: {
        styleOverrides: { root: { fontWeight: 500 } },
      },
      MuiDialog: {
        styleOverrides: {
          paper: {
            borderRadius: 20,
            backgroundImage: "none",
            backgroundColor: dialogPaper,
            border: `1px solid ${dialogBorder}`,
            boxShadow: dialogShadow,
          },
          // Full-screen dialogs (used on mobile) fill the viewport, which
          // sits under the device status bar / notch and home indicator
          // because the app opts into `viewport-fit=cover`. Inset the paper
          // by the safe-area so the title no longer collides with the
          // status-bar clock and the actions clear the home indicator.
          paperFullScreen: {
            paddingTop: "env(safe-area-inset-top)",
            paddingBottom: "env(safe-area-inset-bottom)",
            paddingLeft: "env(safe-area-inset-left)",
            paddingRight: "env(safe-area-inset-right)",
          },
        },
      },
      MuiBackdrop: {
        styleOverrides: {
          root: {
            backgroundColor: backdropColor,
            backdropFilter: "blur(2px)",
            WebkitBackdropFilter: "blur(2px)",
            "&.MuiBackdrop-invisible": {
              backgroundColor: "transparent",
              backdropFilter: "none",
              WebkitBackdropFilter: "none",
            },
          },
        },
      },
      MuiOutlinedInput: {
        styleOverrides: {
          root: {
            backgroundColor: inputBackground,
            "& .MuiOutlinedInput-notchedOutline": {
              borderColor: inputBorder,
              transition: "border-color 120ms ease",
            },
            "&:hover:not(.Mui-disabled):not(.Mui-focused) .MuiOutlinedInput-notchedOutline": {
              borderColor: inputBorderHover,
            },
          },
        },
      },
      MuiInputLabel: {
        styleOverrides: {
          root: {
            color: isLight ? "#5b6271" : "#a3acba",
            "&.Mui-focused": {
              color: isLight ? "#5b5dff" : "#a5b4fc",
            },
          },
        },
      },
      MuiDialogTitle: {
        styleOverrides: {
          root: {
            fontWeight: 700,
            fontSize: "1.1rem",
            letterSpacing: "-0.01em",
            padding: "20px 24px 8px",
          },
        },
      },
      MuiDialogContent: {
        styleOverrides: {
          root: {
            padding: "8px 24px 16px",
            "&.MuiDialogContent-dividers": { padding: "16px 24px" },
          },
        },
      },
      MuiMenu: {
        styleOverrides: {
          paper: {
            backgroundImage: "none",
            backgroundColor: surfacePaper,
            border: `1px solid ${borderColor}`,
          },
        },
      },
      MuiPopover: {
        styleOverrides: {
          paper: {
            backgroundImage: "none",
            backgroundColor: surfacePaper,
          },
        },
      },
      MuiListItemButton: {
        styleOverrides: {
          root: {
            borderRadius: 10,
            marginInline: 8,
            paddingInline: 12,
            "&.Mui-selected": {
              backgroundColor: selectedBg,
              "&:hover": { backgroundColor: selectedHoverBg },
            },
            "&:hover": { backgroundColor: hoverBg },
          },
        },
      },
      MuiListItemIcon: {
        styleOverrides: {
          root: {
            minWidth: 36,
            color: isLight ? "#6a7080" : "#8a93a4",
            ".Mui-selected &": {
              color: isLight ? "#5b5dff" : "#a5b4fc",
            },
          },
        },
      },
      MuiDialogActions: {
        styleOverrides: {
          root: {
            padding: "12px 20px 16px",
            gap: 8,
            flexWrap: "wrap",
            "& > :not(style) ~ :not(style)": { marginLeft: 0 },
          },
        },
      },
      MuiTab: {
        styleOverrides: {
          root: { textTransform: "none", fontWeight: 600 },
        },
      },
    },
  });
}

const theme = buildTheme("light");
export default theme;
