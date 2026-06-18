import { Controller, Get } from '@nestjs/common'
import { DbService } from './db/db.service'

@Controller()
export class HealthController {
  constructor(private readonly db: DbService) {}

  @Get('health')
  async health() {
    await this.db.$queryRaw`SELECT 1`
    return { status: 'ok' }
  }
}
