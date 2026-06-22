import './env'
import './logger'
import { NestFactory } from '@nestjs/core'
import { Logger } from 'nestjs-pino'
import { AppModule } from './app.module'

async function bootstrap() {
  // bufferLogs holds startup logs until our Pino logger is wired in below.
  const app = await NestFactory.create(AppModule, { bufferLogs: true })

  // Route Nest's framework logs through the same Pino instance (replaces the
  // hand-rolled LoggerService bridge).
  app.useLogger(app.get(Logger))

  // Enable CORS so the Next.js frontend on port 3000 can talk to this Control App
  app.enableCors()

  await app.listen(env.PORT)
  log.info(`Control App HTTP server listening on port ${env.PORT}`)
}
bootstrap().catch((err: unknown) => {
  log.error(err, 'Failed to start application')
})
