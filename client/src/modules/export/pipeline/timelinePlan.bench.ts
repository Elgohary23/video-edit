/**
 * Placement-lookup micro-benchmark (run with `npm run bench -w client`).
 *
 * Exports resolve a clip/source instant once per output frame. The original
 * exporter used the linear `timelineToSource` scan for that lookup; the current
 * planner uses a binary search over the precomputed, sorted clip plan. This
 * benchmark keeps both implementations side by side so the improvement can be
 * re-measured instead of trusted.
 */
import { describe, expect, it } from 'vitest'
import { planClips, placementAt } from './timelinePlan'
import { timelineToSource, type Clip } from '../../timeline/engine'

const CLIP_COUNT = 400
const LOOKUPS = 200

const clips: Clip[] = Array.from({ length: CLIP_COUNT }, (_, index) => ({
  id: `clip-${index}`,
  srcStartMs: index * 2000,
  srcEndMs: (index + 1) * 2000,
  zoom: 1,
  videoId: 'v1',
}))
const planned = planClips(clips, [{ id: 'v1' }], 'v1')
const totalMs = CLIP_COUNT * 2000
const sampleTimes = Float64Array.from({ length: LOOKUPS }, (_, index) => (index * 7919) % totalMs)
// Hoist the exported functions once: reading a module export getter inside a
// benchmark loop would dominate the measured work.
const binaryLookup = placementAt
const linearLookup = timelineToSource

function runBinary(): number {
  let found = 0
  for (const timelineMs of sampleTimes) {
    if (binaryLookup(planned, timelineMs)) found++
  }
  return found
}

function runLinear(): number {
  let found = 0
  for (const timelineMs of sampleTimes) {
    if (linearLookup(clips, timelineMs)) found++
  }
  return found
}

describe('export placement lookup (400 clips, 200 lookups)', () => {
  it('binary search is faster than the linear scan it replaced', async ({ bench }) => {
    const results = await bench.compare(
      bench('binary placementAt (current)', () => {
        if (runBinary() !== LOOKUPS) throw new Error('unexpected hit count')
      }),
      bench('linear timelineToSource (pre-optimization)', () => {
        if (runLinear() !== LOOKUPS) throw new Error('unexpected hit count')
      }),
    )
    expect(results.get('binary placementAt (current)')).toBeFasterThan(
      results.get('linear timelineToSource (pre-optimization)'),
    )
  })
})
