import { assertUnitQuantity } from '../units/unit-quantity';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ItemType } from '../common/enums';
import {
  applyIlikeSearch,
  paginatedQueryBuilder,
} from '../common/utils/query.util';
import { BomLine } from '../database/entities/bom-line.entity';
import { Bom } from '../database/entities/bom.entity';
import { Item } from '../database/entities/item.entity';
import { StockLevel } from '../database/entities/stock-level.entity';
import {
  BomExplodeQueryDto,
  BomLineDto,
  BomListQueryDto,
  CreateBomDto,
  ReviseBomDto,
  UpdateBomDto,
} from './dto/bom.dto';

const FG_TYPES = new Set<ItemType>([ItemType.FINISHED, ItemType.SEMI]);
const COMPONENT_TYPES = new Set<ItemType>([
  ItemType.RAW,
  ItemType.SEMI,
  ItemType.OTHER,
]);

export interface ExplodedBomLine {
  componentItemId: string;
  quantity: number;
  scrapPercent: number;
  depth: number;
  path: string[];
  componentItem?: Item;
  fromBomId?: string;
}

@Injectable()
export class BomsService {
  constructor(
    @InjectRepository(Bom)
    private readonly bomRepo: Repository<Bom>,
    @InjectRepository(Item)
    private readonly itemRepo: Repository<Item>,
    @InjectRepository(StockLevel)
    private readonly stockRepo: Repository<StockLevel>,
  ) {}

  findAll(query: BomListQueryDto) {
    const qb = this.bomRepo
      .createQueryBuilder('bom')
      .leftJoinAndSelect('bom.finishedItem', 'finishedItem')
      .leftJoinAndSelect('bom.lines', 'lines')
      .leftJoinAndSelect('lines.componentItem', 'componentItem')
      .orderBy('bom.updated_at', 'DESC');

    if (query.finishedItemId) {
      qb.andWhere('bom.finished_item_id = :finishedItemId', {
        finishedItemId: query.finishedItemId,
      });
    }
    if (query.isActive === 'true') {
      qb.andWhere('bom.is_active = true');
    } else if (query.isActive === 'false') {
      qb.andWhere('bom.is_active = false');
    }
    if (query.isDefault === 'true') {
      qb.andWhere('bom.is_default = true');
    } else if (query.isDefault === 'false') {
      qb.andWhere('bom.is_default = false');
    }
    applyIlikeSearch(qb, query.search, [
      'bom.name',
      'bom.version',
      'finishedItem.description',
      'finishedItem.sku',
    ]);

    return paginatedQueryBuilder(qb, query.page, query.limit);
  }

  async findOne(id: string) {
    const bom = await this.bomRepo.findOne({
      where: { id },
      relations: {
        finishedItem: true,
        lines: { componentItem: true },
        revisedFrom: true,
      },
    });
    if (!bom) throw new NotFoundException('BOM not found');
    return bom;
  }

  async create(dto: CreateBomDto) {
    await this.assertFinishedItem(dto.finishedItemId);
    await this.assertLines(dto.finishedItemId, dto.lines);
    this.assertEffectivity(dto.effectiveFrom, dto.effectiveTo);

    if (dto.isDefault) {
      await this.clearDefault(dto.finishedItemId);
    }

    const bom = await this.bomRepo.save(
      this.bomRepo.create({
        finishedItemId: dto.finishedItemId,
        name: dto.name.trim(),
        version: dto.version?.trim() || '1.0',
        notes: dto.notes?.trim() || null,
        isActive: true,
        isDefault: dto.isDefault === true,
        yieldPercent: (dto.yieldPercent ?? 100).toFixed(2),
        effectiveFrom: dto.effectiveFrom ?? null,
        effectiveTo: dto.effectiveTo ?? null,
        lines: await this.buildLineEntities(dto.lines),
      }),
    );
    return this.findOne(bom.id);
  }

