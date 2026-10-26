import { useState } from "react";
import { Box, Button, IconButton, Menu, MenuItem, Paper, TextField, Tooltip, Typography } from "@mui/material";
import { AddRoundedIcon, DeleteOutlineRoundedIcon } from "../icons";
import { createArea, deleteArea, updateArea } from "../api/tasks";
import { useAreas } from "../hooks/useAreas";
import { useDataRefresh } from "../hooks/useDataRefresh";
import { useNotification } from "../hooks/useNotification";
import { useSaveGuard } from "../hooks/useSaveGuard";
import { LIST_COLORS } from "./ListDialog";
import type { Area } from "../types/models";

/**
 * Managing areas: rename on blur, recolour from the list palette, add, and
 * delete. Deleting moves the area's lists and tasks to another area (the
 * server does it in one batch) — nothing is ever deleted with an area — and
 * the last area can't be deleted at all.
 */
export default function AreasSettings() {
  const { areas } = useAreas();
  const { refreshData } = useDataRefresh();
  const { notify } = useNotification();
  const { saving, save } = useSaveGuard();
  const [newName, setNewName] = useState("");
  const [colorMenu, setColorMenu] = useState<{ el: HTMLElement; area: Area } | null>(null);
  const [confirming, setConfirming] = useState<number | null>(null);

  const fail = (err: unknown, what: string) => notify(err instanceof Error ? err.message : `Couldn't ${what}.`, "error");

  const rename = async (area: Area, name: string) => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === area.name) return;
    try {
      await updateArea(area.id, { name: trimmed });
      refreshData();
    } catch (err) {
      fail(err, "rename the area");
    }
  };

  const recolor = async (area: Area, color: string) => {
    setColorMenu(null);
    try {
      await updateArea(area.id, { color });
      refreshData();
    } catch (err) {
      fail(err, "change the colour");
    }
  };

  const remove = async (area: Area) => {
    const target = areas.find((a) => a.id !== area.id);
    if (!target) return;
    try {
      await deleteArea(area.id, target.id);
      setConfirming(null);
      refreshData();
      notify(`Deleted "${area.name}". Its lists and tasks moved to ${target.name}.`, "success");
    } catch (err) {
      fail(err, "delete the area");
    }
  };

  const add = () =>
    save({ newName }, async (key) => {
      const name = newName.trim();
      if (!name) return;
      try {
        await createArea(name, LIST_COLORS[(areas.length * 3) % LIST_COLORS.length], key);
        setNewName("");
        refreshData();
      } catch (err) {
        fail(err, "add the area");
      }
    });

  return (
    <Paper variant="outlined" sx={{ px: 2, py: 1.5, mb: 2 }}>
      <Typography sx={{ fontWeight: 600, fontSize: 14.5 }}>Areas</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ fontSize: 13, mb: 1.5 }}>
        The level above lists, for keeping work and personal apart. Each list belongs to one, and each has its own
        Inbox. Switch areas from the app bar.
      </Typography>

      {areas.map((area) => (
        <Box key={area.id} sx={{ display: "flex", alignItems: "center", gap: 1, mb: 1 }}>
          <Tooltip title="Colour">
            <IconButton size="small" onClick={(e) => setColorMenu({ el: e.currentTarget, area })} aria-label={`Colour of ${area.name}`}>
              <Box sx={{ width: 16, height: 16, borderRadius: "50%", bgcolor: area.color }} />
            </IconButton>
          </Tooltip>
          <TextField
            size="small"
            defaultValue={area.name}
            key={`${area.id}:${area.name}`}
            onBlur={(e) => void rename(area, e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            slotProps={{ htmlInput: { "aria-label": `Name of ${area.name}`, maxLength: 50 } }}
            sx={{ flex: 1 }}
          />
          {areas.length > 1 &&
            (confirming === area.id ? (
              <Button size="small" color="error" onClick={() => void remove(area)}>
                Move & delete
              </Button>
            ) : (
              <Tooltip title={`Delete — its lists and tasks move to ${areas.find((a) => a.id !== area.id)?.name}`}>
                <IconButton size="small" onClick={() => setConfirming(area.id)} aria-label={`Delete ${area.name}`}>
                  <DeleteOutlineRoundedIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            ))}
        </Box>
      ))}

      <Box sx={{ display: "flex", gap: 1, mt: 1.5 }}>
        <TextField
          size="small"
          placeholder="New area"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !saving && void add()}
          slotProps={{ htmlInput: { "aria-label": "New area name", maxLength: 50 } }}
          sx={{ flex: 1 }}
        />
        <Button startIcon={<AddRoundedIcon />} onClick={() => void add()} disabled={!newName.trim() || saving}>
          Add
        </Button>
      </Box>

      <Menu anchorEl={colorMenu?.el} open={Boolean(colorMenu)} onClose={() => setColorMenu(null)}>
        <Box sx={{ display: "grid", gridTemplateColumns: "repeat(5, 28px)", gap: 1, px: 1.5, py: 0.5 }}>
          {LIST_COLORS.map((c) => (
            <MenuItem
              key={c}
              onClick={() => colorMenu && void recolor(colorMenu.area, c)}
              aria-label={c}
              sx={{ p: 0, minHeight: 0, width: 28, height: 28, borderRadius: "50%", bgcolor: c, "&:hover": { bgcolor: c, opacity: 0.85 } }}
            />
          ))}
        </Box>
      </Menu>
    </Paper>
  );
}
