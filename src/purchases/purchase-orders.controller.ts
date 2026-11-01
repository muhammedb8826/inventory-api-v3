import { Supplier } from '../database/entities/supplier.entity';
import { Location } from '../database/entities/location.entity';
import { assertOrderItemsActive } from '../sales/pricing';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import Decimal from 'decimal.js';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import {
  CurrentUser,
  type JwtPayload,
} from '../common/decorators/current-user.decorator';
import { ListQueryDto } from '../common/dto/list-query.dto';
import { paginatedQueryBuilder } from '../common/utils/query.util';
import { applyLocationScope } from '../common/location-scope';
import { PurchaseOrder } from '../database/entities/purchase-order.entity';
import { User } from '../database/entities/user.entity';
import { Item } from '../database/entities/item.entity';
import { normalizeLine, commercialTotal } from '../units/conversion';
import { CreatePurchaseDto } from './dto/purchase.dto';
import { PurchasesService } from './purchases.service';
@Controller('purchase-orders')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class PurchaseOrdersController {
  constructor(
    private readonly db: DataSource,
    private readonly purchases: PurchasesService,
  ) {}
  @Get() @RequirePermissions('purchase.read') list(
    @Query() query: ListQueryDto,
  ) {
    const qb = applyLocationScope(
      this.db.getRepository(PurchaseOrder).createQueryBuilder('o'),
    ).orderBy('o.created_at', 'DESC');
    if (query.search?.trim())
      qb.andWhere('(o.id::text ILIKE :q OR o.payload::text ILIKE :q)', {
        q: `%${query.search.trim().slice(0, 100)}%`,
      });
    return paginatedQueryBuilder(qb, query.page, query.limit);
  }
  @Get(':id') @RequirePermissions('purchase.read') async detail(
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const o = await applyLocationScope(
      this.db.getRepository(PurchaseOrder).createQueryBuilder('o'),
    )
      .andWhere('o.id=:id', { id })
      .getOne();
    if (!o) throw new NotFoundException('Purchase order not found');
    const users = await this.db
      .getRepository(User)
      .createQueryBuilder('u')
      .select(['u.id', 'u.fullName'])
      .where('u.id IN (:...ids)', {
        ids: [...new Set(o.history.map((h) => h.actorId))],
      })
      .getMany();
    const items = await this.db
      .getRepository(Item)
      .createQueryBuilder('i')
      .select(['i.id', 'i.description', 'i.sku'])
      .where('i.id IN (:...ids)', {
        ids: [...new Set(o.normalizedLines.map((l) => l.itemId))],
      })
      .getMany();
    const [supplier, location] = await Promise.all([
      this.db.getRepository(Supplier).findOne({
        where: { id: o.payload.supplierId },
        select: { id: true, name: true },
      }),
      this.db.getRepository(Location).findOne({
        where: { id: o.locationId },
        select: { id: true, name: true },
      }),
    ]);
    return {
      ...o,
      items,
      supplier,
      location,
      history: o.history.map((h) => ({
        ...h,
        actorName:
          users.find((u) => u.id === h.actorId)?.fullName ?? 'Former user',
      })),
    };
  }
  private event(o: PurchaseOrder, action: string, actorId: string) {
    o.history = [
      ...o.history,
      { action, actorId, at: new Date().toISOString() },
    ];
  }
  private async normalize(m: EntityManager, dto: CreatePurchaseDto) {
    const lines = await Promise.all(
      dto.lines.map((l) => normalizeLine(m, l.itemId, l)),
    );
    return {
      lines,
      total: lines
        .reduce((s, l) => s.plus(commercialTotal(l)), new Decimal(0))
        .toFixed(2),
    };
  }
  @Post() @RequirePermissions('purchase.write') create(
    @Body() dto: CreatePurchaseDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.db.transaction(async (m) => {
      const v = await this.normalize(m, dto),
        repo = m.getRepository(PurchaseOrder),
        o = repo.create({
          locationId: dto.locationId,
          payload: dto,
          normalizedLines: v.lines,
          total: v.total,
          state: 'DRAFT',
          createdById: actor.sub,
          history: [],
        });
      this.event(o, 'Purchase request drafted', actor.sub);
      return repo.save(o);
    });
  }
  private async change(
    id: string,
    fn: (m: EntityManager, o: PurchaseOrder) => Promise<void>,
  ) {
    await this.db.transaction(async (m) => {
      await m.query('SELECT id FROM purchase_orders WHERE id=$1 FOR UPDATE', [
        id,
      ]);
      const o = await applyLocationScope(
        m.getRepository(PurchaseOrder).createQueryBuilder('o'),
      )
        .andWhere('o.id=:id', { id })
        .getOne();
      if (!o) throw new NotFoundException('Purchase order not found');
      await fn(m, o);
      await m.getRepository(PurchaseOrder).save(o);
    });
    return this.detail(id);
  }
  @Patch(':id') @RequirePermissions('purchase.write') edit(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreatePurchaseDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.change(id, async (m, o) => {
      if (o.state !== 'DRAFT')
        throw new BadRequestException(
          'Only draft purchase orders can be edited',
        );
      const v = await this.normalize(m, dto);
      Object.assign(o, {
        payload: dto,
        locationId: dto.locationId,
        normalizedLines: v.lines,
        total: v.total,
      });
      this.event(o, 'Purchase request revised', actor.sub);
    });
  }
  @Post(':id/confirm') @RequirePermissions('purchase.write') confirm(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.change(id, async (_m, o) => {
      if (o.state === 'CONFIRMED') return;
      if (o.state !== 'DRAFT')
        throw new BadRequestException(
          'Only draft purchase orders can be confirmed',
        );
      o.state = 'CONFIRMED';
      this.event(
        o,
        'Purchase order confirmed; awaiting warehouse receipt',
        actor.sub,
      );
    });
  }
  @Post(':id/receive') @RequirePermissions('purchase.receive') async receive(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: JwtPayload,
  ) {
    let posted = false;
    const result = await this.change(id, async (m, o) => {
      if (o.state === 'RECEIVED') return;
      if (o.state !== 'CONFIRMED')
        throw new BadRequestException(
          'Confirm the purchase order before receipt',
        );
      await assertOrderItemsActive(m, o.normalizedLines);
      const p = await this.purchases.create(o.payload, actor.sub, {
        manager: m,
        lines: o.normalizedLines,
      });
      o.purchaseId = p.id;
      o.state = 'RECEIVED';
      posted = true;
      this.event(o, 'Goods received; stock and purchase posted', actor.sub);
    });
    if (posted && result.purchaseId)
      await this.purchases.notifyReceived(result.purchaseId, actor.sub);
    return result;
  }
  @Post(':id/cancel') @RequirePermissions('purchase.write') cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.change(id, async (_m, o) => {
      if (o.state === 'RECEIVED')
        throw new BadRequestException(
          'Received purchase orders cannot be cancelled',
        );
      if (o.state === 'CANCELLED') return;
      o.state = 'CANCELLED';
      this.event(o, 'Purchase order cancelled', actor.sub);
    });
  }
}
