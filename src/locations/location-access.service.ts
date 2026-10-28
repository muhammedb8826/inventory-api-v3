import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { User } from '../database/entities/user.entity';
import { UserLocation } from '../database/entities/user-location.entity';

/**
 * Location scoping:
 * - Permission `locations.all` (Admin) → all locations
 * - No rows in user_locations → all locations (backward compatible)
 * - Otherwise → only assigned location IDs
 */
@Injectable()
export class LocationAccessService {
  constructor(
    @InjectRepository(UserLocation)
    private readonly userLocationRepo: Repository<UserLocation>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) {}

  async getAllowedLocationIds(userId: string): Promise<string[] | null> {
    const user = await this.userRepo.findOne({
      where: { id: userId },
      relations: { role: { permissions: true } },
    });
    if (!user) return [];

    const codes = new Set((user.role?.permissions ?? []).map((p) => p.code));
    if (codes.has('locations.all')) return null;

    const rows = await this.userLocationRepo.find({ where: { userId } });
    if (rows.length === 0) return [];
    return rows.map((r) => r.locationId);
  }

  async assertCanAccessLocation(
    userId: string,
    locationId: string,
  ): Promise<void> {
    const allowed = await this.getAllowedLocationIds(userId);
    if (allowed === null) return;
    if (!allowed.includes(locationId)) {
      throw new ForbiddenException('You do not have access to this location');
    }
  }

  async filterLocationIds(
    userId: string,
    requested?: string | string[],
  ): Promise<string[] | undefined> {
    const allowed = await this.getAllowedLocationIds(userId);
    if (allowed === null) {
      if (!requested) return undefined;
      return Array.isArray(requested) ? requested : [requested];
    }
    if (!requested) return allowed;
    const req = Array.isArray(requested) ? requested : [requested];
    const filtered = req.filter((id) => allowed.includes(id));
    if (filtered.length === 0) {
      throw new ForbiddenException('You do not have access to this location');
    }
    return filtered;
  }

  async setUserLocations(userId: string, locationIds: string[]): Promise<void> {
    await this.userLocationRepo.delete({ userId });
    if (locationIds.length === 0) return;
    await this.userLocationRepo.save(
      locationIds.map((locationId) =>
        this.userLocationRepo.create({ userId, locationId }),
      ),
    );
  }

  async listUserLocationIds(userId: string): Promise<string[]> {
    const rows = await this.userLocationRepo.find({ where: { userId } });
    return rows.map((r) => r.locationId);
  }

  /** Helper for TypeORM In() when scoping lists. */
  allowedIn(allowed: string[] | null) {
    return allowed === null ? undefined : In(allowed);
  }
}
