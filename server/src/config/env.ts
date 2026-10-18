/** Runtime kube config, typed. Only touch env at startup. */
function requiredNumber(value: string | undefined, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export interface Env {
  port: number
  mongoUri: string
}

export function loadEnv(env: NodeJS.ProcessEnv = process.env): Env {
  return {
    port: requiredNumber(env.PORT, 4000),
    mongoUri: env.MONGO_URI ?? '',
  }
}
