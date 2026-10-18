import { beforeEach, describe, expect, it } from 'vitest'
import { InMemoryProjectRepository } from '../src/contexts/projects/infrastructure/in-memory.repository'
import { createProject } from '../src/contexts/projects/domain/project'

describe('InMemoryProjectRepository', () => {
  let repo: InMemoryProjectRepository

  beforeEach(() => {
    repo = new InMemoryProjectRepository()
  })

  it('round-trips a project through save/get with defensive copies', async () => {
    const project = createProject({ name: 'Demo', payload: { blades: 2 }, now: new Date('2026-01-01') })
    await repo.save(project)

    const got = await repo.get(project.id)
    expect(got).not.toBeNull()
    expect(got?.name).toBe('Demo')
    expect(got?.payload).toEqual({ blades: 2 })

    // mutating the returned copy must not corrupt the store
    got!.payload.blades = 'mutated'
    const again = await repo.get(project.id)
    expect(again?.payload).toEqual({ blades: 2 })
  })

  it('lists newest-updated first', async () => {
    const old = createProject({ name: 'old', payload: {}, now: new Date('2026-01-01') })
    const newer = createProject({ name: 'new', payload: {}, now: new Date('2026-02-01') })
    await repo.save(old)
    await repo.save(newer)

    const all = await repo.list()
    expect(all).toHaveLength(2)
    expect(all[0].name).toBe('new')
    expect(all[1].name).toBe('old')
  })

  it('returns null for unknown ids', async () => {
    expect(await repo.get('nope')).toBeNull()
  })
})
