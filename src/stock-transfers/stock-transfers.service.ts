import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { TransferStatus } from '../common/enums';
import {
  applyDateRangeToQb,
  applyIlikeSearch,
  paginatedQueryBuilder,
} from '../common/utils/query.util';
import { StockTransferListQueryDto } from './dto/stock-transfer-list-query.dto';
import { StockTransferLine } from '../database/entities/stock-transfer-line.entity';
import { StockTransfer } from '../database/entities/stock-transfer.entity';
import { StockService } from '../inventory/stock.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  LowStockService,
  StockQuantityChange,
} from '../notifications/low-stock.service';
import { CreateStockTransferDto } from './dto/stock-transfer.dto';

@Injectable()
export class StockTransfersService {
  constructor(
    @InjectRepository(StockTransfer)
    private readonly transferRepo: Repository<StockTransfer>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly stockService: StockService,
    private readonly notifications: NotificationsService,
    private readonly lowStockService: LowStockService,
  ) {}

  findAll(query: StockTransferListQueryDto) {
    const qb = this.transferRepo
      .createQueryBuilder('transfer')
      .leftJoinAndSelect('transfer.fromLocation', 'fromLocation')
      .leftJoin('transfer.createdBy', 'recordCreator')
      .addSelect(['recordCreator.id', 'recordCreator.fullName'])
      .leftJoinAndSelect('transfer.toLocation', 'toLocation')
      .leftJoinAndSelect('transfer.lines', 'lines')
      .leftJoinAndSelect('lines.item', 'item')
      .orderBy('transfer.created_at', 'DESC');

    if (query.fromLocationId) {
      qb.andWhere('transfer.from_location_id = :fromLocationId', {
        fromLocationId: query.fromLocationId,
      });
    }
    if (query.toLocationId) {
      qb.andWhere('transfer.to_location_id = :toLocationId', {
        toLocationId: query.toLocationId,
      });
    }
    if (query.status) {
      qb.andWhere('transfer.status = :status', { status: query.status });
    }
    applyIlikeSearch(qb, query.search, ['transfer.notes']);
    applyDateRangeToQb(qb, 'transfer.created_at', query.from, query.to);

    return paginatedQueryBuilder(qb, query.page, query.limit);
  }

  findOne(id: string) {
    return this.transferRepo.findOne({
      where: { id },
      relations: {
        fromLocation: true,
        toLocation: true,
        lines: { item: true },
      },
    });
  }

  /**
   * Create a PENDING transfer and reserve source qty (does not move stock yet).
   * Pass `shipImmediately: true` to ship+receive in one step (legacy one-shot).
   */
  async create(dto: CreateStockTransferDto, userId?: string) {
    if (dto.fromLocationId === dto.toLocationId) {
      throw new BadRequestException('Source and destination must differ');
    }

    const transferId = await this.dataSource.transaction(async (manager) => {
      const transferRepo = manager.getRepository(StockTransfer);

      const transfer = await transferRepo.save(
        transferRepo.create({
          fromLocationId: dto.fromLocationId,
          toLocationId: dto.toLocationId,
          notes: dto.notes ?? null,
          status: TransferStatus.PENDING,
          createdById: userId ?? null,
          lines: dto.lines.map((l) =>
            Object.assign(new StockTransferLine(), {
              itemId: l.itemId,
              quantity: l.quantity.toFixed(3),
              unitCost: null,
            }),
          ),
        }),
      );

      for (const line of dto.lines) {
        await this.stockService.reserve(
          dto.fromLocationId,
          line.itemId,
          line.quantity,
          manager,
        );
      }

      return transfer.id;
    });

    if (dto.shipImmediately) {
      await this.ship(transferId, userId);
      return this.receive(transferId, userId);
    }

    const transfer = await this.findOne(transferId);
    if (!transfer) throw new NotFoundException('Stock transfer not found');
    return transfer;
  }

