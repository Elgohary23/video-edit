import { Router } from 'express'
import type { GetProject, ListProjects, SaveProject } from '../../application/use-cases'
import { parseProjectInput } from '../../domain/project'

interface ProjectsDeps {
  saveProject: SaveProject
  getProject: GetProject
  listProjects: ListProjects
}

/** Application-layer protocol errors surfaced as HTTP statuses. */
export class NotFoundError extends Error {}
export class ValidationError extends Error {}

export function projectsRoutes(deps: ProjectsDeps): Router {
  return Router()
    .get('/', async (_req, res, next) => {
      try {
        res.json(await deps.listProjects.exec())
      } catch (err) {
        next(err)
      }
    })
    .post('/', async (req, res, next) => {
      try {
        const parsed = parseProjectInput(req.body)
        if (!parsed.ok) throw new ValidationError(parsed.error)
        const project = await deps.saveProject.exec({ name: parsed.value.name, payload: parsed.value.payload })
        res.status(201).json(project)
      } catch (err) {
        next(err)
      }
    })
    .get('/:id', async (req, res, next) => {
      try {
        const project = await deps.getProject.exec(req.params.id)
        if (!project) throw new NotFoundError('Project not found')
        res.json(project)
      } catch (err) {
        next(err)
      }
    })
}
