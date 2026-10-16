/**
 * `<input>` types with no draft to lose: a checkbox or radio is a two-state
 * control the tap itself already committed, unlike a text field mid-edit.
 * The dashboard and to-do list's checkboxes sit right in the page, not inside
 * a dialog, and are the single most common tap on those screens. iOS never
 * blurs a focused element just because the app was backgrounded, so a
 * checkbox tapped right before backgrounding was staying `document.activeElement`
 * indefinitely — holding every refresh hostage (including the foreground poll)
 * until something else on the page happened to steal focus, which for anyone
 * who only ever checks off to-dos could be never.
 */
const NON_EDITABLE_INPUT_TYPES = new Set([
  "checkbox",
  "radio",
  "button",
  "submit",
  "reset",
  "range",
  "color",
  "file",
  "image",
]);

/**
 * Is the user in the middle of something that must not be interrupted?
 *
 * Reloading the page — or churning every list underneath an open dialog —
 * throws away whatever has been typed. This app gets used one-handed, mid-feed,
 * so losing a half-filled form is a real cost. Both the service-worker update
 * reload and the on-focus refetch check this before doing anything disruptive.
 *
 * It's deliberately a DOM-level question rather than a flag each dialog has to
 * register: any open modal or focused field counts, so pages added later are
 * covered without opting in.
 */
export function isUserBusy(): boolean {
  if (typeof document === "undefined") return false;

  // MUI's Dialog puts role="dialog" on its paper. Layout's bottom "Log" sheet
  // is hand-rolled and has to set the role itself — it went without one for a
  // while, and refreshes fired straight through it, rebuilding the page under
  // an open sheet. Anything modal added later needs the same.
  //
  // Presence of the role is not enough on its own: `SwipeableDrawer` keeps its
  // paper mounted while closed so the open gesture has something to drag, and
  // that paper carries role="dialog" the whole time. Matching on the role
  // alone therefore made this function return true permanently — the nav
  // drawer is part of every screen — which silently disabled every refresh
  // that consults it, and the deferred update reload with them.
  //
  // A closed modal is marked `aria-hidden` (MUI puts it on the Modal root
  // around the paper), which is precisely the "not presented to the user"
  // signal wanted here, and it needs no layout to read.
  for (const dialog of document.querySelectorAll('[role="dialog"]')) {
    if (!dialog.closest('[aria-hidden="true"]')) return true;
  }

  const active = document.activeElement as HTMLElement | null;
  if (!active) return false;
  if (active.isContentEditable) return true;

  // A focused field still counts when the window itself is blurred: tapping a
  // datetime input on iOS hands focus to the native picker, which is exactly
  // the moment we must not pull the rug out.
  const tag = active.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  return !NON_EDITABLE_INPUT_TYPES.has((active as HTMLInputElement).type);
}
