import { useState } from "react";
import { InputAdornment, TextField } from "@mui/material";
import AddRoundedIcon from "@mui/icons-material/AddRounded";
import { useTasks } from "../hooks/useTasks";
import { useSaveGuard } from "../hooks/useSaveGuard";
import { useNotification } from "../hooks/useNotification";
import { useAreas } from "../hooks/useAreas";
import { parseQuickAdd } from "../utils/quickAdd";
import type { TaskDefaults } from "./TaskDialog";

/**
 * The one-line way in: type, press Enter, keep typing.
 *
 * The view's defaults (this list, due today) apply unless the shorthand in
 * `utils/quickAdd.ts` overrides them. The field clears as soon as the save is
 * accepted *or queued* — a task added offline is safe on the device, and
 * making someone wait for the network before they can type the next one is
 * exactly backwards.
 */
export default function QuickAdd({ defaults = {}, placeholder = "Add a task" }: { defaults?: TaskDefaults; placeholder?: string }) {
  const { create } = useTasks();
  const { saving, save } = useSaveGuard();
  const { notify } = useNotification();
  const { defaultAreaId } = useAreas();
  const [text, setText] = useState("");

  const submit = () => {
    const parsed = parseQuickAdd(text);
    if (!parsed.title) return;
    const body = {
      title: parsed.title,
      list_id: defaults.list_id ?? null,
      // Into the area on screen — a list brings its own area instead.
      ...(defaults.list_id ? {} : { area_id: defaults.area_id ?? defaultAreaId }),
      due_date: parsed.due_date ?? defaults.due_date ?? null,
      priority: parsed.priority ?? defaults.priority ?? "none",
    };
    void save(body, async (key) => {
      try {
        await create(body, key);
        setText("");
      } catch (err) {
        notify(err instanceof Error ? err.message : "Couldn't add the task.", "error");
      }
    });
  };

  return (
    <TextField
      fullWidth
      size="small"
      value={text}
      placeholder={placeholder}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !saving) {
          e.preventDefault();
          submit();
        }
        if (e.key === "Escape") (e.target as HTMLInputElement).blur();
      }}
      // Enter is the submit — `enterKeyHint` makes a phone keyboard say so.
      slotProps={{
        htmlInput: { enterKeyHint: "done", "aria-label": placeholder },
        input: {
          startAdornment: (
            <InputAdornment position="start">
              <AddRoundedIcon sx={{ color: "text.secondary" }} />
            </InputAdornment>
          ),
        },
      }}
      sx={{ mb: 2 }}
    />
  );
}
