// Pure application contract for the native phone's missed-day background
// check. Both Node/Docker and Cloudflare use this exact calculation.
import { excusedOn, nudgeFor } from "./nudge.js";

export const validNudgeDate = date =>
  /^\d{4}-\d{2}-\d{2}$/.test(date) &&
  !Number.isNaN(Date.parse(date + "T00:00:00Z"));

export function nudgeCheckStatus(state, date, rev = 0) {
  const doc = state || {};
  const workouts = Array.isArray(doc.workouts) ? doc.workouts : [];
  const done = workouts.some(w => w && w.d === date) || excusedOn(doc,date);
  let nudge = false;
  try { nudge = !done && !!nudgeFor(doc,date); }
  catch { nudge = true; } // When the rule cannot be evaluated, retain the phone's scheduled alert.
  return {date,done,nudge,rev};
}
