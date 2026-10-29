import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { UnitOfMeasure } from '../database/entities/unit-of-measure.entity';
import { CreateUnitDto, UpdateUnitDto } from './dto/unit.dto';
@Injectable()
export class UnitsService {
  constructor(
    @InjectRepository(UnitOfMeasure)
    private readonly repo: Repository<UnitOfMeasure>,
    private readonly db: DataSource,
  ) {}
  async list() {
    return this.repo.find({ order: { requiresReview: 'DESC', name: 'ASC' } });
  }
  async resolve(id?: string | null, legacy?: string | null) {
    if (!id && !legacy?.trim())
      throw new BadRequestException(
        'Select a stock unit from the unit catalog',
      );
    let unit: UnitOfMeasure | null = null;
    if (id) unit = await this.repo.findOneBy({ id });
    else {
      const value = legacy!.trim().toLowerCase();
      unit = await this.repo
        .createQueryBuilder('u')
        .where('LOWER(u.code) = :value', { value })
        .getOne();
      if (!unit) {
        const matches = await this.repo
          .createQueryBuilder('u')
          .where(
            '(LOWER(u.symbol) = :value OR LOWER(u.name) = :value) AND u.is_active=true AND u.requires_review=false',
            { value },
          )
          .getMany();
        if (matches.length === 1) unit = matches[0];
      }
    }
    if (!unit || !unit.isActive || unit.requiresReview)
      throw new BadRequestException(
        'Select an active, reviewed stock unit from the catalog',
      );
    return unit;
  }
  async create(dto: CreateUnitDto) {
    if (!dto.name.trim() || !dto.symbol.trim())
      throw new BadRequestException('Unit name and symbol are required');
    try {
      return await this.repo.save(
        this.repo.create({
          ...dto,
          name: dto.name.trim(),
          symbol: dto.symbol.trim(),
          uneceCode: dto.uneceCode ?? null,
        }),
      );
    } catch (error) {
      if ((error as { code?: string }).code === '23505')
        throw new ConflictException('Unit code already exists');
      throw error;
    }
  }
  async update(id: string, dto: UpdateUnitDto) {
    for (const key of [
      'code',
      'name',
      'symbol',
      'category',
      'decimalPlaces',
      'isActive',
    ] as const) {
      if (dto[key] === null)
        throw new BadRequestException(`${key} cannot be null`);
    }
    return this.db.transaction(async (manager) => {
      const repo = manager.getRepository(UnitOfMeasure);
      const unit = await repo.findOne({
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!unit) throw new NotFoundException('Unit not found');
      const [{ used }] = await manager.query(
        'SELECT EXISTS(SELECT 1 FROM items WHERE unit_id = $1) AS used',
        [id],
      );
      if (
        used &&
        !unit.requiresReview &&
        (
          ['code', 'symbol', 'category', 'decimalPlaces', 'uneceCode'] as const
        ).some((key) => dto[key] !== undefined && dto[key] !== unit[key])
      ) {
        throw new BadRequestException(
          'Unit definition is in use and cannot change. Create a new unit instead.',
        );
      }
      if (unit.requiresReview && dto.confirmLegacyReview) {
        const decimals = dto.decimalPlaces ?? unit.decimalPlaces;
        const [{ invalid }] = await manager.query(
          `SELECT EXISTS(SELECT 1 FROM (
          SELECT s.quantity FROM stock_levels s JOIN items i ON i.id=s.item_id WHERE i.unit_id=$1
          UNION ALL SELECT s.reserved FROM stock_levels s JOIN items i ON i.id=s.item_id WHERE i.unit_id=$1
          UNION ALL SELECT s.reorder_point FROM stock_levels s JOIN items i ON i.id=s.item_id WHERE i.unit_id=$1
          UNION ALL SELECT s.quantity_delta FROM stock_movements s JOIN items i ON i.id=s.item_id WHERE i.unit_id=$1
          UNION ALL SELECT s.quantity FROM sale_lines s JOIN items i ON i.id=s.item_id WHERE i.unit_id=$1
          UNION ALL SELECT s.quantity FROM purchase_lines s JOIN items i ON i.id=s.item_id WHERE i.unit_id=$1
          UNION ALL SELECT s.quantity FROM stock_transfer_lines s JOIN items i ON i.id=s.item_id WHERE i.unit_id=$1
          UNION ALL SELECT s.quantity FROM bom_lines s JOIN items i ON i.id=s.component_item_id WHERE i.unit_id=$1
          UNION ALL SELECT s.quantity FROM customer_inquiry_lines s JOIN items i ON i.id=s.item_id WHERE i.unit_id=$1
          UNION ALL SELECT s.counted_qty FROM stocktake_lines s JOIN items i ON i.id=s.item_id WHERE i.unit_id=$1
          UNION ALL SELECT s.system_qty FROM stocktake_lines s JOIN items i ON i.id=s.item_id WHERE i.unit_id=$1
          UNION ALL SELECT s.quantity_planned FROM production_orders s JOIN items i ON i.id=s.finished_item_id WHERE i.unit_id=$1
          UNION ALL SELECT s.quantity_required FROM production_order_lines s JOIN items i ON i.id=s.component_item_id WHERE i.unit_id=$1
        ) quantities WHERE quantity<>round(quantity,$2::integer)) AS invalid`,
          [id, decimals],
        );
        if (invalid)
          throw new BadRequestException(
            'Existing quantities do not fit this precision. Review the unit without rounding or converting historical stock.',
          );
        unit.requiresReview = false;
      }
      if (
        unit.requiresReview &&
        !dto.confirmLegacyReview &&
        (
          ['code', 'symbol', 'category', 'decimalPlaces', 'uneceCode'] as const
        ).some((key) => dto[key] !== undefined && dto[key] !== unit[key])
      ) {
        throw new BadRequestException(
          'Confirm legacy unit review before changing its definition',
        );
      }
      const changes = { ...dto };
      delete changes.confirmLegacyReview;
      if (
        (changes.name !== undefined && !changes.name.trim()) ||
        (changes.symbol !== undefined && !changes.symbol.trim())
      )
        throw new BadRequestException('Unit name and symbol cannot be empty');
      Object.assign(unit, changes);
      try {
        const saved = await repo.save(unit);
        if (dto.confirmLegacyReview)
          await manager.query('UPDATE items SET unit=$1 WHERE unit_id=$2', [
            saved.symbol,
            id,
          ]);
        return saved;
      } catch (error) {
        if ((error as { code?: string }).code === '23505')
          throw new ConflictException('Unit code already exists');
        throw error;
      }
    });
  }
}
