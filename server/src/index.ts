import { createApp } from './app'
import { loadEnv } from './config/env'
import { createContainer } from './container'

const env = loadEnv()
const container = createContainer(env)
const app = createApp(container)

app.listen(env.port, () => {
  const persistence = env.mongoUri ? 'mongodb' : 'in-memory'
  console.log(`[server] listening on http://localhost:${env.port} (persistence: ${persistence})`)
})
