import { useCallback, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Box, Button, IconButton, Tooltip } from "@mui/material";
import { EditRoundedIcon } from "../icons";
import TaskListView from "../components/TaskListView";
import ListDialog from "../components/ListDialog";
import { useLists } from "../hooks/useLists";
import { useAreas } from "../hooks/useAreas";
import type { Task } from "../types/models";

/** The Inbox (no list), one list, or every open task. */
export default function ListPage({ mode }: { mode: "inbox" | "list" | "all" }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const { listById, loaded } = useLists();
  const { selected, areaById } = useAreas();
  const [editing, setEditing] = useState(false);
  const listId = mode === "list" ? Number(id) : null;
  const list = listById(listId);

  const filter = useCallback(
    (t: Task) => (mode === "all" ? true : mode === "inbox" ? t.list_id === null : t.list_id === listId),
    [mode, listId],
  );

  if (mode === "list" && loaded && !list) {
    return (
      <Box sx={{ textAlign: "center", py: 8 }}>
        That list doesn't exist any more.{" "}
        <Button onClick={() => navigate("/inbox")}>Go to Inbox</Button>
      </Box>
    );
  }

  // Each area has its own Inbox; TaskListView narrows to the selected one.
  const title =
    mode === "all"
      ? "All tasks"
      : mode === "inbox"
        ? selected === "all"
          ? "Inbox"
          : `${areaById(selected)?.name ?? ""} Inbox`
        : (list?.name ?? "");

  return (
    <>
      <TaskListView
        title={title}
        filter={filter}
        defaults={{ list_id: listId }}
        hideList={mode !== "all"}
        empty={mode === "inbox" ? "Inbox zero." : "No open tasks here."}
        header={
          list && (
            <Box sx={{ mt: -1.5, mb: 1.5 }}>
              <Tooltip title="Edit list">
                <IconButton size="small" onClick={() => setEditing(true)} aria-label="Edit list">
                  <EditRoundedIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Box>
          )
        }
      />
      {list && <ListDialog open={editing} list={list} onClose={() => setEditing(false)} />}
    </>
  );
}
