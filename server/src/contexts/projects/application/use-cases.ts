import { createProject, type Project } from '../domain/project'

/** Port through which the application layer persists projects. */
export interface ProjectRepository {
  save(project: Project): Promise<void>
  get(id: string): Promise<Project | null>
  list(): Promise<Project[]>
}

/** Save-or-create a project snapshot. Returns the persisted aggregate. */
export class SaveProject {
  constructor(private readonly repo: ProjectRepository) {}

  async exec(input: { name: string; payload: Record<string, unknown>; now?: Date }): Promise<Project> {
    const project = createProject(input)
    await this.repo.save(project)
    return project
  }
}

export class GetProject {
  constructor(private readonly repo: ProjectRepository) {}

  async exec(id: string): Promise<Project | null> {
    return this.repo.get(id)
  }
}

export class ListProjects {
  constructor(private readonly repo: ProjectRepository) {}

  async exec(): Promise<Project[]> {
    return this.repo.list()
  }
}
