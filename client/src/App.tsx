import { lazy, Suspense } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Box, CircularProgress, CssBaseline } from "@mui/material";
import { AppThemeProvider } from "./hooks/useTheme";
import { FoldProvider } from "./hooks/useFold";
import { AuthProvider, useAuth } from "./hooks/useAuth";
import { DataRefreshProvider } from "./hooks/useDataRefresh";
import { NotificationProvider } from "./hooks/useNotification";
import { PushNotificationsProvider } from "./hooks/usePushNotifications";
import { SettingsProvider } from "./hooks/useSettings";
import { ListsProvider } from "./hooks/useLists";
import { AreasProvider } from "./hooks/useAreas";
import { TasksProvider } from "./hooks/useTasks";
import { LiveConnection } from "./components/LiveConnection";
import Layout from "./components/Layout";
import ErrorBoundary from "./components/ErrorBoundary";
import TodayPage from "./pages/TodayPage";

// Today is the landing page, so it ships in the main bundle; the rest load on
// first visit.
const UpcomingPage = lazy(() => import("./pages/UpcomingPage"));
const ListPage = lazy(() => import("./pages/ListPage"));
const CompletedPage = lazy(() => import("./pages/CompletedPage"));
const SearchPage = lazy(() => import("./pages/SearchPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));

const Spinner = ({ minHeight }: { minHeight: string }) => (
  <Box sx={{ display: "flex", justifyContent: "center", alignItems: "center", minHeight }}>
    <CircularProgress />
  </Box>
);

function AuthGate({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  // Not signed in means Cloudflare Access is about to redirect to its login.
  if (loading || !user) return <Spinner minHeight="100vh" />;
  return <>{children}</>;
}

export default function App() {
  return (
    // Outside the theme, which is rebuilt from it: on an open foldable every
    // breakpoint describes one pane — see utils/fold.ts.
    <FoldProvider>
      <AppThemeProvider>
        <CssBaseline />
        {/* Catch-all. The boundary inside Layout handles a page blowing up and
            keeps the nav; this one is for everything outside it. */}
        <ErrorBoundary>
          <BrowserRouter>
            <AuthProvider>
              <AuthGate>
                <DataRefreshProvider>
                  {/* Inside the auth gate so the handshake carries a live Access
                      session; outside the routes so changing page doesn't
                      rebuild the socket. */}
                  <LiveConnection />
                  <NotificationProvider>
                    <SettingsProvider>
                      <AreasProvider>
                        <ListsProvider>
                          <TasksProvider>
                            <PushNotificationsProvider>
                              <Suspense fallback={<Spinner minHeight="60vh" />}>
                                <Routes>
                                  <Route element={<Layout />}>
                                    <Route path="/" element={<TodayPage />} />
                                    <Route path="/upcoming" element={<UpcomingPage />} />
                                    <Route path="/inbox" element={<ListPage mode="inbox" />} />
                                    <Route path="/all" element={<ListPage mode="all" />} />
                                    <Route path="/lists/:id" element={<ListPage mode="list" />} />
                                    <Route path="/completed" element={<CompletedPage />} />
                                    <Route path="/search" element={<SearchPage />} />
                                    <Route path="/settings" element={<SettingsPage />} />
                                    <Route path="*" element={<TodayPage />} />
                                  </Route>
                                </Routes>
                              </Suspense>
                            </PushNotificationsProvider>
                          </TasksProvider>
                        </ListsProvider>
                      </AreasProvider>
                    </SettingsProvider>
                  </NotificationProvider>
                </DataRefreshProvider>
              </AuthGate>
            </AuthProvider>
          </BrowserRouter>
        </ErrorBoundary>
      </AppThemeProvider>
    </FoldProvider>
  );
}
