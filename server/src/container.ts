import type { Env } from './config/env'
import { ListProjects, SaveProject, GetProject, type ProjectRepository } from './contexts/projects/application/use-cases'
import { InMemoryProjectRepository } from './contexts/projects/infrastructure/in-memory.repository'
import { MongooseProjectRepository } from './contexts/projects/infrastructure/mongoose.repository'

/** Wiring root — the only place that decides between in-memory and Mongo. */
export interface Container {
  projectRepository: ProjectRepository
  saveProject: SaveProject
  getProject: GetProject
  listProjects: ListProjects
}

export function createContainer(env: Env): Container {
  const projectRepository: ProjectRepository = env.mongoUri
    ? new MongooseProjectRepository(env.mongoUri)
    : new InMemoryProjectRepository()

  return {
    projectRepository,
    saveProject: new SaveProject(projectRepository),
    getProject: new GetProject(projectRepository),
    listProjects: new ListProjects(projectRepository),
  }
}
