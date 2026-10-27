import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  applyDateRangeToQb,
  applyIlikeSearch,
  paginatedQueryBuilder,
} from '../common/utils/query.util';
import { InternalMessage } from '../database/entities/internal-message.entity';
import { User } from '../database/entities/user.entity';
import { CreateMessageDto, MessageListQueryDto } from './dto/message.dto';

@Injectable()
export class MessagesService {
  constructor(
    @InjectRepository(InternalMessage)
    private readonly messageRepo: Repository<InternalMessage>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) {}

  private relations() {
    return {
      sender: true,
      recipient: true,
    } as const;
  }

  async findAll(userId: string, query: MessageListQueryDto) {
    const folder = query.folder === 'sent' ? 'sent' : 'inbox';
    const qb = this.messageRepo
      .createQueryBuilder('msg')
      .leftJoinAndSelect('msg.sender', 'sender')
      .leftJoinAndSelect('msg.recipient', 'recipient')
      .orderBy('msg.created_at', 'DESC');

    if (folder === 'sent') {
      qb.where('msg.sender_id = :userId', { userId });
    } else {
      qb.where('msg.recipient_id = :userId', { userId });
      if (query.unreadOnly === 'true') {
        qb.andWhere('msg.is_read = false');
      }
    }

    applyIlikeSearch(qb, query.search, [
      'msg.body',
      'sender.full_name',
      'sender.email',
      'recipient.full_name',
      'recipient.email',
    ]);
    applyDateRangeToQb(qb, 'msg.created_at', query.from, query.to);

    return paginatedQueryBuilder(qb, query.page, query.limit);
  }

  async unreadCount(userId: string) {
    const count = await this.messageRepo.count({
      where: { recipientId: userId, isRead: false },
    });
    return { count };
  }

  async findOne(userId: string, id: string) {
    const msg = await this.messageRepo.findOne({
      where: { id },
      relations: this.relations(),
    });
    if (!msg) throw new NotFoundException('Message not found');
    if (msg.recipientId !== userId && msg.senderId !== userId) {
      throw new ForbiddenException('Not allowed to view this message');
    }
    return msg;
  }

  async create(userId: string, dto: CreateMessageDto) {
    if (dto.recipientId === userId) {
      throw new BadRequestException('Cannot send a message to yourself');
    }
    const recipient = await this.userRepo.findOne({
      where: { id: dto.recipientId, isActive: true },
    });
    if (!recipient) {
      throw new BadRequestException('Recipient not found or inactive');
    }

    const saved = await this.messageRepo.save(
      this.messageRepo.create({
        senderId: userId,
        recipientId: dto.recipientId,
        body: dto.body.trim(),
        isRead: false,
        readAt: null,
      }),
    );

    return this.findOne(userId, saved.id);
  }

  async markRead(userId: string, id: string) {
    const msg = await this.findOne(userId, id);
    if (msg.recipientId !== userId) {
      throw new ForbiddenException('Only the recipient can mark as read');
    }
    if (!msg.isRead) {
      msg.isRead = true;
      msg.readAt = new Date();
      await this.messageRepo.save(msg);
    }
    return this.findOne(userId, id);
  }

  async markAllRead(userId: string) {
    await this.messageRepo
      .createQueryBuilder()
      .update(InternalMessage)
      .set({ isRead: true, readAt: new Date() })
      .where('recipient_id = :userId', { userId })
      .andWhere('is_read = false')
      .execute();
    return this.unreadCount(userId);
  }

  async remove(userId: string, id: string) {
    const msg = await this.findOne(userId, id);
    // Either party can delete from their view (hard delete for v1 simplicity)
    if (msg.senderId !== userId && msg.recipientId !== userId) {
      throw new ForbiddenException('Not allowed');
    }
    await this.messageRepo.remove(msg);
    return { deleted: true };
  }
}
