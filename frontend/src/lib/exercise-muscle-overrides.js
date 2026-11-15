// Fork-specific corrections to upstream ExerciseDB secondary-muscle associations.
// Kept separate from catalogue/exercises/ and generated exercises-data.js so upstream
// merges and catalogue refreshes cannot overwrite them. Both app and MCP use EXIDX.
//
// These are movement-specific, reviewed corrections only: an elbow held in a fixed
// position is not a meaningful concentric triceps stimulus; likewise wrist rolling
// has no dynamic biceps or triceps action. Muscle-overlap should not mistake such
// associations for training the elbow extensors. Preserve stabilizers when justified,
// and do not rewrite presses, pulls, compound movements or unverified fuzzy matches.
// Sources for candidate discovery: ExerciseDB/Kinetic comparison (2026-11-15);
// each chosen movement was checked against OpenGym's exercise instructions.
// Upstream catalogue and generated data are unchanged.
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
  // Isolated chest adduction: fixed elbow angle, not elbow extension.
  '0158': ["triceps"], // cable decline fly
  '0170': ["triceps"], // cable incline fly (on stability ball)
  '0171': ["triceps"], // cable incline fly
  '0179': ["triceps"], // cable low fly
  '0185': ["triceps"], // cable lying fly
  '0188': ["triceps"], // cable middle fly
  '0227': ["triceps"], // cable standing fly
  '0307': ["triceps"], // dumbbell decline twist fly
  '0331': ["triceps"], // dumbbell incline twisted flyes
  '0458': ["triceps"], // floor fly (with barbell)
  '1262': ["triceps"], // cable one arm decline chest fly
  '1263': ["triceps"], // cable one arm fly on exercise ball
  '1264': ["triceps"], // cable one arm incline fly on exercise ball
  '1269': ["triceps"], // cable standing up straight crossovers
  '1270': ["triceps"], // cable upper chest crossovers
  '1277': ["triceps"], // dumbbell fly on exercise ball
  '1279': ["triceps"], // dumbbell incline one arm fly
  '1286': ["triceps"], // dumbbell one arm chest fly on exercise ball
  '1288': ["triceps"], // dumbbell one arm fly on exercise ball
  '1292': ["triceps"], // dumbbell one leg fly on exercise ball
  '5858': ["triceps"], // kettlebell floor fly
  // Other isolated contractions / erroneous muscle credits.
  '0859': ["biceps", "triceps"], // wrist rollerer
  '8200': ["triceps"], // sitting prayer chest squeeze on a chair
  '1297': ["triceps"], // isometric chest squeeze
  '1167': ["triceps"], // dynamic chest stretch (male)

})

// Not all activities that name a muscle represent a strength-training stimulus.
// Keep muscle attribution for anatomy/exercise search, but do not turn stretching,
// cardio or mobility sessions into hypertrophy effective sets or MCP fatigue clocks.
export const NON_STRENGTH_CATEGORIES = Object.freeze(new Set([
  'mobility', 'stretching', 'yoga', 'cardio', 'combat',
]))
export const creditsStrengthSets = ex => !NON_STRENGTH_CATEGORIES.has(ex?.cat || ex?.category)
