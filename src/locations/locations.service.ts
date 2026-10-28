import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LocationType } from '../common/enums';
import {
  applyIlikeSearch,
  paginatedQueryBuilder,
} from '../common/utils/query.util';
import { Location } from '../database/entities/location.entity';
import { CreateLocationDto, UpdateLocationDto } from './dto/location.dto';
import { LocationListQueryDto } from './dto/location-list-query.dto';
import { LocationAccessService } from './location-access.service';

@Injectable()
export class LocationsService {
  constructor(
    @InjectRepository(Location)
    private readonly locationRepo: Repository<Location>,
    private readonly locationAccess: LocationAccessService,
  ) {}

  async findAll(query: LocationListQueryDto, userId?: string) {
    const qb = this.locationRepo
      .createQueryBuilder('location')
      .leftJoinAndSelect('location.parent', 'parent')
      .orderBy('location.name', 'ASC');

    if (query.type) {
      qb.andWhere('location.type = :type', { type: query.type });
    }
    if (query.parentId) {
      qb.andWhere('location.parent_id = :parentId', {
        parentId: query.parentId,
      });
    }
    if (query.includeInactive !== 'true') {
      qb.andWhere('location.is_active = true');
    }
    applyIlikeSearch(qb, query.search, ['location.name']);

    if (userId) {
      const allowed = await this.locationAccess.getAllowedLocationIds(userId);
      if (allowed) {
        // Access to a warehouse/showroom includes its bins.
        qb.andWhere(
          '(location.id IN (:...allowed) OR location.parent_id IN (:...allowed))',
          { allowed },
        );
      }
    }

    return paginatedQueryBuilder(qb, query.page, query.limit);
  }

  async findOne(id: string, userId?: string) {
    const loc = await this.locationRepo.findOne({
      where: { id },
      relations: { parent: true, children: true },
    });
    if (!loc) throw new NotFoundException('Location not found');
    if (userId) {
      const scopeId =
        loc.type === LocationType.BIN && loc.parentId ? loc.parentId : loc.id;
      await this.locationAccess.assertCanAccessLocation(userId, scopeId);
    }
    return loc;
  }

  async create(dto: CreateLocationDto) {
    await this.assertParent(dto.type, dto.parentId);
    return this.locationRepo.save(
      this.locationRepo.create({
        name: dto.name,
        type: dto.type,
        address: dto.address ?? null,
        parentId: dto.type === LocationType.BIN ? (dto.parentId ?? null) : null,
      }),
    );
  }

  async update(id: string, dto: UpdateLocationDto) {
    const loc = await this.findOne(id);
    const nextType = dto.type ?? loc.type;
    const nextParent = dto.parentId !== undefined ? dto.parentId : loc.parentId;
    await this.assertParent(nextType, nextParent ?? undefined);
    Object.assign(loc, dto);
    if (nextType !== LocationType.BIN) {
      loc.parentId = null;
    }
    return this.locationRepo.save(loc);
  }

  async remove(id: string) {
    const loc = await this.findOne(id);
    loc.isActive = false;
    return this.locationRepo.save(loc);
  }

  private async assertParent(type: LocationType, parentId?: string | null) {
    if (type === LocationType.BIN) {
      if (!parentId) {
        throw new BadRequestException('parentId is required for BIN locations');
      }
      const parent = await this.locationRepo.findOne({
        where: { id: parentId },
      });
      if (!parent) throw new BadRequestException('Parent location not found');
      if (parent.type === LocationType.BIN) {
        throw new BadRequestException('BIN cannot be nested under another BIN');
      }
      return;
    }
    if (parentId) {
      throw new BadRequestException(
        'parentId is only allowed when type is BIN',
      );
    }
  }
}
