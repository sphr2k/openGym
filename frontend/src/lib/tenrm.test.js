import { sessionPrs } from './finish-workout.js'
import { rebuildPrHistory } from './workout-date.js'
import { describe, expect, it } from 'vitest'
import { best10RM, estimate10RM, is10RMRecord, workoutRecords } from './tenrm.js'

const entry = (w, r, extra = {}) => ({ id: 'bench', target: { mode: 'reps' }, sets: [{ w, r, done: true, ...extra }] })

describe('10RM estimate and records', () => {
  it('normalises Epley to ten reps including logged reserve', () => {
    expect(estimate10RM(80, 8)).toBe(76)
    expect(estimate10RM(80, 10)).toBe(80)
    expect(estimate10RM(80, 8, 2)).toBe(80)
    expect(best10RM(entry(80, 8, { rpe: 8 }))).toBe(80)
  })
  it('rejects invalid inputs and estimates outside the effective rep cap', () => {
    for (const args of [[0, 8], [-1, 8], [80, 0], [Infinity, 8], [80, 13], [80, 11, 2], [80, 8, -1], [80, 8, NaN]]) {
      expect(estimate10RM(...args)).toBeNull()
    }
    expect(estimate10RM(80, 10, 2)).not.toBeNull()
  })
  it('awards more reps, rejects ties and does not reward load alone', () => {
    const state = { workouts: [{ entries: [entry(80, 10)] }] }
    expect(is10RMRecord(state, entry(80, 11))).toBe(true)
    expect(is10RMRecord(state, entry(80, 10))).toBe(false)
    expect(is10RMRecord(state, entry(82, 8))).toBe(false)
    expect(is10RMRecord({ workouts: [] }, entry(80, 8))).toBe(true)
  })
  it('does not alter missing historical effort and excludes warmups and incomplete sets', () => {
    const old = entry(80, 8)
    const before = structuredClone(old)
    expect(best10RM(old)).toBe(76)
    expect(old).toEqual(before)
    expect(best10RM(entry(100, 8, { done: false }))).toBeNull()
    expect(best10RM(entry(100, 8, { warmup: true }))).toBeNull()
  })
  it('does not estimate assistance or bodyweight-only loads', () => {
    expect(best10RM({ ...entry(80, 8), target: { mode: 'reps', assisted: true } })).toBeNull()
    expect(best10RM({ ...entry(80, 8), target: { mode: 'reps', bodyweight: true } })).toBeNull()
  })
  it('compares unrounded values', () => {
    const state = { workouts: [{ entries: [entry(80, 10)] }] }
    expect(is10RMRecord(state, entry(80.001, 10))).toBe(true)
  })
})

it('normalises each/total dumbbell loads when comparing history', () => {
  const previous = { ...entry(40, 10), id: '0289', target: { mode: 'reps', dbLoad: 'total' } }
  const current = { ...entry(20, 10), id: '0289', target: { mode: 'reps', dbLoad: 'each' } }
  const state = { workouts: [{ entries: [previous] }] }
  expect(workoutRecords(state, [current])).toEqual([])
  current.sets[0].r = 11
  expect(workoutRecords(state, [current, current])).toEqual(['0289'])
})

it('uses the same rule at finish and when history is rebuilt, without duplicate badges', () => {
  const first = { id: 'a', d: '2026-01-01', entries: [entry(80, 8)], prs: ['bench'] }
  const moved = { id: 'b', d: '2026-01-02', entries: [entry(80, 10), entry(80, 9)], prs: [] }
  const tie = { id: 'c', d: '2026-01-03', entries: [entry(80, 10)], prs: ['bench'] }
  expect(sessionPrs({ workouts: [first] }, moved.entries).prs).toEqual(['bench'])
  const rebuilt = rebuildPrHistory([first, moved, tie], ['bench'], moved)
  expect(rebuilt.map(w => w.prs)).toEqual([['bench'], ['bench'], []])
  expect(rebuildPrHistory(rebuilt, ['bench'])).toEqual(rebuilt)
  const corrected = { ...moved, entries: [entry(80, 7)] }
  expect(rebuildPrHistory([first, corrected, tie], ['bench'], corrected).map(w => w.prs))
    .toEqual([['bench'], [], ['bench']])
})

it('keeps comparison invariant when all stored weights switch between kg and lb', () => {
  for (const factor of [1, 2.20462262185]) {
    const history = { workouts: [{ entries: [entry(80 * factor, 8)] }] }
    expect(workoutRecords(history, [entry(80 * factor, 10)])).toEqual(['bench'])
    expect(workoutRecords(history, [entry(80 * factor, 8)])).toEqual([])
  }
})

it('estimates completed unilateral sides individually, without counting the unfinished side', () => {
  const en = { id: 'bench', target: { mode: 'reps' }, sets: [{ done: false, sides: {
    L: { w: 80, r: 8, done: true, rir: 2 }, R: { w: 100, r: 10, done: false },
  } }] }
  expect(best10RM(en)).toBe(80)
})
