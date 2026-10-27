import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import {
  StockAdjustmentReason,
  StockAdjustmentDirection,
  StockMovementType,
  StocktakeStatus,
} from '../common/enums';
import { StockLevel } from '../database/entities/stock-level.entity';
import { StockAdjustment } from '../database/entities/stock-adjustment.entity';
import { Stocktake } from '../database/entities/stocktake.entity';
import { StocktakeLine } from '../database/entities/stocktake-line.entity';
import { StockService } from '../inventory/stock.service';
import { LocationAccessService } from '../locations/location-access.service';
import {
  CreateStocktakeDto,
  SubmitStocktakeCountsDto,
} from './dto/stocktake.dto';

@Injectable()
export class StocktakesService {
  constructor(
    @InjectRepository(Stocktake)
    private readonly stocktakeRepo: Repository<Stocktake>,
    @InjectRepository(StockLevel)
    private readonly stockRepo: Repository<StockLevel>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly stockService: StockService,
    private readonly locationAccess: LocationAccessService,
  ) {}

  async findAll(userId: string) {
    const allowed = await this.locationAccess.getAllowedLocationIds(userId);
    const qb = this.stocktakeRepo
      .createQueryBuilder('s')
      .leftJoinAndSelect('s.location', 'location')
      .leftJoinAndSelect('s.createdBy', 'createdBy')
      .orderBy('s.createdAt', 'DESC');
    if (allowed) {
      qb.andWhere('s.location_id IN (:...allowed)', { allowed });
    }
    return qb.getMany();
  }

  async findOne(id: string, userId: string) {
    const row = await this.stocktakeRepo.findOne({
      where: { id },
      relations: {
        location: true,
        createdBy: true,
        lines: { item: true },
      },
    });
    if (!row) throw new NotFoundException('Stocktake not found');
    await this.locationAccess.assertCanAccessLocation(userId, row.locationId);
    return row;
  }

  async create(dto: CreateStocktakeDto, userId: string) {
    await this.locationAccess.assertCanAccessLocation(userId, dto.locationId);

    const id = await this.dataSource.transaction(async (manager) => {
      const stocktakeRepo = manager.getRepository(Stocktake);
      const lineRepo = manager.getRepository(StocktakeLine);
      const stockRepo = manager.getRepository(StockLevel);

      const session = await stocktakeRepo.save(
        stocktakeRepo.create({
          locationId: dto.locationId,
          status: StocktakeStatus.IN_PROGRESS,
          notes: dto.notes ?? null,
          createdById: userId,
        }),
      );

      const levels = await stockRepo.find({
        where: { locationId: dto.locationId },
      });
      if (levels.length > 0) {
        await lineRepo.save(
          levels.map((level) =>
            lineRepo.create({
              stocktakeId: session.id,
              itemId: level.itemId,
              systemQty: level.quantity,
              countedQty: null,
            }),
          ),
        );
      }

      return session.id;
    });

    return this.findOne(id, userId);
  }

  async submitCounts(
    id: string,
    dto: SubmitStocktakeCountsDto,
    userId: string,
  ) {
    const session = await this.findOne(id, userId);
    if (
      session.status !== StocktakeStatus.IN_PROGRESS &&
      session.status !== StocktakeStatus.DRAFT
    ) {
      throw new BadRequestException('Stocktake is not open for counting');
    }

    const byItem = new Map(dto.lines.map((l) => [l.itemId, l.countedQty]));
    for (const line of session.lines ?? []) {
      if (byItem.has(line.itemId)) {
        line.countedQty = byItem.get(line.itemId)!.toFixed(3);
      }
    }
    await this.stocktakeRepo.manager.getRepository(StocktakeLine).save(
      session.lines ?? [],
    );

    session.status = StocktakeStatus.IN_PROGRESS;
    await this.stocktakeRepo.save(session);
    return this.findOne(id, userId);
  }

  /** Apply variances as stock adjustments and close the session. */
  async complete(id: string, userId: string) {
    const session = await this.findOne(id, userId);
    if (session.status === StocktakeStatus.COMPLETED) {
      throw new BadRequestException('Stocktake already completed');
    }
    if (session.status === StocktakeStatus.CANCELLED) {
      throw new BadRequestException('Stocktake is cancelled');
    }

    const missing = (session.lines ?? []).filter((l) => l.countedQty == null);
    if (missing.length > 0) {
      throw new BadRequestException(
        `Counted qty missing for ${missing.length} item(s)`,
      );
    }

    await this.dataSource.transaction(async (manager) => {
      const adjRepo = manager.getRepository(StockAdjustment);
      for (const line of session.lines ?? []) {
        const system = parseFloat(line.systemQty);
        const counted = parseFloat(line.countedQty!);
        const delta = counted - system;
        if (Math.abs(delta) < 0.0005) continue;

        await this.stockService.adjust(
          {
            locationId: session.locationId,
            itemId: line.itemId,
            quantityDelta: delta,
            movement: {
              type: StockMovementType.STOCKTAKE,
              refType: 'stocktake',
              refId: session.id,
              createdById: userId,
              notes: `Stocktake variance (system ${system} → counted ${counted})`,
            },
          },
          manager,
        );

        await adjRepo.save(
          adjRepo.create({
            locationId: session.locationId,
            itemId: line.itemId,
            direction:
              delta > 0
                ? StockAdjustmentDirection.IN
                : StockAdjustmentDirection.OUT,
            quantity: Math.abs(delta).toFixed(3),
            quantityBefore: system.toFixed(3),
            quantityAfter: counted.toFixed(3),
            reason: StockAdjustmentReason.COUNT,
            notes: `Stocktake ${session.id.slice(0, 8)}`,
            createdById: userId,
          }),
        );
      }

      session.status = StocktakeStatus.COMPLETED;
      session.completedAt = new Date();
      await manager.getRepository(Stocktake).save(session);
    });

    return this.findOne(id, userId);
  }

  async cancel(id: string, userId: string) {
    const session = await this.findOne(id, userId);
    if (session.status === StocktakeStatus.COMPLETED) {
      throw new BadRequestException('Cannot cancel a completed stocktake');
    }
    session.status = StocktakeStatus.CANCELLED;
    await this.stocktakeRepo.save(session);
    return session;
  }
}
