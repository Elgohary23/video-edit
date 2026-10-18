/**
 * Persistence client for the server's project context (server/src/contexts/projects).
 * Snapshots are JSON payloads; media files stay local by design.
 */

export interface SavedProjectSummary {
  id: string
  name: string
  createdAt: string
  updatedAt: string
}

export interface SavedProject extends SavedProjectSummary {
  payload: Record<string, unknown>
}

const INTERNAL_API_BASE = import.meta.env.VITE_API_BASE ?? '/api'

async function unwrap<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const detail = await res
      .json()
      .then((body: { error?: string }) => body.error)
      .catch(() => res.statusText)
    throw new Error(detail || `Request failed with status ${res.status}`)
  }
  return res.json() as Promise<T>
}

export async function saveProject(name: string, payload: Record<string, unknown>): Promise<SavedProject> {
  const res = await fetch(`${INTERNAL_API_BASE}/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, payload }),
  })
  return unwrap<SavedProject>(res)
}

export async function listProjects(): Promise<SavedProjectSummary[]> {
  const res = await fetch(`${INTERNAL_API_BASE}/projects`)
  return unwrap<SavedProjectSummary[]>(res)
}

export async function loadProject(id: string): Promise<SavedProject> {
  const res = await fetch(`${INTERNAL_API_BASE}/projects/${id}`)
  return unwrap<SavedProject>(res)
}
