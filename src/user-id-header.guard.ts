import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException
} from '@nestjs/common'
import type { Request } from 'express'

@Injectable()
export class UserIdHeaderGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>()
    const userId = request.headers['x-user-id']

    if (!userId) {
      throw new UnauthorizedException('Missing x-user-id header')
    }

    return true // Request is allowed to proceed
  }
}
