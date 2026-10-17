import { api } from "./client";
import type { Area, Briefing, Task, TaskInput, TaskList, UserSettings } from "../types/models";

/**
 * The task API, in one place — components never call `fetch` (or even `api`)
 * for tasks directly.
 *
 * Creates go through `createEntry` in `outbox.ts` rather than here, because a
 * create is the one write that may be held on the device and sent later.
 */

/** Every open task. Every view the app has is a filter over this set. */
export function fetchOpenTasks(): Promise<Task[]> {
  return api.get<Task[]>("/tasks");
}

/**
 * Completed tasks, newest first; pass the last row's `completed_at` to page.
 * Filtered by area on the server, because paging a filter applied on the
 * device would show half-empty pages.
 */
export function fetchCompletedTasks(before?: string, areaId?: number | null): Promise<Task[]> {
  const params = new URLSearchParams({ status: "completed", limit: "50" });
  if (before) params.set("before", before);
  if (areaId) params.set("area_id", String(areaId));
  return api.get<Task[]>(`/tasks?${params}`);
}

export function searchTasks(q: string, status: "open" | "completed", areaId?: number | null): Promise<Task[]> {
  const params = new URLSearchParams({ q, status });
  if (areaId) params.set("area_id", String(areaId));
  return api.get<Task[]>(`/tasks?${params}`);
}

export function updateTask(id: number, changes: Partial<TaskInput>): Promise<Task> {
  return api.put<Task>(`/tasks/${id}`, changes);
}

export function deleteTask(id: number): Promise<{ ok: boolean }> {
  return api.delete<{ ok: boolean }>(`/tasks/${id}`);
}

export function completeTask(id: number): Promise<{ task: Task; next: Task | null }> {
  return api.post<{ task: Task; next: Task | null }>(`/tasks/${id}/complete`, {});
}

export function reopenTask(id: number): Promise<Task> {
  return api.post<Task>(`/tasks/${id}/reopen`, {});
}

export function snoozeTask(id: number, minutes: number): Promise<Task> {
  return api.post<Task>(`/tasks/${id}/snooze`, { minutes });
}

export interface ListsResponse {
  lists: TaskList[];
  inbox_count: number;
  /** Open Inbox tasks per area id. */
  inbox_counts: Record<string, number>;
}

export function fetchLists(): Promise<ListsResponse> {
  return api.get<ListsResponse>("/lists");
}

export function createList(name: string, color: string, areaId: number, clientRequestId: string): Promise<TaskList> {
  return api.post<TaskList>("/lists", { name, color, area_id: areaId, client_request_id: clientRequestId });
}

export function updateList(id: number, changes: Partial<Pick<TaskList, "name" | "color" | "position" | "area_id">>): Promise<TaskList> {
  return api.put<TaskList>(`/lists/${id}`, changes);
}

export function deleteList(id: number): Promise<{ ok: boolean }> {
  return api.delete<{ ok: boolean }>(`/lists/${id}`);
}

export function fetchAreas(): Promise<Area[]> {
  return api.get<Area[]>("/areas");
}

export function createArea(name: string, color: string, clientRequestId: string): Promise<Area> {
  return api.post<Area>("/areas", { name, color, client_request_id: clientRequestId });
}

export function updateArea(id: number, changes: Partial<Pick<Area, "name" | "color" | "position">>): Promise<Area> {
  return api.put<Area>(`/areas/${id}`, changes);
}

/** Deletes the area; its lists and tasks move to `moveTo`. */
export function deleteArea(id: number, moveTo: number): Promise<{ ok: boolean }> {
  return api.delete<{ ok: boolean }>(`/areas/${id}?move_to=${moveTo}`);
}

export function updateSettings(changes: Partial<Omit<UserSettings, "user_id">>): Promise<UserSettings> {
  return api.put<UserSettings>("/settings", changes);
}

/**
 * Today's briefing. `getOptional`: nobody opened the app to read it, so a
 * failure here must not raise the stale-data banner — the same call
 * BabyTracker made for its daily note.
 */
export async function fetchBriefing(): Promise<Briefing | null> {
  const res = await api.getOptional<{ briefing: Briefing | null }>("/briefing");
  return res?.briefing ?? null;
}

export function refreshBriefing(): Promise<{ briefing: Briefing; source: string; reason: string | null }> {
  return api.postSlow("/briefing/refresh", {});
}
