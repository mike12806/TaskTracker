/**
 * A text field drawn as a pill, like the iOS search field — the quick-add box
 * and the search box. Spread it into `sx` and pass `size="small"`; the min height brings it back up
 * to a 44pt tap target. 16px text is also what stops Safari zooming the page
 * when the field is focused.
 */
export const pillFieldSx = {
  "& .MuiOutlinedInput-root": { borderRadius: 999, bgcolor: "background.paper", minHeight: 44 },
  "& .MuiOutlinedInput-input": { fontSize: 16 },
};
