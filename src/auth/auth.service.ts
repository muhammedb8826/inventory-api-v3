import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import { EntityManager, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { hashToken } from '../common/utils/token-hash.util';
import { RefreshToken } from '../database/entities/refresh-token.entity';
import { User } from '../database/entities/user.entity';
import { LoginDto } from './dto/auth.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(RefreshToken)
    private readonly refreshRepo: Repository<RefreshToken>,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async login(dto: LoginDto) {
    const user = await this.userRepo
      .createQueryBuilder('user')
      .addSelect('user.passwordHash')
      .leftJoinAndSelect('user.role', 'role')
      .leftJoinAndSelect('role.permissions', 'permissions')
      .where('user.email = :email', { email: dto.email.toLowerCase() })
      .andWhere('user.isActive = true')
      .getOne();
    if (!user || !(await bcrypt.compare(dto.password, user.passwordHash))) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const tokens = await this.issueTokens(user.id, user.email);
    return { user: this.toUserProfile(user), ...tokens };
  }

  async refresh(refreshToken: string) {
    try {
      await this.jwt.verifyAsync(refreshToken, {
        secret: this.config.get<string>('jwt.refreshSecret'),
      });
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const result = await this.refreshRepo.manager.transaction(
      async (manager) => {
        const repo = manager.getRepository(RefreshToken);
        const stored = await repo.findOne({
          where: { tokenHash: hashToken(refreshToken) },
          lock: { mode: 'pessimistic_write' },
        });
        if (stored?.isRevoked) {
          await repo.update({ userId: stored.userId }, { isRevoked: true });
          await manager
            .getRepository(User)
            .increment({ id: stored.userId }, 'sessionVersion', 1);
          return null;
        }
        if (!stored || stored.expiresAt < new Date()) {
          throw new UnauthorizedException('Invalid refresh token');
        }
        const user = await manager.getRepository(User).findOne({
          where: { id: stored.userId, isActive: true },
          relations: { role: { permissions: true } },
        });
        if (!user) throw new UnauthorizedException('User inactive');
        const original = this.jwt.decode(refreshToken);
        if ((original.sv ?? 0) !== user.sessionVersion)
          throw new UnauthorizedException('Session revoked');
        stored.isRevoked = true;
        await repo.save(stored);
        const tokens = await this.issueTokens(user.id, user.email, manager);
        return { user: this.toUserProfile(user), ...tokens };
      },
    );
    if (!result)
      throw new UnauthorizedException(
        'Refresh token reuse detected; sign in again',
      );
    return result;
  }

  async logout(refreshToken: string) {
    const tokenHash = hashToken(refreshToken);
    await this.refreshRepo.update({ tokenHash }, { isRevoked: true });
    return { success: true };
  }

  async me(userId: string) {
    const user = await this.findActiveUser(userId);
    return this.toUserProfile(user);
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const user = await this.findActiveUser(userId);

    if (dto.email !== undefined) {
      const email = dto.email.toLowerCase();
      if (email !== user.email) {
        const exists = await this.userRepo.findOne({ where: { email } });
        if (exists) {
          throw new ConflictException('Email already registered');
        }
        user.email = email;
      }
    }

    if (dto.fullName !== undefined) {
      user.fullName = dto.fullName;
    }

    await this.userRepo.save(user);
    return this.me(userId);
  }

  async changePassword(userId: string, dto: ChangePasswordDto) {
    if (dto.currentPassword === dto.newPassword) {
      throw new BadRequestException(
        'New password must be different from current password',
      );
    }

    const user = await this.userRepo
      .createQueryBuilder('user')
      .addSelect('user.passwordHash')
      .where('user.id = :id', { id: userId })
      .andWhere('user.isActive = true')
      .getOne();

    if (!user) throw new UnauthorizedException();

    const valid = await bcrypt.compare(dto.currentPassword, user.passwordHash);
    if (!valid) {
      throw new BadRequestException('Current password is incorrect');
    }

    user.passwordHash = await bcrypt.hash(dto.newPassword, 12);
    user.sessionVersion += 1;
    await this.userRepo.save(user);

    await this.refreshRepo.update(
      { userId, isRevoked: false },
      { isRevoked: true },
    );

    return { success: true };
  }

  private async findActiveUser(userId: string) {
    const user = await this.userRepo.findOne({
      where: { id: userId, isActive: true },
      relations: { role: { permissions: true } },
    });
    if (!user) throw new UnauthorizedException();
    return user;
  }

  private toUserProfile(user: User) {
    return {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      role: user.role
        ? {
            id: user.role.id,
            name: user.role.name,
            permissions: user.role.permissions?.map((p) => p.code) ?? [],
          }
        : null,
    };
  }

  private async issueTokens(
    userId: string,
    email: string,
    manager?: EntityManager,
  ) {
    const users = manager ? manager.getRepository(User) : this.userRepo;
    const user = await users.findOneByOrFail({ id: userId });
    const payload = {
      sub: userId,
      email,
      jti: randomUUID(),
      sv: user.sessionVersion,
    };
    const [accessToken, refreshToken] = await Promise.all([
      this.jwt.signAsync(payload, {
        secret: this.config.get<string>('jwt.accessSecret'),
        expiresIn: this.config.get('jwt.accessExpiresIn'),
      }),
      this.jwt.signAsync(payload, {
        secret: this.config.get<string>('jwt.refreshSecret'),
        expiresIn: this.config.get('jwt.refreshExpiresIn'),
      }),
    ]);

    const decoded = this.jwt.decode(refreshToken);
    const repo = manager
      ? manager.getRepository(RefreshToken)
      : this.refreshRepo;
    await repo.save(
      repo.create({
        userId,
        tokenHash: hashToken(refreshToken),
        expiresAt: new Date(decoded.exp * 1000),
      }),
    );

    return { accessToken, refreshToken };
  }
}
