import type { ProjectRepository } from '../application/use-cases'
import type { Project } from '../domain/project'

/**
 * Primary in-memory repository. Default when MONGO_URI is not set —
 * keeps the local app zero-dependency and lets tests run hermetically.
 */
export class InMemoryProjectRepository implements ProjectRepository {
  private readonly store = new Map<string, Project>()

  async save(project: Project): Promise<void> {
    this.store.set(project.id, structuredClone(project))
  }

  async get(id: string): Promise<Project | null> {
    const found = this.store.get(id)
    return found ? structuredClone(found) : null
  }

  async list(): Promise<Project[]> {
    return [...this.store.values()]
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .map((p) => structuredClone(p))
  }
}
