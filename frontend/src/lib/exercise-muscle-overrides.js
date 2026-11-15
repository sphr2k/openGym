// Fork-specific corrections to upstream ExerciseDB secondary-muscle associations.
// Kept separate from catalogue/exercises/ and generated exercises-data.js so upstream
// merges and catalogue refreshes cannot overwrite them. Both app and MCP use EXIDX.
//
// These are isolated raises without dynamic elbow extension. Listing the triceps as
// an effective-set secondary falsely credits it during shoulder training and creates
// spurious triceps-overlap events in the workout timeline. Halos, presses and
// combined movements are deliberately excluded from this correction.
// Reference check: kinetic-place/exercises-db, 2026-11-15 (e.g. Cable Lateral Raise
// lists only shoulders as primary); checked against the movement descriptions.
export const EXERCISE_SECONDARY_REMOVALS = Object.freeze({
  // Side-delt lateral raises.
  '0178': ['triceps'], // cable lateral raise
  '0192': ['triceps'], // cable one arm lateral raise
  '0323': ['triceps'], // dumbbell incline one arm lateral raise
  '0355': ['triceps'], // dumbbell one arm lateral raise
  '0395': ['triceps'], // dumbbell seated lateral raise v. 2
  // Front-delt raises: elbows held extended; not triceps extension exercises.
  '0041': ['triceps'], // barbell front raise
  '0107': ['triceps'], // barbell standing front raise over head
  '0162': ['triceps'], // cable front raise
  '0978': ['triceps'], // band front raise
  '4411': ['triceps'], // barbell seated high front raise
  '10588': ['triceps'], // barbell lying front raise
})