  async update(id: string, dto: UpdateBomDto) {
    const bom = await this.findOne(id);

    if (dto.finishedItemId !== undefined) {
      await this.assertFinishedItem(dto.finishedItemId);
      bom.finishedItemId = dto.finishedItemId;
    }

    if (dto.name !== undefined) bom.name = dto.name.trim();
    if (dto.version !== undefined) bom.version = dto.version?.trim() || null;
    if (dto.notes !== undefined) bom.notes = dto.notes?.trim() || null;
    if (dto.isActive !== undefined) bom.isActive = dto.isActive;
    if (dto.yieldPercent !== undefined) {
      bom.yieldPercent = dto.yieldPercent.toFixed(2);
    }
    if (dto.effectiveFrom !== undefined) {
      bom.effectiveFrom = dto.effectiveFrom;
    }
    if (dto.effectiveTo !== undefined) {
      bom.effectiveTo = dto.effectiveTo;
    }
    this.assertEffectivity(bom.effectiveFrom, bom.effectiveTo);

    if (dto.isDefault === true) {
      await this.clearDefault(bom.finishedItemId, id);
      bom.isDefault = true;
    } else if (dto.isDefault === false) {
      bom.isDefault = false;
    }

    const { lines: _lines, revisedFrom: _rf, ...header } = bom;
    await this.bomRepo.save(header);

    if (dto.lines) {
      await this.assertLines(bom.finishedItemId, dto.lines);
      const lineRepo = this.bomRepo.manager.getRepository(BomLine);
      await lineRepo.delete({ bomId: id });
      const built = await this.buildLineEntities(dto.lines);
      await lineRepo.save(
        built.map((line) =>
          lineRepo.create({
            bomId: id,
            componentItemId: line.componentItemId,
            quantity: line.quantity,
            scrapPercent: line.scrapPercent,
            isPhantom: line.isPhantom,
          }),
        ),
      );
    }

    return this.findOne(id);
  }

  /**
   * Create an immutable revision: new BOM row, optionally deactivate prior,
   * copy or replace lines. Use when engineering change must preserve history.
   */
  async revise(id: string, dto: ReviseBomDto) {
    const source = await this.findOne(id);
    const lines: BomLineDto[] =
      dto.lines ??
      (source.lines ?? []).map((l) => ({
        componentItemId: l.componentItemId,
        quantity: parseFloat(l.quantity),
        scrapPercent: parseFloat(l.scrapPercent) || 0,
        isPhantom: l.isPhantom === true,
      }));

    await this.assertFinishedItem(source.finishedItemId);
    await this.assertLines(source.finishedItemId, lines);

    const nextVersion = dto.version?.trim() || this.bumpVersion(source.version);

    const makeDefault = dto.isDefault !== false && source.isDefault;
    if (makeDefault) {
      await this.clearDefault(source.finishedItemId);
    }

    source.isActive = false;
    source.isDefault = false;
    await this.bomRepo.save(source);

    const created = await this.bomRepo.save(
      this.bomRepo.create({
        finishedItemId: source.finishedItemId,
        name: dto.name?.trim() || source.name,
        version: nextVersion,
        notes:
          dto.notes !== undefined ? dto.notes?.trim() || null : source.notes,
        isActive: true,
        isDefault: makeDefault,
        yieldPercent: (
          dto.yieldPercent ??
          (parseFloat(source.yieldPercent) || 100)
        ).toFixed(2),
        effectiveFrom: dto.effectiveFrom ?? source.effectiveFrom,
        effectiveTo: dto.effectiveTo ?? source.effectiveTo,
        revisedFromId: source.id,
        lines: await this.buildLineEntities(lines),
      }),
    );

    return this.findOne(created.id);
  }

  async remove(id: string) {
    const bom = await this.findOne(id);
    bom.isActive = false;
    bom.isDefault = false;
    await this.bomRepo.save(bom);
    return { success: true };
  }

  async setDefault(id: string) {
    const bom = await this.findOne(id);
    if (!bom.isActive) {
      throw new BadRequestException('Cannot set an inactive BOM as default');
    }
    await this.clearDefault(bom.finishedItemId, id);
    bom.isDefault = true;
    await this.bomRepo.save(bom);
    return this.findOne(id);
  }