  /** PENDING → IN_TRANSIT: release reservation and TRANSFER_OUT from source. */
  async ship(id: string, userId?: string) {
    const stockChanges: StockQuantityChange[] = [];

    await this.dataSource.transaction(async (manager) => {
      const transferRepo = manager.getRepository(StockTransfer);
      await transferRepo
        .createQueryBuilder('document')
        .where('document.id = :id', { id })
        .setLock('pessimistic_write')
        .getOne();
      const transfer = await transferRepo.findOne({
        where: { id },
        relations: { lines: true },
      });
      if (!transfer) throw new NotFoundException('Stock transfer not found');
      if (transfer.status !== TransferStatus.PENDING) {
        throw new BadRequestException('Only PENDING transfers can be shipped');
      }

      for (const line of transfer.lines) {
        const qty = parseFloat(line.quantity);
        const previousQuantity = await this.stockService.getQuantity(
          transfer.fromLocationId,
          line.itemId,
          manager,
        );
        const unitCost = await this.stockService.shipOutbound(
          transfer.fromLocationId,
          line.itemId,
          qty,
          manager,
          {
            refType: 'stock_transfer',
            refId: transfer.id,
            createdById: userId ?? null,
          },
        );
        line.unitCost = unitCost.toFixed(2);
        stockChanges.push({
          locationId: transfer.fromLocationId,
          itemId: line.itemId,
          previousQuantity,
        });
      }

      transfer.status = TransferStatus.IN_TRANSIT;
      await transferRepo.save(transfer);
    });

    await this.lowStockService.evaluateChanges(stockChanges);
    const transfer = await this.findOne(id);
    if (!transfer) throw new NotFoundException('Stock transfer not found');
    return transfer;
  }

  /** IN_TRANSIT → COMPLETED: TRANSFER_IN at destination. */
  async receive(id: string, userId?: string) {
    await this.dataSource.transaction(async (manager) => {
      const transferRepo = manager.getRepository(StockTransfer);
      await transferRepo
        .createQueryBuilder('document')
        .where('document.id = :id', { id })
        .setLock('pessimistic_write')
        .getOne();
      const transfer = await transferRepo.findOne({
        where: { id },
        relations: { lines: true },
      });
      if (!transfer) throw new NotFoundException('Stock transfer not found');
      if (transfer.status !== TransferStatus.IN_TRANSIT) {
        throw new BadRequestException(
          'Only IN_TRANSIT transfers can be received',
        );
      }

      for (const line of transfer.lines) {
        const qty = parseFloat(line.quantity);
        const unitCost = parseFloat(line.unitCost ?? '0');
        await this.stockService.receiveInbound(
          transfer.toLocationId,
          line.itemId,
          qty,
          unitCost,
          manager,
          {
            refType: 'stock_transfer',
            refId: transfer.id,
            createdById: userId ?? null,
          },
        );
      }

      transfer.status = TransferStatus.COMPLETED;
      await transferRepo.save(transfer);
    });

    const transfer = await this.findOne(id);
    if (!transfer) throw new NotFoundException('Stock transfer not found');

    await this.notifications.onStockTransferCompleted({
      transferId: id,
      fromLocationName: transfer.fromLocation?.name ?? 'Unknown',
      toLocationName: transfer.toLocation?.name ?? 'Unknown',
      lineCount: transfer.lines.length,
      actorUserId: userId,
    });

    return transfer;
  }

  /**
   * Cancel PENDING (release reserves) or void COMPLETED (reverse stock).
   * IN_TRANSIT cannot be cancelled here — receive or admin reverse required.
   */
  async void(id: string) {
    await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(StockTransfer);
      await repo
        .createQueryBuilder('transfer')
        .where('transfer.id = :id', { id })
        .setLock('pessimistic_write')
        .getOne();
      const transfer = await repo.findOne({
        where: { id },
        relations: { lines: true },
      });
      if (!transfer) throw new NotFoundException('Stock transfer not found');
      if (transfer.status === TransferStatus.PENDING) {
        for (const line of transfer.lines)
          await this.stockService.releaseReservation(
            transfer.fromLocationId,
            line.itemId,
            Number(line.quantity),
            manager,
          );
      } else if (transfer.status === TransferStatus.COMPLETED) {
        for (const line of transfer.lines)
          await this.stockService.transfer(
            transfer.toLocationId,
            transfer.fromLocationId,
            line.itemId,
            Number(line.quantity),
            manager,
            {
              refType: 'stock_transfer_void',
              refId: transfer.id,
              notes: 'Transfer voided',
            },
          );
      } else {
        throw new BadRequestException(
          'Only pending or completed transfers can be cancelled',
        );
      }
      transfer.status = TransferStatus.CANCELLED;
      await repo.save(transfer);
    });
    return this.findOne(id);
  }
}
