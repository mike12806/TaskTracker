import { useState } from "react";
import {
  Box,
  Button,
  Divider,
  MenuItem,
  Paper,
  Stack,
  Switch,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import { useAuth } from "../hooks/useAuth";
import { useSettings } from "../hooks/useSettings";
import { useThemeMode } from "../hooks/useTheme";
import { usePushNotifications } from "../hooks/usePushNotifications";
import { useNotification } from "../hooks/useNotification";
import { useDataRefresh } from "../hooks/useDataRefresh";
import { refreshBriefing } from "../api/tasks";
import AreasSettings from "../components/AreasSettings";

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 2, py: 1.5 }}>
      <Box sx={{ minWidth: 0 }}>
        <Typography sx={{ fontWeight: 600, fontSize: 14.5 }}>{label}</Typography>
        {hint && (
          <Typography variant="body2" color="text.secondary" sx={{ fontSize: 13 }}>
            {hint}
          </Typography>
        )}
      </Box>
      <Box sx={{ flexShrink: 0 }}>{children}</Box>
    </Box>
  );
}

const hourLabel = (h: number) => new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: "numeric" });

export default function SettingsPage() {
  const { user } = useAuth();
  const { settings, update } = useSettings();
  const { preference, setPreference } = useThemeMode();
  const push = usePushNotifications();
  const { notify } = useNotification();
  const { refreshData } = useDataRefresh();
  const [briefingBusy, setBriefingBusy] = useState(false);

  const save = (changes: Parameters<typeof update>[0]) =>
    update(changes).catch((err: unknown) => notify(err instanceof Error ? err.message : "Couldn't save settings.", "error"));

  const regenerate = async () => {
    setBriefingBusy(true);
    try {
      const res = await refreshBriefing();
      notify(
        res.source === "ai" ? "Briefing rewritten." : `Wrote the template briefing — ${res.reason ?? "the model declined"}.`,
        res.source === "ai" ? "success" : "warning",
      );
      refreshData();
    } catch (err) {
      notify(err instanceof Error ? err.message : "Couldn't write the briefing.", "error");
    } finally {
      setBriefingBusy(false);
    }
  };

  return (
    <Box sx={{ maxWidth: 640, mx: "auto" }}>
      <Typography variant="h5" sx={{ fontWeight: 700, letterSpacing: "-0.02em", mb: 2 }}>
        Settings
      </Typography>

      <Paper variant="outlined" sx={{ px: 2, mb: 2 }}>
        <Row label="Theme">
          <ToggleButtonGroup exclusive size="small" value={preference} onChange={(_, v) => v && setPreference(v)}>
            <ToggleButton value="system">Auto</ToggleButton>
            <ToggleButton value="light">Light</ToggleButton>
            <ToggleButton value="dark">Dark</ToggleButton>
          </ToggleButtonGroup>
        </Row>
      </Paper>

      <AreasSettings />

      <Paper variant="outlined" sx={{ px: 2, mb: 2 }}>
        <Row
          label="Push reminders"
          hint={
            push.supported
              ? push.permission === "denied"
                ? "Blocked in this browser's settings."
                : "Notify this device when a task's reminder is due."
              : "Not available here — on iPhone, add the app to your Home Screen first."
          }
        >
          <Switch
            checked={push.subscribed}
            disabled={!push.supported || push.working || push.permission === "denied"}
            onChange={(_, on) => void (on ? push.subscribe() : push.unsubscribe()).catch(() => {})}
            slotProps={{ input: { "aria-label": "Push reminders" } }}
          />
        </Row>
        <Divider />
        <Row label="Default reminder time" hint="Used for “At due time” on tasks with no time set.">
          <TextField
            type="time"
            size="small"
            value={settings?.default_reminder_time ?? "09:00"}
            onChange={(e) => e.target.value && void save({ default_reminder_time: e.target.value })}
            disabled={!settings}
          />
        </Row>
      </Paper>

      <Paper variant="outlined" sx={{ px: 2, mb: 2 }}>
        <Row label="Morning briefing" hint="Written at this hour each day, on the Today page.">
          <TextField
            select
            size="small"
            value={settings?.digest_hour ?? 7}
            onChange={(e) => void save({ digest_hour: Number(e.target.value) })}
            disabled={!settings}
            sx={{ minWidth: 110 }}
          >
            {Array.from({ length: 24 }, (_, h) => (
              <MenuItem key={h} value={h}>
                {hourLabel(h)}
              </MenuItem>
            ))}
          </TextField>
        </Row>
        <Divider />
        <Row label="Email digest" hint={`Send the day's tasks to ${user?.email ?? "your address"} at the same hour.`}>
          <Switch
            checked={Boolean(settings?.email_digest)}
            disabled={!settings}
            onChange={(_, on) => void save({ email_digest: on ? 1 : 0 })}
            slotProps={{ input: { "aria-label": "Email digest" } }}
          />
        </Row>
        <Divider />
        <Row label="Rewrite today's briefing" hint="Runs the model now instead of waiting for the morning.">
          <Button size="small" onClick={() => void regenerate()} disabled={briefingBusy}>
            {briefingBusy ? "Writing…" : "Rewrite"}
          </Button>
        </Row>
      </Paper>

      <Stack spacing={0.5} sx={{ px: 1 }}>
        <Typography variant="caption" color="text.secondary">
          Signed in as {user?.email} · Timezone {settings?.timezone ?? "—"} (follows this device)
        </Typography>
        {/* An installed app can lag a deploy by design — the reload waits
            until it can't cost a half-typed task — so this is how to tell
            whether a device has picked one up. */}
        <Typography variant="caption" color="text.secondary">
          Build {__BUILD_ID__} · {new Date(__BUILD_TIME__).toLocaleString()}
        </Typography>
      </Stack>
    </Box>
  );
}
