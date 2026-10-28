import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ThrottlerGuard } from '@nestjs/throttler';
@Injectable()
export class ApiThrottlerGuard extends ThrottlerGuard {
  @Inject(JwtService) private readonly jwt: JwtService;
  protected async getTracker(req: Record<string, any>): Promise<string> {
    const authorization: unknown = req.headers?.authorization;
    const token =
      typeof authorization === 'string'
        ? authorization.replace(/^Bearer /, '')
        : null;
    if (token) {
      try {
        const payload = await this.jwt.verifyAsync<{ sub: string }>(token);
        if (payload.sub) return `user:${payload.sub}`;
      } catch {
        /* Invalid credentials use the anonymous IP budget. */
      }
    }
    return `ip:${req.ip}`;
  }
}
