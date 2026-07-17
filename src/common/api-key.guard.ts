import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { FastifyRequest } from 'fastify';

/**
 * Global API key guard.
 * Enforced only when the API_KEY env var is set — so local development
 * and existing Postman flows keep working until a key is configured.
 * Clients must send the key in the "x-api-key" header.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expected = process.env.API_KEY;
    if (!expected) return true;

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const provided = request.headers['x-api-key'];

    if (provided !== expected) {
      throw new UnauthorizedException('Invalid or missing API key');
    }
    return true;
  }
}
