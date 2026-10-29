import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import { QueryFailedError, Repository } from 'typeorm';
import {
  applyIlikeSearch,
  paginatedQueryBuilder,
} from '../common/utils/query.util';
import { Role } from '../database/entities/role.entity';
import { User } from '../database/entities/user.entity';
import { LocationAccessService } from '../locations/location-access.service';
import { CreateUserDto, UpdateUserDto } from './dto/user.dto';
import { UserListQueryDto } from './dto/user-list-query.dto';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(Role)
    private readonly roleRepo: Repository<Role>,
    private readonly locationAccess: LocationAccessService,
  ) {}

  findAll(query: UserListQueryDto) {
    const qb = this.userRepo
      .createQueryBuilder('user')
      .leftJoinAndSelect('user.role', 'role')
      .orderBy('user.created_at', 'DESC');

    if (query.roleId) {
      qb.andWhere('user.role_id = :roleId', { roleId: query.roleId });
    }
    if (query.isActive === 'true') {
      qb.andWhere('user.is_active = true');
    } else if (query.isActive === 'false') {
      qb.andWhere('user.is_active = false');
    }
    applyIlikeSearch(qb, query.search, ['user.email', 'user.full_name']);

    return paginatedQueryBuilder(qb, query.page, query.limit);
  }

  async findOne(id: string) {
    const user = await this.userRepo.findOne({
      where: { id },
      relations: { role: { permissions: true }, userLocations: true },
    });
    if (!user) throw new NotFoundException('User not found');
    const locationIds = (user.userLocations ?? []).map((ul) => ul.locationId);
    return { ...user, locationIds };
  }

  /** Slim active-user list for assignee pickers (not full admin user admin). */
  findAssignees() {
    return this.userRepo
      .createQueryBuilder('user')
      .select(['user.id', 'user.fullName', 'user.email', 'user.isActive'])
      .where('user.is_active = true')
      .orderBy('user.full_name', 'ASC')
      .getMany();
  }

  private async assertRole(roleId: string | null | undefined) {
    if (roleId == null || roleId === '') return null;
    const role = await this.roleRepo.findOne({ where: { id: roleId } });
    if (!role) throw new BadRequestException('Role not found');
    return role;
  }

  async create(dto: CreateUserDto) {
    const exists = await this.userRepo.findOne({
      where: { email: dto.email.toLowerCase() },
    });
    if (exists) throw new ConflictException('Email already registered');

    const role = await this.assertRole(dto.roleId);
    const user = this.userRepo.create({
      email: dto.email.toLowerCase(),
      fullName: dto.fullName,
      roleId: role?.id ?? null,
      passwordHash: await bcrypt.hash(dto.password, 10),
    });
    const saved = await this.userRepo.save(user);
    if (dto.locationIds !== undefined) {
      await this.locationAccess.setUserLocations(saved.id, dto.locationIds);
    }
    return this.findOne(saved.id);
  }

  async update(id: string, dto: UpdateUserDto) {
    await this.findOne(id);

    const patch: Partial<User> = {};
    if (dto.email) patch.email = dto.email.toLowerCase();
    if (dto.fullName) patch.fullName = dto.fullName;
    if (dto.isActive !== undefined) patch.isActive = dto.isActive;
    if (dto.roleId !== undefined) {
      const role = await this.assertRole(dto.roleId);
      patch.roleId = role?.id ?? null;
    }
    if (dto.password) {
      patch.passwordHash = await bcrypt.hash(dto.password, 12);
      await this.userRepo.increment({ id }, 'sessionVersion', 1);
    }

    if (Object.keys(patch).length > 0) {
      await this.userRepo.update(id, patch);
      if (dto.isActive === false) {
        await this.userRepo.increment({ id }, 'sessionVersion', 1);
      }
    }
    if (dto.locationIds !== undefined) {
      await this.locationAccess.setUserLocations(id, dto.locationIds);
    }
    return this.findOne(id);
  }

  /** Soft-disable login; keeps audit / transaction history. */
  async deactivate(id: string, actorUserId?: string) {
    if (actorUserId && id === actorUserId) {
      throw new BadRequestException('You cannot deactivate your own account');
    }
    await this.findOne(id);
    await this.userRepo.update(id, { isActive: false });
    await this.userRepo.increment({ id }, 'sessionVersion', 1);
    return this.findOne(id);
  }

  /**
   * Permanently delete a user. Fails if they still own transactional history
   * (sales, stock moves, etc.) — deactivate instead in that case.
   */
  async remove(id: string, actorUserId?: string) {
    if (actorUserId && id === actorUserId) {
      throw new BadRequestException('You cannot delete your own account');
    }
    const user = await this.userRepo.findOne({ where: { id } });
    if (!user) throw new NotFoundException('User not found');

    try {
      await this.userRepo.delete(id);
    } catch (err) {
      if (
        err instanceof QueryFailedError &&
        (err as QueryFailedError & { code?: string }).code === '23503'
      ) {
        throw new BadRequestException(
          'This user has transaction history and cannot be deleted. Deactivate them instead.',
        );
      }
      throw err;
    }

    return { deleted: true, id };
  }
}
