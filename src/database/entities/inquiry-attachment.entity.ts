import { ApiHideProperty } from '@nestjs/swagger';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
} from 'typeorm';
import { UuidBaseEntity } from './uuid-base.entity';
import { CustomerInquiry } from './customer-inquiry.entity';
@Entity('inquiry_attachments')
@Index(['inquiryId', 'hash'], { unique: true })
export class InquiryAttachment extends UuidBaseEntity {
  @Column({ name: 'inquiry_id', type: 'uuid' }) inquiryId: string;
  @Column({ length: 150 }) name: string;
  @Column({ length: 80 }) mime: string;
  @Column({ type: 'integer' }) size: number;
  @ApiHideProperty()
  @Column({ length: 64, select: false })
  hash: string;
  @ApiHideProperty()
  @Column({ type: 'bytea', select: false })
  data: Buffer;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
  @ApiHideProperty()
  @ManyToOne(() => CustomerInquiry, (inquiry) => inquiry.attachments, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'inquiry_id' })
  inquiry: CustomerInquiry;
}
