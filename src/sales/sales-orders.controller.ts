import { Customer } from '../database/entities/customer.entity';
import { Location } from '../database/entities/location.entity';
import { CustomerInquiryLine } from '../database/entities/customer-inquiry-line.entity';
import { Transform } from 'class-transformer';
import { ListQueryDto } from '../common/dto/list-query.dto';
import { paginatedQueryBuilder } from '../common/utils/query.util';
import { Item } from '../database/entities/item.entity';
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import Decimal from 'decimal.js';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import {
  CurrentUser,
  type JwtPayload,
} from '../common/decorators/current-user.decorator';
import { SalesOrder } from '../database/entities/sales-order.entity';
import { User } from '../database/entities/user.entity';
import { normalizeLine, commercialTotal } from '../units/conversion';
import {
  priceExceptions,
  assertOrderItemsActive,
  commissionExceptions,
} from './pricing';
import { CreateSaleDto } from './dto/sale.dto';
import { SalesService } from './sales.service';
import { StockService } from '../inventory/stock.service';
import { applyLocationScope } from '../common/location-scope';
class DecisionDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  note: string;
}
@Controller('sales-orders')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class SalesOrdersController {
  constructor(
    private readonly db: DataSource,
    private readonly sales: SalesService,
    private readonly stock: StockService,
  ) {}
  @Get() @RequirePermissions('sales.read') async list(
    @Query() query: ListQueryDto,
  ) {
    const qb = applyLocationScope(
      this.db.getRepository(SalesOrder).createQueryBuilder('o'),
    ).orderBy('o.created_at', 'DESC');
    if (query.search?.trim())
      qb.andWhere('(o.id::text ILIKE :q OR o.payload::text ILIKE :q)', {
        q: `%${query.search.trim().slice(0, 100)}%`,
      });
    return paginatedQueryBuilder(qb, query.page, query.limit);
  }
  @Get(':id') @RequirePermissions('sales.read') async detail(
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const order = await applyLocationScope(
      this.db.getRepository(SalesOrder).createQueryBuilder('o'),
    )
      .andWhere('o.id=:id', { id })
      .getOne();
    if (!order) throw new NotFoundException('Sales order not found');
    const ids = [...new Set(order.history.map((h) => h.actorId))];
    const users = ids.length
      ? await this.db
          .getRepository(User)
          .createQueryBuilder('u')
          .select(['u.id', 'u.fullName'])
          .where('u.id IN (:...ids)', { ids })
          .getMany()
      : [];
    const itemIds = [...new Set(order.normalizedLines.map((l) => l.itemId))];
    const items = itemIds.length
      ? await this.db
          .getRepository(Item)
          .createQueryBuilder('i')
          .select(['i.id', 'i.description', 'i.sku', 'i.imagePath'])
          .where('i.id IN (:...itemIds)', { itemIds })
          .getMany()
      : [];
    const [customer, location] = await Promise.all([
      order.payload.customerId
        ? this.db.getRepository(Customer).findOne({
            where: { id: order.payload.customerId },
            select: { id: true, name: true },
          })
        : Promise.resolve(null),
      this.db.getRepository(Location).findOne({
        where: { id: order.locationId },
        select: { id: true, name: true },
      }),
    ]);
    return {
      ...order,
      items,
      customer,
      location,
      history: order.history.map((h) => ({
        ...h,
        actorName:
          users.find((u) => u.id === h.actorId)?.fullName ?? 'Former user',
      })),
    };
  }
  private checkSalesperson(
    dto: CreateSaleDto,
    actorId: string,
    permissions: string[],
  ) {
    if (dto.allowNegativeStock)
      throw new BadRequestException(
        'Orders require available stock before confirmation',
      );
    if (
      dto.soldByUserId &&
      dto.soldByUserId !== actorId &&
      !permissions.includes('sales.on_behalf')
    )
      throw new ForbiddenException(
        'sales.on_behalf permission required to choose another representative',
      );
  }
  private event(
    order: SalesOrder,
    action: string,
    actorId: string,
    note?: string,
  ) {
    order.history = [
      ...order.history,
      {
        action,
        actorId,
        at: new Date().toISOString(),
        ...(note ? { note } : {}),
      },
    ];
  }
  private async validate(m: EntityManager, dto: CreateSaleDto) {
    // Validate and freeze unit conversions before approval. No stock or money moves here.
    const lines = await Promise.all(
      dto.lines.map(async (l) => {
        const source = dto.inquiryId
          ? await m.getRepository(CustomerInquiryLine).findOneBy({
              inquiryId: dto.inquiryId,
              itemId: l.itemId,
              ...(l.inquiryLineId ? { id: l.inquiryLineId } : {}),
            })
          : null;
        if (l.inquiryLineId && !source)
          throw new BadRequestException(
            'The inquiry line no longer matches this item. Refresh the inquiry before quoting.',
          );
        return normalizeLine(m, l.itemId, l, source?.unitSnapshot);
      }),
    );
    const issues = [
      ...(await priceExceptions(m, lines)),
      ...commissionExceptions(dto),
    ];
    return {
      lines,
      issues,
      total: lines
        .reduce((s, l) => s.plus(commercialTotal(l)), new Decimal(0))
        .toFixed(2),
    };
  }
  @Post() @RequirePermissions('sales.write') async create(
    @Body() dto: CreateSaleDto,
    @CurrentUser() actor: JwtPayload,
    @Req() req: { permissions?: string[] },
  ) {
    this.checkSalesperson(dto, actor.sub, req.permissions ?? []);
    return this.db.transaction(async (m) => {
      const v = await this.validate(m, dto),
        repo = m.getRepository(SalesOrder);
      const order = repo.create({
        state: 'DRAFT',
        locationId: dto.locationId,
        payload: dto,
        normalizedLines: v.lines,
        priceExceptions: v.issues,
        total: v.total,
        createdById: actor.sub,
        history: [],
      });
      this.event(order, 'Created quotation', actor.sub);
      return repo.save(order);
    });
  }
  @Patch(':id') @RequirePermissions('sales.write') async edit(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateSaleDto,
    @CurrentUser() actor: JwtPayload,
    @Req() req: { permissions?: string[] },
  ) {
    this.checkSalesperson(dto, actor.sub, req.permissions ?? []);
    return this.change(id, async (m, o) => {
      if (!['DRAFT', 'PENDING_APPROVAL', 'APPROVED'].includes(o.state))
        throw new BadRequestException(
          'Only unconfirmed quotations can be revised',
        );
      const v = await this.validate(m, dto);
      Object.assign(o, {
        state: 'DRAFT',
        locationId: dto.locationId,
        payload: dto,
        normalizedLines: v.lines,
        priceExceptions: v.issues,
        total: v.total,
        approvedById: null,
        approvedAt: null,
        approvalNote: null,
      });
      this.event(o, 'Revised quotation; approval reset', actor.sub);
    });
  }
  private async change(
    id: string,
    fn: (m: EntityManager, o: SalesOrder) => Promise<void>,
  ) {
    await this.db.transaction(async (m) => {
      await m.query('SELECT id FROM sales_orders WHERE id=$1 FOR UPDATE', [id]);
      const o = await applyLocationScope(
        m.getRepository(SalesOrder).createQueryBuilder('o'),
      )
        .andWhere('o.id=:id', { id })
        .getOne();
      if (!o) throw new NotFoundException('Sales order not found');
      await fn(m, o);
      await m.getRepository(SalesOrder).save(o);
    });
    return this.detail(id);
  }
  @Post(':id/submit') @RequirePermissions('sales.write') submit(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.change(id, async (m, o) => {
      if (o.state !== 'DRAFT')
        throw new BadRequestException('Only draft quotations can be submitted');
      const v = await this.validate(m, o.payload);
      Object.assign(o, {
        normalizedLines: v.lines,
        priceExceptions: v.issues,
        total: v.total,
        state: v.issues.length ? 'PENDING_APPROVAL' : 'APPROVED',
      });
      this.event(
        o,
        v.issues.length
          ? 'Submitted for price approval'
          : 'Standard prices validated',
        actor.sub,
      );
    });
  }
  @Post(':id/approve') @RequirePermissions('sales.approve') approve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DecisionDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.change(id, async (_m, o) => {
      if (o.state !== 'PENDING_APPROVAL')
        throw new BadRequestException(
          'This quotation is not awaiting approval',
        );
      if (
        o.createdById === actor.sub ||
        [...o.history]
          .reverse()
          .find((h) => h.action.startsWith('Revised quotation'))?.actorId ===
          actor.sub ||
        [...o.history]
          .reverse()
          .find((h) => h.action === 'Submitted for price approval')?.actorId ===
          actor.sub
      )
        throw new ForbiddenException(
          'Another authorized user must approve your price exception',
        );
      o.state = 'APPROVED';
      o.approvedById = actor.sub;
      o.approvedAt = new Date();
      o.approvalNote = dto.note.trim();
      this.event(o, 'Approved price exception', actor.sub, dto.note.trim());
    });
  }
  @Post(':id/reject') @RequirePermissions('sales.approve') reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DecisionDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.change(id, async (_m, o) => {
      if (o.state !== 'PENDING_APPROVAL')
        throw new BadRequestException(
          'This quotation is not awaiting approval',
        );
      o.state = 'DRAFT';
      this.event(
        o,
        'Price approval rejected; revision required',
        actor.sub,
        dto.note.trim(),
      );
    });
  }
  @Post(':id/confirm') @RequirePermissions('sales.write') confirm(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.change(id, async (m, o) => {
      if (o.state === 'CONFIRMED') return;
      if (o.state !== 'APPROVED')
        throw new BadRequestException(
          'Submit and approve the quotation before confirming',
        );
      await assertOrderItemsActive(m, o.normalizedLines);
      // Standard prices are rechecked on confirmation; explicit exception approvals retain their snapshot.
      if (!o.approvedById) {
        const issues = await priceExceptions(m, o.normalizedLines);
        if (issues.length)
          throw new BadRequestException(
            'Prices changed. Revise and resubmit the quotation.',
          );
      }
      for (const l of this.aggregate(o))
        await this.stock.reserve(o.locationId, l.itemId, l.quantity, m);
      o.state = 'CONFIRMED';
      this.event(o, 'Confirmed order; stock reserved', actor.sub);
    });
  }
  private aggregate(o: SalesOrder) {
    const map = new Map<string, number>();
    for (const l of o.normalizedLines)
      map.set(l.itemId, (map.get(l.itemId) ?? 0) + l.quantity);
    return [...map]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([itemId, quantity]) => ({ itemId, quantity }));
  }
  @Post(':id/deliver') @RequirePermissions('sales.deliver') async deliver(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: JwtPayload,
  ) {
    let posted = false;
    const result = await this.change(id, async (m, o) => {
      if (o.state === 'DELIVERED') return;
      if (o.state !== 'CONFIRMED')
        throw new BadRequestException('Confirm the order before delivery');
      await assertOrderItemsActive(m, o.normalizedLines);
      for (const l of this.aggregate(o))
        await this.stock.releaseReservation(
          o.locationId,
          l.itemId,
          l.quantity,
          m,
        );
      const payload = { ...o.payload, allowNegativeStock: false };
      // The original representative is validated again; warehouse staff do not become the seller.
      payload.soldByUserId = payload.soldByUserId ?? o.createdById ?? undefined;
      const sale = await this.sales.create(payload, actor.sub, false, true, {
        manager: m,
        approvedLines: o.normalizedLines,
      });
      o.saleId = sale.id;
      o.state = 'DELIVERED';
      this.event(o, 'Delivered; stock and invoice posted', actor.sub);
      posted = true;
    });
    if (posted && result.saleId)
      await this.sales.notifyDelivered(result.saleId, actor.sub);
    return result;
  }
  @Post(':id/cancel') @RequirePermissions('sales.write') cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.change(id, async (m, o) => {
      if (o.state === 'DELIVERED')
        throw new BadRequestException(
          'Delivered orders require a return, not cancellation',
        );
      if (o.state === 'CANCELLED') return;
      if (o.state === 'CONFIRMED')
        for (const l of this.aggregate(o))
          await this.stock.releaseReservation(
            o.locationId,
            l.itemId,
            l.quantity,
            m,
          );
      o.state = 'CANCELLED';
      this.event(o, 'Cancelled', actor.sub);
    });
  }
}
