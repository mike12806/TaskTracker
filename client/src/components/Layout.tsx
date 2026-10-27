import { lazy, Suspense, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import {
  Alert,
  AppBar,
  Badge,
  Box,
  Button,
  Divider,
  Drawer,
  IconButton,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  ListSubheader,
  Menu,
  MenuItem,
  SwipeableDrawer,
  Toolbar,
  Typography,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import {
  AddRoundedIcon,
  ArrowDropDownRoundedIcon,
  ChecklistRoundedIcon,
  CheckRoundedIcon,
  CircleIcon,
  EventRoundedIcon,
  InboxRoundedIcon,
  MenuIcon,
  MoreHorizRoundedIcon,
  SearchRoundedIcon,
  SettingsRoundedIcon,
  TaskAltRoundedIcon,
  TodayRoundedIcon,
} from "../icons";
import ErrorBoundary from "./ErrorBoundary";
import PendingSyncBanner from "./PendingSyncBanner";
import PushNotificationsNudge from "./PushNotificationsNudge";
import AlertsBell from "./AlertsBell";
import TaskDialog, { type TaskDefaults } from "./TaskDialog";
import ListDialog from "./ListDialog";
import { CompanionViewContext } from "./TaskListView";
import TodayPage from "../pages/TodayPage";
import { useAuth } from "../hooks/useAuth";
import { useDataFreshness } from "../hooks/useDataFreshness";
import { useDataRefresh } from "../hooks/useDataRefresh";
import { useLists } from "../hooks/useLists";
import { useAreas } from "../hooks/useAreas";
import { useTasks } from "../hooks/useTasks";
import { useFold } from "../hooks/useFold";
import { formatRelativeTime } from "../utils/dateTime";
import { addDaysStr, todayStr } from "../utils/taskDates";

const DRAWER_WIDTH = 260;
const BOTTOM_NAV_HEIGHT = 68;
const APPBAR_HEIGHT_MOBILE = 48;
const APPBAR_HEIGHT_DESKTOP = 56;

// Already its own chunk (App.tsx loads it the same way); this only shares it.
const UpcomingPage = lazy(() => import("../pages/UpcomingPage"));

/**
 * The pane right of the fold on an open foldable (see `utils/fold.ts`). It
 * stays in view while the page beside it scrolls, and scrolls on its own.
 */
const END_PANE_SX = {
  gridColumn: 3,
  minWidth: 0,
  position: "sticky",
  top: `calc(${APPBAR_HEIGHT_MOBILE}px + env(safe-area-inset-top))`,
  height: `calc(100dvh - ${APPBAR_HEIGHT_MOBILE}px - env(safe-area-inset-top))`,
  overflowY: "auto",
  overscrollBehavior: "contain",
  px: 1.5,
  pt: 1.5,
  pb: "calc(env(safe-area-inset-bottom) + 16px)",
  borderLeft: 1,
  borderColor: "divider",
} as const;

/** What the add button pre-fills, from the page it was tapped on and the area on screen. */
function defaultsForPath(pathname: string, areaId: number | undefined): TaskDefaults {
  const list = pathname.match(/^\/lists\/(\d+)/);
  if (list) return { list_id: Number(list[1]) };
  const area = areaId === undefined ? {} : { area_id: areaId };
  if (pathname === "/") return { ...area, due_date: todayStr() };
  if (pathname === "/upcoming") return { ...area, due_date: addDaysStr(todayStr(), 1) };
  return area;
}

export default function Layout() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newList, setNewList] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();
  const { lists, inboxCount, inboxCounts } = useLists();
  const { areas, selected, select, areaById, inSelection, defaultAreaId } = useAreas();
  const [areaMenu, setAreaMenu] = useState<HTMLElement | null>(null);
  const currentArea = selected === "all" ? undefined : areaById(selected);
  const { tasks: allTasks } = useTasks();
  // Every count in the chrome follows the area switcher, like the views do.
  const tasks = allTasks.filter((t) => inSelection(t.area_id));
  const areaInboxCount = selected === "all" ? inboxCount : (inboxCounts[String(selected)] ?? 0);
  const { staleSince } = useDataFreshness();
  const { refreshData } = useDataRefresh();
  const muiTheme = useTheme();
  const isMobile = useMediaQuery(muiTheme.breakpoints.down("md"));
  const isDark = muiTheme.palette.mode === "dark";

  // Open like a book, the page takes the left pane and a second view the
  // right: Upcoming beside Today, Today beside everything else. Every view
  // filters the one task list `TasksProvider` already holds, so the second
  // costs no request. Tapping a task there opens its editor in that same
  // pane, since the theme puts dialogs on the right.
  const fold = useFold();
  const columns = fold.kind === "columns" ? fold : null;

  const today = todayStr();
  const todayCount = tasks.filter((t) => t.due_date !== null && t.due_date <= today).length;
  const upcomingCount = tasks.filter((t) => t.due_date !== null && t.due_date > today).length;

  const go = (path: string) => {
    navigate(path);
    if (isMobile) setDrawerOpen(false);
  };

  const navItems = [
    { label: "Today", icon: <TodayRoundedIcon />, path: "/", count: todayCount },
    { label: "Upcoming", icon: <EventRoundedIcon />, path: "/upcoming", count: upcomingCount },
    { label: "Inbox", icon: <InboxRoundedIcon />, path: "/inbox", count: areaInboxCount },
    { label: "All tasks", icon: <ChecklistRoundedIcon />, path: "/all", count: tasks.length },
    { label: "Completed", icon: <TaskAltRoundedIcon />, path: "/completed" },
    { label: "Search", icon: <SearchRoundedIcon />, path: "/search" },
  ];

  const navLabel = (label: string, selected: boolean) => (
    <ListItemText
      primary={label}
      slotProps={{ primary: { sx: { fontSize: 14.5, fontWeight: selected ? 600 : 500, letterSpacing: "-0.005em" }, noWrap: true } }}
    />
  );

  const count = (n?: number) =>
    n ? (
      <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600 }}>
        {n}
      </Typography>
    ) : null;

  const drawer = (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100%", bgcolor: "background.paper" }}>
      <Box sx={{ minHeight: { xs: `calc(${APPBAR_HEIGHT_MOBILE}px + env(safe-area-inset-top))`, md: `${APPBAR_HEIGHT_DESKTOP}px` } }} />
      <List sx={{ py: 1 }}>
        {navItems.map((item) => {
          const selected = location.pathname === item.path;
          return (
            <ListItemButton key={item.path} selected={selected} onClick={() => go(item.path)} sx={{ py: 0.9 }}>
              <ListItemIcon>{item.icon}</ListItemIcon>
              {navLabel(item.label, selected)}
              {count(item.count)}
            </ListItemButton>
          );
        })}
      </List>
      <Divider />
      <List
        sx={{ flex: 1, overflowY: "auto", py: 0.5 }}
        subheader={
          <ListSubheader sx={{ bgcolor: "background.paper", lineHeight: "36px", fontWeight: 700, letterSpacing: "0.04em" }}>
            LISTS
          </ListSubheader>
        }
      >
        {/* Lists of the area on screen; with all areas showing, grouped by area. */}
        {(selected === "all" ? areas : currentArea ? [currentArea] : []).map((area) => (
          <Box key={area.id}>
            {selected === "all" && (
              <Typography
                variant="caption"
                sx={{ display: "block", px: 2, pt: 1, pb: 0.25, fontWeight: 700, color: area.color }}
              >
                {area.name}
              </Typography>
            )}
            {lists
              .filter((l) => l.area_id === area.id)
              .map((list) => {
                const path = `/lists/${list.id}`;
                const active = location.pathname === path;
                return (
                  <ListItemButton key={list.id} selected={active} onClick={() => go(path)} sx={{ py: 0.8 }}>
                    <ListItemIcon>
                      <CircleIcon sx={{ fontSize: 12, color: list.color, ml: 0.5 }} />
                    </ListItemIcon>
                    {navLabel(list.name, active)}
                    {count(list.open_count)}
                  </ListItemButton>
                );
              })}
          </Box>
        ))}
        <ListItemButton onClick={() => setNewList(true)} sx={{ py: 0.8, color: "text.secondary" }}>
          <ListItemIcon>
            <AddRoundedIcon fontSize="small" />
          </ListItemIcon>
          {navLabel("New list", false)}
        </ListItemButton>
      </List>
      <Divider />
      <List sx={{ py: 0.5 }}>
        <ListItemButton selected={location.pathname === "/settings"} onClick={() => go("/settings")} sx={{ py: 0.9 }}>
          <ListItemIcon>
            <SettingsRoundedIcon />
          </ListItemIcon>
          {navLabel("Settings", location.pathname === "/settings")}
        </ListItemButton>
      </List>
    </Box>
  );

  const bottomTabs = [
    { id: "today", label: "Today", icon: <TodayRoundedIcon />, path: "/" },
    { id: "upcoming", label: "Upcoming", icon: <EventRoundedIcon />, path: "/upcoming" },
    { id: "add", label: "Add", icon: <AddRoundedIcon sx={{ fontSize: 28 }} />, path: null },
    { id: "inbox", label: "Inbox", icon: <InboxRoundedIcon />, path: "/inbox" },
    { id: "more", label: "More", icon: <MoreHorizRoundedIcon />, path: null },
  ];

  return (
    <Box sx={{ display: "flex" }}>
      <AppBar position="fixed" sx={{ zIndex: (theme) => theme.zIndex.drawer + 1, paddingTop: "env(safe-area-inset-top)" }}>
        <Toolbar variant="dense" sx={{ minHeight: { xs: APPBAR_HEIGHT_MOBILE, md: APPBAR_HEIGHT_DESKTOP }, px: { xs: 1, sm: 1.5 } }}>
          <IconButton
            color="inherit"
            edge="start"
            size="small"
            onClick={() => setDrawerOpen(!drawerOpen)}
            sx={{ mr: 1, display: { md: "none" }, minWidth: 36, minHeight: 36 }}
            aria-label="open navigation drawer"
          >
            <MenuIcon sx={{ fontSize: 22 }} />
          </IconButton>
          {/* The area switcher. A view filter for this device only — see
              hooks/useAreas.tsx — so it lives in the chrome, not in Settings. */}
          <Box sx={{ flexGrow: 1, minWidth: 0 }}>
            <Button
              color="inherit"
              onClick={(e) => setAreaMenu(e.currentTarget)}
              endIcon={<ArrowDropDownRoundedIcon />}
              aria-label="Switch area"
              sx={{ fontSize: 15, fontWeight: 600, letterSpacing: "-0.01em", textTransform: "none", px: 1, minWidth: 0 }}
            >
              {currentArea && (
                <Box component="span" sx={{ width: 9, height: 9, borderRadius: "50%", bgcolor: currentArea.color, mr: 1 }} />
              )}
              {currentArea ? currentArea.name : "All areas"}
            </Button>
            <Menu anchorEl={areaMenu} open={Boolean(areaMenu)} onClose={() => setAreaMenu(null)}>
              {[{ id: "all" as const, name: "All areas", color: "transparent" }, ...areas].map((a) => (
                <MenuItem
                  key={a.id}
                  selected={selected === a.id}
                  onClick={() => {
                    select(a.id);
                    setAreaMenu(null);
                  }}
                >
                  <ListItemIcon>
                    {selected === a.id ? (
                      <CheckRoundedIcon fontSize="small" />
                    ) : (
                      <CircleIcon sx={{ fontSize: 10, color: a.color, ml: 0.5 }} />
                    )}
                  </ListItemIcon>
                  {a.name}
                </MenuItem>
              ))}
              <Divider />
              <MenuItem
                onClick={() => {
                  setAreaMenu(null);
                  navigate("/settings");
                }}
              >
                <ListItemIcon>
                  <SettingsRoundedIcon fontSize="small" />
                </ListItemIcon>
                Manage areas
              </MenuItem>
            </Menu>
          </Box>
          <IconButton
            color="inherit"
            size="small"
            onClick={() => navigate("/search")}
            aria-label="Search"
            sx={{ minWidth: 36, minHeight: 36, display: { xs: "none", md: "inline-flex" } }}
          >
            <SearchRoundedIcon />
          </IconButton>
          {/* Reminders as a list: a push that was swiped away, or never
              delivered to this device, is still readable here. */}
          <AlertsBell />
          <Button
            color="inherit"
            size="small"
            startIcon={<AddRoundedIcon />}
            onClick={() => setAdding(true)}
            sx={{ display: { xs: "none", md: "inline-flex" }, ml: 1 }}
          >
            New task
          </Button>
        </Toolbar>
      </AppBar>

      <SwipeableDrawer
        variant="temporary"
        open={drawerOpen}
        onOpen={() => setDrawerOpen(true)}
        onClose={() => setDrawerOpen(false)}
        sx={{ display: { xs: "block", md: "none" }, "& .MuiDrawer-paper": { width: DRAWER_WIDTH, boxSizing: "border-box" } }}
      >
        {drawer}
      </SwipeableDrawer>
      <Drawer
        variant="permanent"
        open
        sx={{ display: { xs: "none", md: "block" }, "& .MuiDrawer-paper": { width: DRAWER_WIDTH, boxSizing: "border-box" } }}
      >
        {drawer}
      </Drawer>

      <Box
        component="main"
        sx={{
          flexGrow: 1,
          pt: { xs: 1.5, sm: 3 },
          // Open, the panes pad themselves, so each is inset from the crease.
          px: columns ? 0 : { xs: 1.5, sm: 3 },
          ...(columns && {
            display: "grid",
            gridTemplateColumns: `${columns.start}px ${columns.hinge}px ${columns.end}px`,
            alignItems: "start",
          }),
          ml: { md: `${DRAWER_WIDTH}px` },
          mt: { xs: `calc(${APPBAR_HEIGHT_MOBILE}px + env(safe-area-inset-top))`, md: `${APPBAR_HEIGHT_DESKTOP}px` },
          pb: { xs: `calc(${BOTTOM_NAV_HEIGHT}px + env(safe-area-inset-bottom) + 16px)`, md: 3 },
          minHeight: { xs: `calc(100vh - ${APPBAR_HEIGHT_MOBILE}px)`, md: `calc(100vh - ${APPBAR_HEIGHT_DESKTOP}px)` },
          maxWidth: "100%",
          // `clip` rather than `hidden` when open: a hidden overflow is a
          // scroll container, and the right-hand pane could not stick in it.
          overflow: columns ? "clip" : "hidden",
        }}
      >
        <Box sx={columns ? { gridColumn: 1, minWidth: 0, px: 1.5 } : undefined}>
          {/* Nothing caches API data, so what's on screen is whatever the last
              successful refresh brought back. The moment a refresh fails, its
              age is said out loud rather than left to look live. */}
          {staleSince !== null && (
            <Alert
              severity="warning"
              variant="outlined"
              sx={{ mb: 2, alignItems: "center" }}
              action={
                <Button color="inherit" size="small" onClick={refreshData}>
                  Retry
                </Button>
              }
            >
              Can't reach the server — showing tasks from {formatRelativeTime(new Date(staleSince).toISOString())}. Changes
              made on other devices aren't here yet; retrying automatically.
            </Alert>
          )}
          {/* The same honesty the other way: what this device has that the
              server hasn't. */}
          <PendingSyncBanner />
          {/* Keyed on the route so navigating away clears a crashed page. */}
          <ErrorBoundary key={location.pathname} scope="This page failed to load">
            <Outlet />
          </ErrorBoundary>
        </Box>
        {/* After the page, never around it: opening the phone adds this pane
            without moving the page in the tree, so nothing on it remounts. */}
        {columns && (
          <Box component="aside" aria-label="Second view" sx={END_PANE_SX}>
            <CompanionViewContext.Provider value={true}>
              <ErrorBoundary key={location.pathname} scope="This view failed to load">
                <Suspense fallback={null}>{location.pathname === "/" ? <UpcomingPage /> : <TodayPage />}</Suspense>
              </ErrorBoundary>
            </CompanionViewContext.Provider>
          </Box>
        )}
      </Box>

      {/* Mobile bottom navigation, with the add button in the middle. Open, it
          spans the left pane only: across the whole width the add button
          would sit on the crease. */}
      <Box
        sx={{
          display: { xs: "block", md: "none" },
          position: "fixed",
          bottom: 0,
          left: 0,
          right: columns ? "auto" : 0,
          width: columns?.start,
          zIndex: (theme) => theme.zIndex.appBar,
          paddingBottom: "env(safe-area-inset-bottom)",
          borderTop: 1,
          borderColor: "divider",
          bgcolor: isDark ? "rgba(12, 16, 24, 0.86)" : "rgba(255, 255, 255, 0.92)",
          backdropFilter: "blur(16px) saturate(180%)",
          WebkitBackdropFilter: "blur(16px) saturate(180%)",
        }}
      >
        <Box sx={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", height: BOTTOM_NAV_HEIGHT, alignItems: "center" }}>
          {bottomTabs.map((tab) => {
            if (tab.id === "add") {
              return (
                <Box key={tab.id} sx={{ display: "flex", justifyContent: "center", alignItems: "flex-start" }}>
                  <Box
                    role="button"
                    aria-label="New task"
                    onClick={() => setAdding(true)}
                    sx={{
                      width: 52,
                      height: 52,
                      borderRadius: "18px",
                      mt: "-22px",
                      bgcolor: "primary.main",
                      color: isDark ? "#0c1018" : "#ffffff",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      boxShadow: isDark ? "0 8px 22px rgba(165, 180, 252, 0.45)" : "0 8px 22px rgba(91, 93, 255, 0.35)",
                      border: 4,
                      borderColor: isDark ? "#0c1018" : "#ffffff",
                      cursor: "pointer",
                      "&:active": { transform: "scale(0.92)" },
                    }}
                  >
                    {tab.icon}
                  </Box>
                </Box>
              );
            }
            const active = tab.path ? location.pathname === tab.path : false;
            const badge = tab.id === "today" ? todayCount : 0;
            return (
              <Box
                key={tab.id}
                role="button"
                aria-label={tab.label}
                onClick={() => (tab.path ? navigate(tab.path) : setDrawerOpen(true))}
                sx={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: "3px",
                  py: 0.5,
                  color: active ? "text.primary" : "text.secondary",
                  cursor: "pointer",
                  "&:active": { opacity: 0.7 },
                }}
              >
                <Badge badgeContent={badge} color="primary" max={99}>
                  {tab.icon}
                </Badge>
                <Typography sx={{ fontSize: 10.5, fontWeight: active ? 700 : 500, letterSpacing: "-0.005em" }}>{tab.label}</Typography>
              </Box>
            );
          })}
        </Box>
      </Box>

      <TaskDialog open={adding} task={null} defaults={defaultsForPath(location.pathname, defaultAreaId)} onClose={() => setAdding(false)} />
      <ListDialog open={newList} list={null} onClose={() => setNewList(false)} />
      {user && <PushNotificationsNudge />}
    </Box>
  );
}
