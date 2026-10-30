import { normalizeLine, type UnitSnapshot } from '../units/conversion';
import { InquiryAttachment } from '../database/entities/inquiry-attachment.entity';
import { createHash } from 'crypto';
import { attachmentInput } from './inquiry-attachments';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { parseDateRange } from '../common/dto/date-range.dto';
import {
  InquiryAssignmentStatus,
  InquiryPriority,
  InquirySource,
  InquiryStatus,
} from '../common/enums';
import {
  absoluteMediaUrl,
  publicBaseFromConfig,
} from '../common/utils/media-url.util';
import { Customer } from '../database/entities/customer.entity';
import { CustomerInquiryLine } from '../database/entities/customer-inquiry-line.entity';
import { CustomerInquiry } from '../database/entities/customer-inquiry.entity';
import { Item } from '../database/entities/item.entity';
import { Sale } from '../database/entities/sale.entity';
import { ProductionOrder } from '../database/entities/production-order.entity';
import { User } from '../database/entities/user.entity';
import { NotificationsService } from '../notifications/notifications.service';
import {
  CreateInquiryDto,
  InquiryLineDto,
  InquiryListQueryDto,
  PublicCreateInquiryDto,
  UpdateInquiryDto,
} from './dto/inquiry.dto';
import { PublicCatalogQueryDto } from './dto/public-catalog-query.dto';

@Injectable()
export class InquiriesService {
  constructor(
    @InjectRepository(CustomerInquiry)
    private readonly repo: Repository<CustomerInquiry>,
    @InjectRepository(CustomerInquiryLine)
    private readonly lineRepo: Repository<CustomerInquiryLine>,
    @InjectRepository(Customer)
    private readonly customerRepo: Repository<Customer>,
    @InjectRepository(Item)
    private readonly itemRepo: Repository<Item>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(Sale)
    private readonly saleRepo: Repository<Sale>,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
    private readonly db: DataSource,
  ) {}

  /**
   * Apply assignee change using CRM accept workflow:
   * - clear → UNASSIGNED
   * - self-assign → ACCEPTED (+ IN_PROGRESS if NEW)
   * - assign to someone else → PENDING (they must Accept / Decline)
   */
  private applyAssigneeChange(
    row: CustomerInquiry,
    nextAssigneeId: string | null,
    actorUserId: string,
  ) {
    const prev = row.assignedToUserId;
    if (prev === nextAssigneeId) return false;

    row.assignedToUserId = nextAssigneeId;
    if (!nextAssigneeId) {
      row.assignmentStatus = InquiryAssignmentStatus.UNASSIGNED;
      row.assignedAt = null;
      row.acceptedAt = null;
      return true;
    }

    row.assignedAt = new Date();
    row.acceptedAt = null;
    if (nextAssigneeId === actorUserId) {
      row.assignmentStatus = InquiryAssignmentStatus.ACCEPTED;
      row.acceptedAt = new Date();
      if (row.status === InquiryStatus.NEW) {
        row.status = InquiryStatus.IN_PROGRESS;
      }
    } else {
      row.assignmentStatus = InquiryAssignmentStatus.PENDING;
    }
    return true;
  }

  private assertContactChannel(phone?: string | null, email?: string | null) {
    if (!phone?.trim() && !email?.trim()) {
      throw new BadRequestException('Provide at least a phone or email');
    }
  }

  private resolveLines(
    lines?: InquiryLineDto[],
    itemId?: string | null,
  ): InquiryLineDto[] {
    if (lines?.length) return lines;
    if (itemId) return [{ itemId }];
    return [];
  }