  /** Multi-level explode to leaf components (uses default BOMs for SEMI). */
  async explode(id: string, query: BomExplodeQueryDto = {}) {
    const quantity = query.quantity ?? 1;
    const maxDepth = query.maxDepth ?? 10;
    const bom = await this.findOne(id);
    const leaves = await this.explodeBom(bom, quantity, maxDepth, 0, [
      bom.finishedItemId,
    ]);
    const aggregated = this.aggregateLeaves(leaves);
    return {
      bomId: bom.id,
      finishedItemId: bom.finishedItemId,
      quantity,
      yieldPercent: parseFloat(bom.yieldPercent) || 100,
      lines: aggregated,
    };
  }

  /** Where-used: BOMs that directly reference this item as a component. */
  async whereUsed(itemId: string) {
    const item = await this.itemRepo.findOne({ where: { id: itemId } });
    if (!item) throw new NotFoundException('Item not found');

    const lines = await this.bomRepo.manager.getRepository(BomLine).find({
      where: { componentItemId: itemId },
      relations: {
        bom: { finishedItem: true },
        componentItem: true,
      },
    });

    return lines.map((line) => ({
      bomId: line.bomId,
      bomName: line.bom?.name,
      version: line.bom?.version,
      isActive: line.bom?.isActive,
      isDefault: line.bom?.isDefault,
      finishedItemId: line.bom?.finishedItemId,
      finishedItem: line.bom?.finishedItem,
      quantity: line.quantity,
      scrapPercent: line.scrapPercent,
    }));
  }

  /**
   * Cost rollup: stocked (non-phantom) SEMIs use their avg stock cost;
   * phantoms explode to children (industry assembly costing).
   * Pass `fullExplode=true` for leaf-RAW-only rollup.
   */
  async costRollup(id: string, quantity = 1, fullExplode = false) {
    const bom = await this.findOne(id);
    const leaves = await this.explodeBom(
      bom,
      quantity,
      10,
      0,
      [bom.finishedItemId],
      fullExplode ? 'always' : 'phantoms',
    );
    const aggregated = this.aggregateLeaves(leaves);
    let materialCost = 0;
    const lines: {
      componentItemId: string;
      quantity: number;
      unitCost: number;
      extendedCost: number;
      componentItem?: Item;
    }[] = [];

    for (const line of aggregated) {
      const unitCost = await this.avgUnitCost(line.componentItemId);
      const extended = unitCost * line.quantity;
      materialCost += extended;
      lines.push({
        componentItemId: line.componentItemId,
        quantity: line.quantity,
        unitCost,
        extendedCost: extended,
        componentItem: line.componentItem,
      });
    }

    const yieldPct = parseFloat(bom.yieldPercent) || 100;
    const expectedFg = quantity * (yieldPct / 100);
    const unitFgCost =
      expectedFg > 0 ? materialCost / expectedFg : materialCost;

    return {
      bomId: id,
      quantity,
      yieldPercent: yieldPct,
      mode: fullExplode ? 'leaves' : 'phantoms',
      expectedFinishedQty: expectedFg,
      materialCost: Number(materialCost.toFixed(2)),
      unitFinishedCost: Number(unitFgCost.toFixed(2)),
      lines: lines.map((l) => ({
        ...l,
        unitCost: Number(l.unitCost.toFixed(2)),
        extendedCost: Number(l.extendedCost.toFixed(2)),
      })),
    };
  }

  /**
   * Production material list.
   * Default (`forceExplodeAll=false`): explode phantom components only;
   * stocked SEMIs stay as issue lines.
   * `forceExplodeAll=true`: flatten all SEMI/FINISHED to leaves.
   */
  async explodeForProduction(
    bomId: string,
    quantityPlanned: number,
    forceExplodeAll = false,
  ): Promise<{ componentItemId: string; quantityRequired: number }[]> {
    const bom = await this.findOne(bomId);
    const yieldPct = parseFloat(bom.yieldPercent) || 100;
    const materialMultiplier = yieldPct > 0 ? 100 / yieldPct : 1;
    const leaves = await this.explodeBom(
      bom,
      quantityPlanned * materialMultiplier,
      10,
      0,
      [bom.finishedItemId],
      forceExplodeAll ? 'always' : 'phantoms',
    );
    return this.aggregateLeaves(leaves).map((l) => ({
      componentItemId: l.componentItemId,
      quantityRequired: l.quantity,
    }));
  }

