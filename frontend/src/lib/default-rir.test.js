import { expect, it } from 'vitest'
import { withDefaultRir } from './default-rir.js'

const profile = { effort: 'rir' }
const entry = { target: { mode: 'reps' } }
const set = { done: true, w: 80, r: 8 }
it('defaults newly completed sets to RIR 0 without mutating them', () => {
  expect(withDefaultRir(profile, entry, set)).toEqual({ ...set, rir: 0 })
  expect(set.rir).toBeUndefined()
})
it('keeps explicit ratings and leaves disabled, incomplete and unsuitable sets alone', () => {
  for (const [state, en, row] of [
    [{ ...profile, defaultRir: false }, entry, set],
    [{ effort: 'rpe' }, entry, set],
    [{ effort: 'none' }, entry, set],
    [profile, entry, { ...set, rir: 2 }],
    [profile, entry, { ...set, rpe: 8 }],
    [profile, entry, { ...set, done: false }],
    [profile, entry, { ...set, warmup: true }],
    [profile, { target: { mode: 'time' } }, { done: true, sec: 30 }],
    [profile, { target: { mode: 'cardio' } }, { done: true, min: 20 }],
  ]) expect(withDefaultRir(state, en, row)).toBe(row)
})