  private async normalizeLines(
    manager: EntityManager,
    lines: InquiryLineDto[],
    existing: CustomerInquiryLine[] = [],
  ) {
    const seen = new Set<string>();
    const result: (InquiryLineDto & { unitSnapshot: UnitSnapshot | null })[] =
      [];
    for (const line of lines) {
      if (seen.has(line.itemId))
        throw new BadRequestException('Duplicate item in inquiry lines');
      seen.add(line.itemId);
      const item = await manager
        .getRepository(Item)
        .findOneBy({ id: line.itemId });
      if (!item || !item.isActive)
        throw new BadRequestException('Select an active catalog item');
      if (line.quantity == null) {
        if (line.unitId || line.dimensions)
          throw new BadRequestException(
            'Enter a quantity when specifying units or dimensions',
          );
        result.push({ ...line, unitSnapshot: null });
      } else {
        const old = existing.find((l) => l.itemId === line.itemId);
        if (
          !line.unitId &&
          !line.dimensions &&
          old?.unitSnapshot &&
          Number(old.quantity) === line.quantity
        ) {
          result.push({
            ...line,
            quantity: Number(old.quantity),
            unitSnapshot: old.unitSnapshot,
          });
          continue;
        }
        const previous = existing.find(
          (l) => l.itemId === line.itemId,
        )?.unitSnapshot;
        const unchanged =
          previous &&
          previous.unitId === (line.unitId || item.unitId) &&
          Number(previous.quantity) === line.quantity &&
          JSON.stringify(previous.dimensions ?? null) ===
            JSON.stringify(line.dimensions ?? null);
        result.push(
          await normalizeLine(
            manager,
            line.itemId,
            { ...line, quantity: line.quantity },
            unchanged ? previous : undefined,
            !!unchanged,
          ),
        );
      }
    }
    return result;
  }

  private async assertOptionalRefs(opts: {
    customerId?: string | null;
    assignedToUserId?: string | null;
    convertedSaleId?: string | null;
  }) {
    if (opts.customerId) {
      const c = await this.customerRepo.findOne({
        where: { id: opts.customerId },
      });
      if (!c) throw new BadRequestException('Customer not found');
    }
    if (opts.assignedToUserId) {
      const user = await this.userRepo.findOne({
        where: { id: opts.assignedToUserId, isActive: true },
      });
      if (!user) {
        throw new BadRequestException('Assignee not found or inactive');
      }
    }
    if (opts.convertedSaleId) {
      const sale = await this.saleRepo.findOne({
        where: { id: opts.convertedSaleId },
      });
      if (!sale) throw new BadRequestException('Sale not found');
    }
  }

  private async saveLines(
    manager: EntityManager,
    inquiryId: string,
    lines: (InquiryLineDto & { unitSnapshot: UnitSnapshot | null })[],
  ) {
    const repo = manager.getRepository(CustomerInquiryLine);
    await repo.delete({ inquiryId });
    if (lines.length)
      await repo.save(
        lines.map((line) =>
          repo.create({
            inquiryId,
            itemId: line.itemId,
            quantity: line.quantity != null ? line.quantity.toFixed(3) : null,
            unitSnapshot: line.unitSnapshot,
            notes: line.notes?.trim() || null,
          }),
        ),
      );
  }

  private inquiryNotifyPayload(row: CustomerInquiry) {
    return {
      inquiryId: row.id,
      subject: row.subject,
      contactName: row.contactName,
      source: row.source,
      priority: row.priority,
    };
  }

