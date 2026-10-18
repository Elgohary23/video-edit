import { describe, expect, it } from 'vitest'
import { createProject, parseProjectInput } from '../src/contexts/projects/domain/project'

describe('createProject', () => {
  it('assigns id, timestamps, and trims name', () => {
    const now = new Date('2026-03-04T10:00:00Z')
    const project = createProject({ name: '  Trip  ', payload: { timeline: [] }, now })
    expect(project.name).toBe('Trip')
    expect(project.createdAt).toBe(now.toISOString())
    expect(project.updatedAt).toBe(now.toISOString())
    expect(project.id).toMatch(/^[0-9a-f-]{36}$/)
  })
  it('falls back to Untitled for blank names', () => {
    const project = createProject({ name: '   ', payload: {} })
    expect(project.name).toBe('Untitled')
  })
})

describe('parseProjectInput', () => {
  it('accepts valid bodies', () => {
    expect(parseProjectInput({ name: 'A', payload: { k: 1 } })).toEqual({
      ok: true,
      value: { name: 'A', payload: { k: 1 } },
    })
  })
  it('rejects non-object bodies', () => {
    expect(parseProjectInput('no')).toEqual({ ok: false, error: 'Body must be an object' })
    expect(parseProjectInput(null)).toEqual({ ok: false, error: 'Body must be an object' })
  })
  it('rejects invalid name/payload', () => {
    expect(parseProjectInput({ name: '', payload: {} }).ok).toBe(false)
    expect(parseProjectInput({ name: 'A', payload: 7 }).ok).toBe(false)
  })
})
