import { UnitGroup } from '../database/entities/unit-group.entity';
import { SaveUnitGroupDto } from './dto/unit-group.dto';
import { assertUnitQuantity } from './unit-quantity';
import { Item } from '../database/entities/item.entity';
import { conversionOptions, itemConversionFactor } from './conversion';
import { UpdateItemConversionsDto } from './dto/item-conversion.dto';
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
import {
  assertConversion,
  groupIssues,
  standardFactor,
  STANDARD_UNITS,
  unitDefinitionIssue,
} from './unit-rules';
@Injectable()
export class UnitsService {
  constructor(
    @InjectRepository(UnitOfMeasure)
    private readonly repo: Repository<UnitOfMeasure>,
    private readonly db: DataSource,
  ) {}
  async groups() {
    const groups = await this.db
      .getRepository(UnitGroup)
      .find({ order: { name: 'ASC' } });
    const units = await this.list();
    return groups.map((g) => {
      const reviewIssues = groupIssues(g, units);
      return Object.assign(g, {
        requiresReview: !!reviewIssues.length,
        reviewIssues,
      });
    });
  }
  async group(id: string) {
    const group = await this.db.getRepository(UnitGroup).findOneBy({ id });
    if (!group || !group.isActive)
      throw new BadRequestException('Select an active unit group');
    const issues = groupIssues(group, await this.list());
    if (issues.length)
      throw new BadRequestException(
        `Review this unit configuration before assigning it: ${issues[0]}`,
      );
    return group;
  }
  async saveGroup(id: string | undefined, dto: SaveUnitGroupDto) {
    return this.db.transaction(async (manager) => {
      const repo = manager.getRepository(UnitGroup);
      if (id)
        await manager.query(
          'SELECT id FROM unit_groups WHERE id=$1 FOR UPDATE',
          [id],
        );
      const existing = id ? await repo.findOneBy({ id }) : null;
      if (id && !existing) throw new NotFoundException('Unit group not found');
      const units = await manager.getRepository(UnitOfMeasure).find();
      const base = units.find(
        (u) => u.id === dto.baseUnitId && u.isActive && !u.requiresReview,
      );
      if (!base)
        throw new BadRequestException('Select an active reviewed base unit');
      if (base.category !== dto.category)
        throw new BadRequestException(
          'The reference unit must belong to the selected measurement category',
        );
      const kind = dto.kind ?? existing?.kind ?? 'CATEGORY';
      const definition = unitDefinitionIssue(base);
      if (definition) throw new BadRequestException(definition);
      if (existing && existing.baseUnitId !== base.id) {
        const [{ used }] = await manager.query(
          'SELECT EXISTS(SELECT 1 FROM items WHERE unit_group_id=$1) AS used',
          [id],
        );
        if (used)
          throw new BadRequestException(
            'This group is assigned to items. Create a new group to change its base unit.',
          );
      }
      if (!dto.name.trim())
        throw new BadRequestException('Group name is required');
      const seen = new Set<string>();
      const conversions = dto.conversions.map((entry) => {
        if (entry.unitId === base.id || seen.has(entry.unitId))
          throw new BadRequestException(
            'Select each alternative unit once, excluding the base unit',
          );
        seen.add(entry.unitId);
        const unit = units.find(
          (u) => u.id === entry.unitId && u.isActive && !u.requiresReview,
        );
        if (!unit)
          throw new BadRequestException(
            'Select an active reviewed alternative unit',
          );
        if (entry.stockQuantity != null && entry.unitQuantity != null) {
          assertUnitQuantity(
            base,
            entry.stockQuantity,
            'Base reference quantity',
          );
          assertUnitQuantity(
            unit,
            entry.unitQuantity,
            'Alternative reference quantity',
          );
        }
        const factor = itemConversionFactor(entry);
        assertConversion(base, unit, factor, kind);
        return {
          unitId: entry.unitId,
          factor: standardFactor(unit, base) ?? factor,
          ...(entry.stockQuantity != null
            ? {
                stockQuantity: String(entry.stockQuantity),
                unitQuantity: String(entry.unitQuantity),
              }
            : {}),
          purchaseDefault: entry.purchaseDefault === true,
          salesDefault: entry.salesDefault === true,
        };
      });
      for (const key of ['purchaseDefault', 'salesDefault'] as const)
        if (conversions.filter((c) => c[key]).length > 1)
          throw new BadRequestException(
            'Choose one default per transaction type',
          );
      const issues = groupIssues(
        { category: dto.category, baseUnitId: base.id, kind, conversions },
        units,
      );
      if (issues.length) throw new BadRequestException(issues[0]);
      try {
        return await repo.save(
          repo.create({
            ...(existing ?? {}),
            name: dto.name.trim(),
            category: dto.category,
            kind,
            baseUnitId: base.id,
            baseUnit: base,
            conversions,
            isActive: dto.isActive ?? existing?.isActive ?? true,
          }),
        );
      } catch (e) {
        if ((e as { code?: string }).code === '23505')
          throw new ConflictException('Unit group name already exists');
        throw e;
      }
    });
  }
  async list() {
    return this.repo.find({ order: { requiresReview: 'DESC', name: 'ASC' } });
  }
  async itemOptions(id: string) {
    const item = await this.db.getRepository(Item).findOneBy({ id });
    if (!item) throw new NotFoundException('Item not found');
    const [{ inUse }] = await this.db.query(
      'SELECT item_stock_unit_in_use($1) AS "inUse"',
      [id],
    );
    const configured = (item.unitConversions?.length ?? 0) > 0;
    const units = await this.list();
    const reviewIssues = groupIssues(
      item.unitGroup ?? {
        baseUnitId: item.unitId,
        category: item.stockUnit.category,
        conversions: item.unitConversions ?? [],
      },
      units,
    );
    return {
      requiresReview: !!reviewIssues.length,
      reviewIssues,
      canChangeBaseUnit: !inUse && !configured,
      baseUnitLockReason: inUse
        ? 'Stock unit is protected by stock, movements or related documents. Use an alternative conversion for future transactions.'
        : configured
          ? 'Remove alternative unit settings before correcting this unused item.'
          : null,
      unitGroup: item.unitGroup ?? null,
      baseUnit: item.stockUnit,
      options: conversionOptions(item, units),
      conversions: item.unitConversions ?? [],
    };
  }
  async configureItem(id: string, dto: UpdateItemConversionsDto) {
    await this.db.transaction(async (manager) => {
      await manager.query('SELECT id FROM items WHERE id=$1 FOR UPDATE', [id]);
      const item = await manager.getRepository(Item).findOneBy({ id });
      if (!item) throw new NotFoundException('Item not found');
      if (item.unitGroupId)
        throw new BadRequestException(
          'Edit the shared unit group to change conversions for this item',
        );
      if (item.stockUnit.requiresReview)
        throw new BadRequestException(
          'Review the base unit before configuring conversions',
        );
      const units = await manager.getRepository(UnitOfMeasure).find();
      const seen = new Set<string>();
      const factors = new Map<string, string>();
      for (const entry of dto.conversions) {
        if (seen.has(entry.unitId))
          throw new BadRequestException('Duplicate conversion unit');
        seen.add(entry.unitId);
        const unit = units.find(
          (u) => u.id === entry.unitId && u.isActive && !u.requiresReview,
        );
        if (!unit)
          throw new BadRequestException('Select an active reviewed unit');
        const factor = itemConversionFactor(entry);
        if (unit.id === item.unitId && factor !== '1')
          throw new BadRequestException(
            'The base unit must always convert to itself at 1:1',
          );
        assertConversion(item.stockUnit, unit, factor);
        factors.set(
          entry.unitId,
          standardFactor(unit, item.stockUnit) ?? factor,
        );
        if (entry.stockQuantity != null && entry.unitQuantity != null) {
          assertUnitQuantity(
            item.stockUnit,
            entry.stockQuantity,
            'Stock reference quantity',
          );
          assertUnitQuantity(
            unit,
            entry.unitQuantity,
            'Alternative reference quantity',
          );
        }
        if (unit.id === item.unitId && factor !== '1')
          throw new BadRequestException(
            'The base unit must always convert to itself at 1:1',
          );
      }
      for (const key of ['purchaseDefault', 'salesDefault'] as const)
        if (dto.conversions.filter((c) => c[key]).length > 1)
          throw new BadRequestException(
            'Choose only one default unit for each transaction type',
          );
      item.unitConversions = dto.conversions.map((c) => ({
        unitId: c.unitId,
        factor: factors.get(c.unitId)!,
        ...(c.stockQuantity != null && c.unitQuantity != null
          ? {
              stockQuantity: String(c.stockQuantity),
              unitQuantity: String(c.unitQuantity),
            }
          : {}),
        purchaseDefault: c.purchaseDefault === true,
        salesDefault: c.salesDefault === true,
      }));
      const issues = groupIssues(
        {
          baseUnitId: item.unitId,
          category: item.stockUnit.category,
          conversions: item.unitConversions,
        },
        units,
      );
      if (issues.length) throw new BadRequestException(issues[0]);
      await manager.getRepository(Item).save(item);
    });
    return this.itemOptions(id);
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
    if (unit) {
      const issue = unitDefinitionIssue(unit);
      if (issue) throw new BadRequestException(issue);
    }
    if (!unit || !unit.isActive || unit.requiresReview)
      throw new BadRequestException(
        'Select an active, reviewed stock unit from the catalog',
      );
    return unit;
  }
  async create(dto: CreateUnitDto) {
    const definition = unitDefinitionIssue(dto);
    if (definition) throw new BadRequestException(definition);
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
      if (
        STANDARD_UNITS[unit.code] &&
        dto.code !== undefined &&
        dto.code !== unit.code
      )
        throw new BadRequestException(
          'Standard unit codes cannot be renamed. Create a distinct custom unit.',
        );
      const definition = unitDefinitionIssue({ ...unit, ...dto });
      if (definition) throw new BadRequestException(definition);
      const [{ used }] = await manager.query(
        `SELECT EXISTS(SELECT 1 FROM items WHERE unit_id = $1 OR unit_conversions @> jsonb_build_array(jsonb_build_object('unitId',$1::text))) OR EXISTS(SELECT 1 FROM unit_groups WHERE base_unit_id=$1 OR conversions @> jsonb_build_array(jsonb_build_object('unitId',$1::text))) AS used`,
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
