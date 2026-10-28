import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../../database/entities/user.entity';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { JwtPayload } from '../../common/decorators/current-user.decorator';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: ConfigService,
    @InjectRepository(User) private readonly users: Repository<User>,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('jwt.accessSecret'),
    });
  }

  async validate(payload: {
    sub: string;
    email: string;
    sv?: number;
  }): Promise<JwtPayload> {
    if (!payload?.sub) throw new UnauthorizedException();
    if (
      !(await this.users.existsBy({
        id: payload.sub,
        isActive: true,
        sessionVersion: payload.sv ?? 0,
      }))
    )
      throw new UnauthorizedException('User inactive');
    return { sub: payload.sub, email: payload.email };
  }
}
