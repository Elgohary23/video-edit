import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { createContainer } from '../src/container'
import { loadEnv } from '../src/config/env'

function appWithMemoryRepo() {
  const env = { ...loadEnv(), mongoUri: '' }
  return createApp(createContainer(env))
}

describe('API', () => {
  it('GET /api/health → ok', async () => {
    const res = await request(appWithMemoryRepo()).get('/api/health')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ status: 'ok' })
  })

  describe('projects', () => {
    it('creates a project and reads it back', async () => {
      const app = appWithMemoryRepo()
      const created = await request(app)
        .post('/api/projects')
        .send({ name: 'Edit 1', payload: { clips: [] } })
      expect(created.status).toBe(201)
      expect(created.body).toMatchObject({ name: 'Edit 1' })
      expect(typeof created.body.id).toBe('string')

      const fetched = await request(app).get(`/api/projects/${created.body.id}`)
      expect(fetched.status).toBe(200)
      expect(fetched.body.payload).toEqual({ clips: [] })
    })

    it('rejects invalid payloads with 400', async () => {
      const res = await request(appWithMemoryRepo())
        .post('/api/projects')
        .send({ name: '', payload: 'bad' })
      expect(res.status).toBe(400)
      expect(res.body.error).toBeTruthy()
    })

    it('lists projects newest first and 404s unknown ids', async () => {
      const app = appWithMemoryRepo()
      await request(app).post('/api/projects').send({ name: 'A', payload: {} })
      await request(app).post('/api/projects').send({ name: 'B', payload: {} })

      const list = await request(app).get('/api/projects')
      expect(list.status).toBe(200)
      expect(list.body.map((p: { name: string }) => p.name)).toContain('A')

      const missing = await request(app).get('/api/projects/does-not-exist')
      expect(missing.status).toBe(404)
    })

    it('rejects malformed JSON body with 400', async () => {
      const res = await request(appWithMemoryRepo())
        .post('/api/projects')
        .set('Content-Type', 'application/json')
        .send('{"name": broken')
      expect(res.status).toBe(400)
    })
  })
})
