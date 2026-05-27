import './logger'
import './env'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: false
  })

  // Enable CORS so the Next.js frontend on port 3000 can talk to this Control App
  app.enableCors()

  await app.listen(env.PORT)
  log.info(`Control App HTTP server listening on port ${env.PORT}`)
}
bootstrap().catch((err: unknown) => {
  log.error(err, 'Failed to start application')
})
