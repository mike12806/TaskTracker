import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Stack, TextField } from "@mui/material";
import { createList, deleteList, updateList } from "../api/tasks";
import { useDataRefresh } from "../hooks/useDataRefresh";
import { useNotification } from "../hooks/useNotification";
import { useSaveGuard } from "../hooks/useSaveGuard";
import type { TaskList } from "../types/models";

export const LIST_COLORS = ["#5b5dff", "#e5484d", "#f76b15", "#ffc53d", "#30a46c", "#12a594", "#0090ff", "#8e4ec6", "#d6409f", "#868e96"];

/**
 * Create or edit a list. Lists are not queued offline — a list that doesn't
 * exist on the server yet can't be given tasks — so this simply fails while
 * the server is unreachable, and says so.
 */
export default function ListDialog({ open, list, onClose }: { open: boolean; list: TaskList | null; onClose: () => void }) {
  const navigate = useNavigate();
  const { refreshData } = useDataRefresh();
  const { notify } = useNotification();
  const { saving, save } = useSaveGuard();
  const [name, setName] = useState("");
  const [color, setColor] = useState(LIST_COLORS[0]);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(list?.name ?? "");
    setColor(list?.color ?? LIST_COLORS[0]);
    setConfirmDelete(false);
  }, [open, list]);

  const handleSave = () =>
    save({ name, color }, async (key) => {
      try {
        if (list) await updateList(list.id, { name: name.trim(), color });
        else {
          const created = await createList(name.trim(), color, key);
          navigate(`/lists/${created.id}`);
        }
        refreshData();
        onClose();
      } catch (err) {
        notify(err instanceof Error ? err.message : "Couldn't save the list.", "error");
      }
    });

  const handleDelete = async () => {
    if (!list) return;
    try {
      await deleteList(list.id);
      refreshData();
      onClose();
      navigate("/inbox");
      notify(`Deleted "${list.name}". Its tasks moved to the Inbox.`, "success");
    } catch (err) {
      notify(err instanceof Error ? err.message : "Couldn't delete the list.", "error");
    }
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>{list ? "Edit list" : "New list"}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <TextField
            label="Name"
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && name.trim() && !saving) void handleSave();
            }}
          />
          <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1 }} role="radiogroup" aria-label="Colour">
            {LIST_COLORS.map((c) => (
              <Box
                key={c}
                role="radio"
                aria-checked={c === color}
                aria-label={c}
                tabIndex={0}
                onClick={() => setColor(c)}
                onKeyDown={(e) => e.key === "Enter" && setColor(c)}
                sx={{
                  width: 28,
                  height: 28,
                  borderRadius: "50%",
                  bgcolor: c,
                  cursor: "pointer",
                  outline: c === color ? 2 : 0,
                  outlineColor: "text.primary",
                  outlineOffset: 2,
                }}
              />
            ))}
          </Box>
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        {list && (
          <Button color="error" onClick={() => (confirmDelete ? void handleDelete() : setConfirmDelete(true))} sx={{ mr: "auto" }}>
            {confirmDelete ? "Really delete?" : "Delete"}
          </Button>
        )}
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={() => void handleSave()} disabled={!name.trim() || saving}>
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}