  async findDefaultBom(finishedItemId: string, asOf?: string) {
    const qb = this.bomRepo
      .createQueryBuilder('bom')
      .leftJoinAndSelect('bom.lines', 'lines')
      .leftJoinAndSelect('lines.componentItem', 'componentItem')
      .where('bom.finished_item_id = :finishedItemId', { finishedItemId })
      .andWhere('bom.is_active = true')
      .andWhere('bom.is_default = true');

    if (asOf) {
      qb.andWhere(
        '(bom.effective_from IS NULL OR bom.effective_from <= :asOf)',
        { asOf },
      ).andWhere('(bom.effective_to IS NULL OR bom.effective_to >= :asOf)', {
        asOf,
      });
    }

    let bom = await qb.getOne();
    // Fallback: any active BOM for the item if none marked default
    if (!bom) {
      bom = await this.bomRepo.findOne({
        where: { finishedItemId, isActive: true },
        relations: { lines: { componentItem: true } },
        order: { isDefault: 'DESC', updatedAt: 'DESC' },
      });
    }
    return bom;
  }

  /**
   * @param mode `always` = classic MRP explode through every SEMI/FINISHED BOM.
   * `phantoms` = only pass through phantom lines/items (stocked assemblies stay).
   */
  private async explodeBom(
    bom: Bom,
    quantity: number,
    maxDepth: number,
    depth: number,
    path: string[],
    mode: 'always' | 'phantoms' = 'always',
  ): Promise<ExplodedBomLine[]> {
    if (depth >= maxDepth) {
      throw new BadRequestException(
        `BOM explode exceeded max depth ${maxDepth} (possible cycle)`,
      );
    }

    const lines =
      bom.lines ??
      (
        await this.bomRepo.findOne({
          where: { id: bom.id },
          relations: { lines: { componentItem: true } },
        })
      )?.lines ??
      [];

    const result: ExplodedBomLine[] = [];

    for (const line of lines) {
      const scrap = parseFloat(line.scrapPercent) || 0;
      const qty = parseFloat(line.quantity) * (1 + scrap / 100) * quantity;
      const component =
        line.componentItem ??
        (await this.itemRepo.findOne({
          where: { id: line.componentItemId },
        }));

      if (!component) continue;

      if (path.includes(line.componentItemId)) {
        throw new BadRequestException(
          `Circular BOM detected at ${component.description}`,
        );
      }

      const isPhantom = line.isPhantom === true || component.isPhantom === true;
      const canHaveChildBom =
        component.itemType === ItemType.SEMI ||
        component.itemType === ItemType.FINISHED;
      const shouldExplode = canHaveChildBom && (mode === 'always' || isPhantom);

      if (shouldExplode) {
        const childBom = await this.findDefaultBom(line.componentItemId);
        if (childBom && childBom.lines?.length) {
          const nested = await this.explodeBom(
            childBom,
            qty,
            maxDepth,
            depth + 1,
            [...path, line.componentItemId],
            mode,
          );
          result.push(...nested);
          continue;
        }
        if (isPhantom && mode === 'phantoms') {
          throw new BadRequestException(
            `Phantom component "${component.description}" has no active default BOM to explode`,
          );
        }
      }

      result.push({
        componentItemId: line.componentItemId,
        quantity: qty,
        scrapPercent: scrap,
        depth,
        path: [...path, line.componentItemId],
        componentItem: component,
        fromBomId: bom.id,
      });
    }

    return result;
  }