  findAll(query: InquiryListQueryDto) {
    const qb = this.repo
      .createQueryBuilder('i')
      .leftJoinAndSelect('i.customer', 'customer')
      .leftJoinAndSelect('i.lines', 'lines')
      .leftJoinAndSelect('lines.item', 'lineItem')
      .leftJoinAndSelect('i.assignedTo', 'assignedTo')
      .leftJoinAndSelect('i.createdBy', 'createdBy')
      .orderBy('i.createdAt', 'DESC')
      .addOrderBy('i.id', 'DESC');

    if (query.status) {
      qb.andWhere('i.status = :status', { status: query.status });
    }
    if (query.source) {
      qb.andWhere('i.source = :source', { source: query.source });
    }
    if (query.priority) {
      qb.andWhere('i.priority = :priority', { priority: query.priority });
    }
    if (query.customerId) {
      qb.andWhere('i.customer_id = :customerId', {
        customerId: query.customerId,
      });
    }
    if (query.assignedToUserId) {
      qb.andWhere('i.assigned_to_user_id = :assignedToUserId', {
        assignedToUserId: query.assignedToUserId,
      });
    }
    if (query.itemId) {
      qb.andWhere(
        `EXISTS (
          SELECT 1 FROM customer_inquiry_lines cil
          WHERE cil.inquiry_id = i.id AND cil.item_id = :itemId
        )`,
        { itemId: query.itemId },
      );
    }
    if (query.assignmentStatus) {
      qb.andWhere('i.assignment_status = :assignmentStatus', {
        assignmentStatus: query.assignmentStatus,
      });
    }

    if (query.search?.trim()) {
      const search = `%${query.search.trim().replace(/^INQ-/i, '')}%`;
      qb.andWhere(
        `(i.contact_name ILIKE :search
          OR i.email ILIKE :search
          OR i.phone ILIKE :search
          OR i.subject ILIKE :search
          OR i.message ILIKE :search
          OR customer.name ILIKE :search
          OR i.id::text ILIKE :search
          OR EXISTS (SELECT 1 FROM customer_inquiry_lines search_line
            JOIN items search_item ON search_item.id = search_line.item_id
            WHERE search_line.inquiry_id=i.id AND
              (search_item.description ILIKE :search OR search_item.sku ILIKE :search)))`,
        { search },
      );
    }

    const { start, end } = parseDateRange(query.from, query.to);
    if (start) qb.andWhere('i.created_at >= :start', { start });
    if (end) qb.andWhere('i.created_at <= :end', { end });

    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const summary = qb
      .clone()
      .select('i.status', 'status')
      .addSelect('COUNT(DISTINCT i.id)::int', 'count')
      .addSelect(
        'COUNT(DISTINCT i.id) FILTER (WHERE i.converted_sale_id IS NOT NULL)::int',
        'converted',
      )
      .groupBy('i.status')
      .orderBy()
      .getRawMany<{ status: string; count: number; converted: number }>();
    const records = qb
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();
    return Promise.all([records, summary]).then(
      async ([[data, total], counts]) => {
        const activeProduction = data.length
          ? await this.db
              .getRepository(ProductionOrder)
              .createQueryBuilder('production')
              .select('production.inquiryId', 'inquiryId')
              .where('production.inquiryId IN (:...ids)', {
                ids: data.map((r) => r.id),
              })
              .andWhere('production.status <> :cancelled', {
                cancelled: 'CANCELLED',
              })
              .groupBy('production.inquiryId')
              .getRawMany<{ inquiryId: string }>()
          : [];
        const productionIds = new Set(activeProduction.map((p) => p.inquiryId));
        return {
          data: data.map((row) =>
            Object.assign(row, { hasProduction: productionIds.has(row.id) }),
          ),
          totals: {
            total,
            converted: counts.reduce((sum, c) => sum + Number(c.converted), 0),
            byStatus: Object.fromEntries(
              counts.map((c) => [c.status, Number(c.count)]),
            ),
          },
          meta: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit) || 1,
          },
        };
      },
    );
  }

  async findOne(id: string) {
    const row = await this.repo.findOne({
      where: { id },
      relations: {
        customer: true,
        lines: { item: true },
        assignedTo: true,
        createdBy: true,
        attachments: true,
      },
      order: { lines: { id: 'ASC' } },
    });
    if (!row) throw new NotFoundException('Inquiry not found');
    for (const line of row.lines ?? []) {
      if (line.item)
        Object.assign(line.item, {
          imageUrl: absoluteMediaUrl(line.item.imagePath, {
            publicBaseUrl: publicBaseFromConfig(this.config),
          }),
        });
    }
    const productionOrders = await this.db.getRepository(ProductionOrder).find({
      where: { inquiryId: id },
      select: {
        id: true,
        orderNumber: true,
        status: true,
        finishedItemId: true,
        quantityPlanned: true,
        createdAt: true,
      },
      order: { createdAt: 'DESC' },
    });
    return Object.assign(row, { productionOrders });
  }

  async close(id: string) {
    await this.db.transaction(async (manager) => {
      const row = await manager
        .getRepository(CustomerInquiry)
        .findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!row) throw new NotFoundException('Inquiry not found');
      if (row.status === InquiryStatus.CANCELLED)
        throw new BadRequestException('A cancelled inquiry cannot be closed');
      if (row.status !== InquiryStatus.CLOSED)
        await manager
          .getRepository(CustomerInquiry)
          .update(id, { status: InquiryStatus.CLOSED });
    });
    return this.findOne(id);
  }

  private async createRequest(
    dto: CreateInquiryDto | PublicCreateInquiryDto,
    source: InquirySource,
    actor?: string,
  ) {
    if (source === InquirySource.PUBLIC)
      this.assertContactChannel(dto.phone, dto.email);
    if (
      source === InquirySource.PUBLIC &&
      (!dto.contactName?.trim() || !dto.subject?.trim())
    )
      throw new BadRequestException('Contact name and subject are required');
    const lines = this.resolveLines(dto.lines, dto.itemId);
    if (!lines.length && !dto.message?.trim())
      throw new BadRequestException('Add a product or describe the request');
    const staff =
      source === InquirySource.INTERNAL ? (dto as CreateInquiryDto) : undefined;
    await this.assertOptionalRefs({
      customerId: staff?.customerId,
      assignedToUserId: staff?.assignedToUserId,
    });
    const customer = staff?.customerId
      ? await this.customerRepo.findOneBy({ id: staff.customerId })
      : null;
    const employee = actor
      ? await this.db.getRepository(User).findOneBy({ id: actor })
      : null;
    const row = await this.db.transaction(async (manager) => {
      const normalized = await this.normalizeLines(manager, lines);
      const firstItem = lines[0]
        ? await manager.getRepository(Item).findOneBy({ id: lines[0].itemId })
        : null;
      const repo = manager.getRepository(CustomerInquiry);
      const draft = repo.create({
        contactName:
          source === InquirySource.INTERNAL
            ? (customer?.name ?? employee?.fullName ?? 'Internal inquiry')
            : dto.contactName.trim(),
        phone:
          source === InquirySource.INTERNAL
            ? (customer?.phone ?? null)
            : dto.phone?.trim() || null,
        email:
          source === InquirySource.INTERNAL
            ? (customer?.email ?? null)
            : dto.email?.trim() || null,
        subject:
          dto.subject?.trim() ||
          (firstItem
            ? `${firstItem.description}${lines.length > 1 ? ` + ${lines.length - 1} more` : ''}`.slice(
                0,
                200,
              )
            : 'General inquiry'),
        message: dto.message?.trim() || '',
        requestedDeliveryDate: dto.requestedDeliveryDate || null,
        source,
        status: InquiryStatus.NEW,
        priority: staff?.priority ?? InquiryPriority.NORMAL,
        customerId: staff?.customerId ?? null,
        assignedToUserId: null,
        assignmentStatus: InquiryAssignmentStatus.UNASSIGNED,
        assignedAt: null,
        acceptedAt: null,
        createdById: actor ?? null,
        internalNotes: staff?.internalNotes?.trim() || null,
        followUpAt: staff?.followUpAt ? new Date(staff.followUpAt) : null,
        convertedSaleId: null,
      });
      if (staff?.assignedToUserId && actor)
        this.applyAssigneeChange(draft, staff.assignedToUserId, actor);
      const saved = await repo.save(draft);
      await this.saveLines(manager, saved.id, normalized);
      return saved;
    });
    return row;
  }
  async createPublic(dto: PublicCreateInquiryDto) {
    const row = await this.createRequest(dto, InquirySource.PUBLIC);
    await this.notifications.onInquirySubmitted(this.inquiryNotifyPayload(row));
    return {
      id: row.id,
      status: row.status,
      message: 'Inquiry submitted successfully',
    };
  }
  async createInternal(dto: CreateInquiryDto, actor: string) {
    const row = await this.createRequest(dto, InquirySource.INTERNAL, actor);
    if (row.assignedToUserId)
      await this.notifications.onInquiryAssignmentChanged({
        ...this.inquiryNotifyPayload(row),
        assigneeUserId: row.assignedToUserId,
        previousAssigneeUserId: null,
        actorUserId: actor,
        assignmentStatus: row.assignmentStatus,
      });
    return this.findOne(row.id);
  }
  async update(id: string, dto: UpdateInquiryDto, actorUserId: string) {
    const { row, previousAssigneeUserId, assigneeChanged } =
      await this.db.transaction(async (manager) => {
        await manager.query(
          'SELECT id FROM customer_inquiries WHERE id=$1 FOR UPDATE',
          [id],
        );
        const repo = manager.getRepository(CustomerInquiry);
        const row = await repo.findOneBy({ id });
        if (!row) throw new NotFoundException('Inquiry not found');
        if (
          dto.status !== undefined &&
          dto.status !== row.status &&
          (dto.status !== InquiryStatus.CLOSED ||
            row.status === InquiryStatus.CANCELLED)
        )
          throw new BadRequestException(
            'Use the inquiry workflow actions to change its status',
          );
        if (dto.status === InquiryStatus.CONVERTED && !row.convertedSaleId)
          throw new BadRequestException(
            'Create a sale from this inquiry to mark it converted',
          );
        if (
          row.convertedSaleId &&
          dto.status !== undefined &&
          ![InquiryStatus.CONVERTED, InquiryStatus.CLOSED].includes(dto.status)
        )
          throw new BadRequestException(
            'A converted inquiry cannot be reopened',
          );
        if (
          dto.convertedSaleId !== undefined &&
          dto.convertedSaleId !== row.convertedSaleId
        )
          throw new BadRequestException(
            'The sale link is read-only. Create a sale from the inquiry instead.',
          );
        const previousAssigneeUserId = row.assignedToUserId;
        if (row.source === InquirySource.PUBLIC)
          this.assertContactChannel(
            dto.phone !== undefined ? dto.phone : row.phone,
            dto.email !== undefined ? dto.email : row.email,
          );
        await this.assertOptionalRefs({
          customerId: dto.customerId,
          assignedToUserId: dto.assignedToUserId,
        });
        let changedLines = dto.lines !== undefined || dto.itemId !== undefined;
        const existingLines = changedLines
          ? await manager
              .getRepository(CustomerInquiryLine)
              .findBy({ inquiryId: id })
          : [];
        if (changedLines && row.convertedSaleId) {
          const requested = this.resolveLines(dto.lines, dto.itemId);
          const legacyEcho =
            requested.length === existingLines.length &&
            new Set(requested.map((l) => l.itemId)).size === requested.length &&
            requested.every((line) => {
              const old = existingLines.find((l) => l.itemId === line.itemId);
              return (
                old &&
                !line.unitId &&
                !line.dimensions &&
                (line.quantity == null
                  ? old.quantity == null
                  : Number(old.quantity) === line.quantity) &&
                (line.notes?.trim() || null) === (old.notes?.trim() || null)
              );
            });
          if (!legacyEcho)
            throw new BadRequestException(
              'Converted inquiry products are read-only',
            );
          changedLines = false;
        }
        const normalized = changedLines
          ? await this.normalizeLines(
              manager,
              this.resolveLines(dto.lines, dto.itemId),
              existingLines,
            )
          : null;
        if (
          normalized &&
          !normalized.length &&
          !(dto.message ?? row.message)?.trim()
        )
          throw new BadRequestException(
            'Add a product or describe the request',
          );
        for (const key of ['contactName', 'subject', 'message'] as const)
          if (dto[key] !== undefined) row[key] = dto[key].trim();
        for (const key of ['phone', 'email', 'internalNotes'] as const)
          if (dto[key] !== undefined) row[key] = dto[key]?.trim() || null;
        if (dto.priority !== undefined) row.priority = dto.priority;
        if (dto.status !== undefined) row.status = dto.status;
        if (dto.customerId !== undefined) {
          row.customerId = dto.customerId;
          if (row.source === InquirySource.INTERNAL) {
            const customer = dto.customerId
              ? await manager
                  .getRepository(Customer)
                  .findOneBy({ id: dto.customerId })
              : null;
            const creator = row.createdById
              ? await manager
                  .getRepository(User)
                  .findOneBy({ id: row.createdById })
              : null;
            row.contactName =
              customer?.name ?? creator?.fullName ?? 'Internal inquiry';
            row.phone = customer?.phone ?? null;
            row.email = customer?.email ?? null;
          }
        }
        if (dto.requestedDeliveryDate !== undefined)
          row.requestedDeliveryDate = dto.requestedDeliveryDate || null;
        if (dto.followUpAt !== undefined)
          row.followUpAt = dto.followUpAt ? new Date(dto.followUpAt) : null;
        const assigneeChanged =
          dto.assignedToUserId !== undefined
            ? this.applyAssigneeChange(row, dto.assignedToUserId, actorUserId)
            : false;
        await repo.save(row);
        if (normalized) await this.saveLines(manager, id, normalized);
        return { row, previousAssigneeUserId, assigneeChanged };
      });
    if (assigneeChanged)
      await this.notifications.onInquiryAssignmentChanged({
        ...this.inquiryNotifyPayload(row),
        assigneeUserId: row.assignedToUserId,
        previousAssigneeUserId,
        actorUserId,
        assignmentStatus: row.assignmentStatus,
      });
    return this.findOne(id);
  }
  async addAttachments(id: string, files: Express.Multer.File[]) {
    if (!files?.length)
      throw new BadRequestException('Choose at least one file');
    const inputs = files.map((file) => ({
      ...attachmentInput(file),
      hash: createHash('sha256').update(file.buffer).digest('hex'),
    }));
    return this.db.transaction(async (manager) => {
      const [row] = await manager.query(
        'SELECT id FROM customer_inquiries WHERE id=$1 FOR UPDATE',
        [id],
      );
      if (!row) throw new NotFoundException('Inquiry not found');
      const repo = manager.getRepository(InquiryAttachment);
      const existing = await repo
        .createQueryBuilder('a')
        .addSelect('a.hash')
        .where('a.inquiryId=:id', { id })
        .getMany();
      const known = new Set(existing.map((a) => a.hash));
      const unique = inputs.filter((input) => {
        if (known.has(input.hash)) return false;
        known.add(input.hash);
        return true;
      });
      if (existing.length + unique.length > 5)
        throw new BadRequestException(
          'An inquiry supports up to 5 attachments',
        );
      if (unique.length)
        await repo.save(
          unique.map((input) => repo.create({ ...input, inquiryId: id })),
        );
      return repo.find({
        where: { inquiryId: id },
        order: { createdAt: 'ASC' },
      });
    });
  }
  async downloadAttachment(id: string, attachmentId: string) {
    const file = await this.db
      .getRepository(InquiryAttachment)
      .createQueryBuilder('a')
      .addSelect('a.data')
      .where('a.id=:attachmentId AND a.inquiryId=:id', { id, attachmentId })
      .getOne();
    if (!file) throw new NotFoundException('Attachment not found');
    return file;
  }
  async removeAttachment(id: string, attachmentId: string) {
    const result = await this.db
      .getRepository(InquiryAttachment)
      .delete({ id: attachmentId, inquiryId: id });
    if (!result.affected) throw new NotFoundException('Attachment not found');
    return { deleted: true };
  }

  private async transition<T>(id: string, action: (row: CustomerInquiry) => T) {
    return this.db.transaction(async (manager) => {
      await manager.query(
        'SELECT id FROM customer_inquiries WHERE id=$1 FOR UPDATE',
        [id],
      );
      const repo = manager.getRepository(CustomerInquiry);
      const row = await repo.findOne({
        where: { id },
        relations: { lines: true },
      });
      if (!row) throw new NotFoundException('Inquiry not found');
      if (
        row.convertedSaleId ||
        [
          InquiryStatus.CANCELLED,
          InquiryStatus.CLOSED,
          InquiryStatus.CONVERTED,
        ].includes(row.status)
      )
        throw new BadRequestException('This inquiry is no longer open');
      const result = action(row);
      if (result !== false)
        await repo.update(id, {
          status: row.status,
          assignedToUserId: row.assignedToUserId,
          assignmentStatus: row.assignmentStatus,
          assignedAt: row.assignedAt,
          acceptedAt: row.acceptedAt,
        });
      return { row, result };
    });
  }
  async accept(id: string, userId: string) {
    const { row } = await this.transition(id, (row) => {
      if (row.assignedToUserId !== userId)
        throw new ForbiddenException(
          'Only the assignee can accept this inquiry',
        );
      if (row.assignmentStatus !== InquiryAssignmentStatus.PENDING)
        throw new BadRequestException('Inquiry is not pending acceptance');
      row.assignmentStatus = InquiryAssignmentStatus.ACCEPTED;
      row.acceptedAt = new Date();
      if (row.status === InquiryStatus.NEW)
        row.status = InquiryStatus.IN_PROGRESS;
    });
    await this.notifications.onInquiryAssignmentResponse({
      ...this.inquiryNotifyPayload(row),
      actorUserId: userId,
      event: 'accepted',
    });
    return this.findOne(id);
  }
  async decline(id: string, userId: string) {
    const { row, result: previousAssigneeUserId } = await this.transition(
      id,
      (row) => {
        if (row.assignedToUserId !== userId)
          throw new ForbiddenException(
            'Only the assignee can decline this inquiry',
          );
        if (row.assignmentStatus !== InquiryAssignmentStatus.PENDING)
          throw new BadRequestException('Inquiry is not pending acceptance');
        const previous = row.assignedToUserId;
        row.assignedToUserId = null;
        row.assignmentStatus = InquiryAssignmentStatus.DECLINED;
        row.acceptedAt = null;
        return previous;
      },
    );
    await this.notifications.onInquiryAssignmentResponse({
      ...this.inquiryNotifyPayload(row),
      actorUserId: userId,
      event: 'declined',
      previousAssigneeUserId,
    });
    return this.findOne(id);
  }
  async confirm(id: string, actorUserId: string) {
    const { row, result: changed } = await this.transition(id, (row) => {
      if (
        !row.lines?.length ||
        row.lines.some((l) => l.quantity == null || Number(l.quantity) <= 0)
      )
        throw new BadRequestException(
          'Add products and requested quantities before confirming the inquiry',
        );
      if (
        [
          InquiryAssignmentStatus.PENDING,
          InquiryAssignmentStatus.DECLINED,
        ].includes(row.assignmentStatus)
      )
        throw new BadRequestException(
          'Accept the inquiry assignment before confirming requirements',
        );
      if (row.status === InquiryStatus.QUOTED) return false;
      row.status = InquiryStatus.QUOTED;
      return true;
    });
    if (changed)
      await this.notifications.onInquiryConfirmed({
        ...this.inquiryNotifyPayload(row),
        actorUserId,
      });
    return this.findOne(id);
  }
  async claim(id: string, userId: string) {
    const { row, result: previousAssigneeUserId } = await this.transition(
      id,
      (row) => {
        if (
          row.assignedToUserId &&
          row.assignmentStatus === InquiryAssignmentStatus.ACCEPTED
        )
          throw new BadRequestException(
            'Inquiry is already accepted by someone',
          );
        if (
          row.assignedToUserId &&
          row.assignmentStatus === InquiryAssignmentStatus.PENDING &&
          row.assignedToUserId !== userId
        )
          throw new BadRequestException(
            'Inquiry is pending acceptance by another user',
          );
        const previous = row.assignedToUserId;
        this.applyAssigneeChange(row, userId, userId);
        return previous;
      },
    );
    if (previousAssigneeUserId && previousAssigneeUserId !== userId)
      await this.notifications.onInquiryAssignmentChanged({
        ...this.inquiryNotifyPayload(row),
        assigneeUserId: userId,
        previousAssigneeUserId,
        actorUserId: userId,
        assignmentStatus: row.assignmentStatus,
      });
    return this.findOne(id);
  }

  async findPublicCatalog(query: PublicCatalogQueryDto) {
    const qb = this.itemRepo
      .createQueryBuilder('item')
      .leftJoinAndSelect('item.stockUnit', 'stockUnit')
      .where('item.is_active = true')
      .orderBy('item.description', 'ASC');

    if (query.search?.trim()) {
      const search = `%${query.search.trim()}%`;
      qb.andWhere(
        '(item.description ILIKE :search OR item.sku ILIKE :search)',
        { search },
      );
    }

    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 20, 50);
    const [rows, total] = await qb
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    const publicBase = publicBaseFromConfig(this.config);
    return {
      data: rows.map((item) => ({
        id: item.id,
        sku: item.sku,
        description: item.description,
        itemType: item.itemType,
        unitId: item.unitId,
        unit: item.stockUnit?.symbol ?? item.unit,
        stockUnit: item.stockUnit,
        imageUrl: absoluteMediaUrl(item.imagePath, {
          publicBaseUrl: publicBase,
        }),
      })),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
      },
    };
  }

  async remove(id: string) {
    await this.db.transaction(async (manager) => {
      await manager.query(
        'SELECT id FROM customer_inquiries WHERE id=$1 FOR UPDATE',
        [id],
      );
      const repo = manager.getRepository(CustomerInquiry),
        row = await repo.findOneBy({ id });
      if (!row) throw new NotFoundException('Inquiry not found');
      if (row.convertedSaleId || row.status === InquiryStatus.CONVERTED)
        throw new BadRequestException(
          'Converted inquiries cannot be cancelled; close them instead',
        );
      if (row.status === InquiryStatus.CLOSED)
        throw new BadRequestException('A closed inquiry cannot be cancelled');
      await repo.update(id, { status: InquiryStatus.CANCELLED });
    });
    return this.findOne(id);
  }
}
