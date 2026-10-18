import mongoose, { Schema } from 'mongoose'
import type { ProjectRepository } from '../application/use-cases'
import type { Project } from '../domain/project'

interface ProjectDoc extends mongoose.Document {
  id: string
  name: string
  payload: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

/**
 * MongoDB adapter, used when MONGO_URI env is set.
 * Connects lazily on first call so importing it is side-effect free.
 */
export class MongooseProjectRepository implements ProjectRepository {
  private connectPromise: Promise<void> | null = null

  constructor(uri: string, private readonly dbName = 'video_editor') {
    this.connectPromise = mongoose
      .connect(uri, { dbName })
      .then(() => undefined)
  }

  private get model(): mongoose.Model<ProjectDoc> {
    return (
      mongoose.models.Project ??
      mongoose.model<ProjectDoc>(
        'Project',
        new Schema<ProjectDoc>(
          {
            id: { type: String, required: true, unique: true },
            name: { type: String, required: true },
            payload: { type: Schema.Types.Mixed, required: true },
            createdAt: { type: String, required: true },
            updatedAt: { type: String, required: true },
          },
          { versionKey: false },
        ),
      )
    )
  }

  private async ready(): Promise<void> {
    await this.connectPromise
  }

  async save(project: Project): Promise<void> {
    await this.ready()
    await this.model.updateOne({ id: project.id }, project, { upsert: true })
  }

  async get(id: string): Promise<Project | null> {
    await this.ready()
    const doc = await this.model.findOne({ id }).lean<ProjectDoc & { _id: unknown } | null>()
    if (!doc) return null
    const { _id, ...rest } = doc
    return rest as unknown as Project
  }

  async list(): Promise<Project[]> {
    await this.ready()
    const docs = await this.model.find().sort({ updatedAt: -1 }).lean<(ProjectDoc & { _id: unknown })[]>()
    return docs.map(({ _id, ...rest }) => rest as unknown as Project)
  }
}
