import express, { type Request, type Response, type NextFunction } from 'express'
import cors from 'cors'
import type { Container } from './container'
import { projectsRoutes, NotFoundError, ValidationError } from './contexts/projects/interface/http/projects.routes'

/**
 * Express composition root. Isolated from `index.ts` so integration tests
 * can boot the app with an in-memory repository via supertest.
 */
export function createApp(container: Container): express.Express {
  const app = express()

  app.use(cors())
  app.use(express.json({ limit: '32mb' }))

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok' })
  })

  app.use('/api/projects', projectsRoutes(container))

  app.use((req: Request, res: Response) => {
    res.status(404).json({ error: `No route for ${req.method} ${req.path}` })
  })

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof NotFoundError) {
      res.status(404).json({ error: err.message })
      return
    }
    if (err instanceof ValidationError || err instanceof SyntaxError) {
      res.status(400).json({ error: err.message })
      return
    }
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  })

  return app
}
