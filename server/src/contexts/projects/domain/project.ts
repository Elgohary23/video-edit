/**
 * Project aggregate — a saved editing session (timeline clips, props, settings).
 * Domain stays persistence-agnostic: infrastructure maps to/from this shape.
 */
export interface Project {
  id: string
  name: string
  payload: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface ProjectInput {
  name: string
  payload: Record<string, unknown>
  now?: Date
}

export function createProject(input: ProjectInput): Project {
  const nowIso = (input.now ?? new Date()).toISOString()
  const name = input.name.trim()
  return {
    id: crypto.randomUUID(),
    name: name.length > 0 ? name : 'Untitled',
    payload: input.payload,
    createdAt: nowIso,
    updatedAt: nowIso,
  }
}

/** Light invariant checks used by the interface layer to reject bad input. */
export function parseProjectInput(
  body: unknown,
): { ok: true; value: { name: string; payload: Record<string, unknown> } } | { ok: false; error: string } {
  if (typeof body !== 'object' || body === null) return { ok: false, error: 'Body must be an object' }
  const { name, payload } = body as Record<string, unknown>
  if (typeof name !== 'string' || name.length === 0) return { ok: false, error: 'Field "name" must be a non-empty string' }
  if (typeof payload !== 'object' || payload === null) return { ok: false, error: 'Field "payload" must be an object' }
  return { ok: true, value: { name, payload: payload as Record<string, unknown> } }
}