  /** Resolve line phantoms: explicit DTO flag, else inherit item.isPhantom. */
  private async buildLineEntities(lines: BomLineDto[]): Promise<BomLine[]> {
    const out: BomLine[] = [];
    for (const line of lines) {
      let isPhantom = line.isPhantom;
      if (isPhantom === undefined) {
        const item = await this.itemRepo.findOne({
          where: { id: line.componentItemId },
        });
        isPhantom = item?.isPhantom === true;
      }
      out.push(
        Object.assign(new BomLine(), {
          componentItemId: line.componentItemId,
          quantity: line.quantity.toFixed(3),
          scrapPercent: (line.scrapPercent ?? 0).toFixed(2),
          isPhantom: isPhantom === true,
        }),
      );
    }
    return out;
  }

  private aggregateLeaves(leaves: ExplodedBomLine[]): ExplodedBomLine[] {
    const map = new Map<string, ExplodedBomLine>();
    for (const leaf of leaves) {
      const existing = map.get(leaf.componentItemId);
      if (existing) {
        existing.quantity += leaf.quantity;
      } else {
        map.set(leaf.componentItemId, { ...leaf });
      }
    }
    return [...map.values()].map((l) => ({
      ...l,
      quantity: Number(l.quantity.toFixed(6)),
    }));
  }

  private async avgUnitCost(itemId: string): Promise<number> {
    const rows = await this.stockRepo.find({ where: { itemId } });
    if (!rows.length) return 0;
    let qty = 0;
    let value = 0;
    for (const row of rows) {
      const q = parseFloat(row.quantity);
      if (q <= 0) continue;
      qty += q;
      value += q * parseFloat(row.purchasePrice);
    }
    return qty > 0 ? value / qty : parseFloat(rows[0].purchasePrice) || 0;
  }

  private async clearDefault(finishedItemId: string, exceptId?: string) {
    const qb = this.bomRepo
      .createQueryBuilder()
      .update(Bom)
      .set({ isDefault: false })
      .where('finished_item_id = :finishedItemId', { finishedItemId })
      .andWhere('is_default = true');
    if (exceptId) {
      qb.andWhere('id != :exceptId', { exceptId });
    }
    await qb.execute();
  }

  private assertEffectivity(from?: string | null, to?: string | null) {
    if (from && to && from > to) {
      throw new BadRequestException(
        'effectiveFrom must be on or before effectiveTo',
      );
    }
  }

  private bumpVersion(current: string | null): string {
    if (!current?.trim()) return '1.1';
    const m = current.trim().match(/^(\d+)(?:\.(\d+))?$/);
    if (!m) return `${current}-r`;
    const major = parseInt(m[1], 10);
    const minor = parseInt(m[2] ?? '0', 10) + 1;
    return `${major}.${minor}`;
  }

  private async assertFinishedItem(finishedItemId: string) {
    const item = await this.itemRepo.findOne({ where: { id: finishedItemId } });
    if (!item) throw new BadRequestException('Finished item not found');
    if (!item.isActive) {
      throw new BadRequestException('Finished item is inactive');
    }
    if (!FG_TYPES.has(item.itemType)) {
      throw new BadRequestException(
        `BOM parent must be FINISHED or SEMI (got ${item.itemType})`,
      );
    }
  }

  private async assertLines(finishedItemId: string, lines: BomLineDto[]) {
    const seen = new Set<string>();
    for (const line of lines) {
      if (line.componentItemId === finishedItemId) {
        throw new BadRequestException(
          'BOM cannot include the finished item as a component',
        );
      }
      if (seen.has(line.componentItemId)) {
        throw new BadRequestException('Duplicate component in BOM lines');
      }
      seen.add(line.componentItemId);

      const component = await this.itemRepo.findOne({
        where: { id: line.componentItemId },
      });
      if (!component) {
        throw new BadRequestException(
          `Component item not found: ${line.componentItemId}`,
        );
      }
      assertUnitQuantity(
        component.stockUnit,
        line.quantity,
        'BOM component quantity',
      );
      if (!component.isActive) {
        throw new BadRequestException(
          `Component item is inactive: ${component.description}`,
        );
      }
      if (!COMPONENT_TYPES.has(component.itemType)) {
        throw new BadRequestException(
          `Component "${component.description}" must be RAW, SEMI, or OTHER (got ${component.itemType})`,
        );
      }
    }
  }
}
