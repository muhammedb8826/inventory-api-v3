import { Location } from './location.entity';
import { Sale } from './sale.entity';
import { User } from './user.entity';
import {
  Check,
  Index,
  ManyToOne,
  JoinColumn,
  Column,
  CreateDateColumn,
  Entity,
  UpdateDateColumn,
} from 'typeorm';
import { UuidBaseEntity } from './uuid-base.entity';
import type { CreateSaleDto } from '../../sales/dto/sale.dto';
import type { UnitSnapshot } from '../../units/conversion';

export type OrderState =
  | 'DRAFT'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'CONFIRMED'
  | 'DELIVERED'
  | 'CANCELLED';
export interface OrderLineSnapshot {
  itemId: string;
  quantity: number;
  unitPrice: number;
  unitSnapshot: UnitSnapshot | null;
}
@Check(
  'sales_orders_state_check',
  `state IN ('DRAFT','PENDING_APPROVAL','APPROVED','CONFIRMED','DELIVERED','CANCELLED')`,
)
@Index('sales_orders_sale_id_key', ['saleId'], { unique: true })
@Entity('sales_orders')
export class SalesOrder extends UuidBaseEntity {
  @ManyToOne(() => Location)
  @JoinColumn({ name: 'location_id' })
  location: Location;
  @ManyToOne(() => Sale, { nullable: true })
  @JoinColumn({ name: 'sale_id' })
  sale: Sale | null;
  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: 'created_by_id' })
  createdBy: User | null;
  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: 'approved_by_id' })
  approvedBy: User | null;
  @Column({ type: 'varchar', default: 'DRAFT' }) state: OrderState;
  @Column({ name: 'location_id', type: 'uuid' }) locationId: string;
  @Column({ type: 'jsonb' }) payload: CreateSaleDto;
  @Column({
    name: 'normalized_lines',
    type: 'jsonb',
    default: () => "'[]'::jsonb",
  })
  normalizedLines: OrderLineSnapshot[];
  @Column({
    name: 'price_exceptions',
    type: 'jsonb',
    default: () => "'[]'::jsonb",
  })
  priceExceptions: string[];
  @Column({ type: 'numeric', precision: 14, scale: 2, default: 0 })
  total: string;
  @Column({ name: 'sale_id', type: 'uuid', nullable: true }) saleId:
    | string
    | null;
  @Column({ name: 'created_by_id', type: 'uuid', nullable: true }) createdById:
    | string
    | null;
  @Column({ name: 'approved_by_id', type: 'uuid', nullable: true })
  approvedById: string | null;
  @Column({ name: 'approved_at', type: 'timestamptz', nullable: true })
  approvedAt: Date | null;
  @Column({ name: 'approval_note', type: 'text', nullable: true })
  approvalNote: string | null;
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" }) history: {
    action: string;
    actorId: string;
    at: string;
    note?: string;
  }[];
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt: Date;
}
