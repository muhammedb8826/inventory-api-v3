import { Location } from './location.entity';
import { Purchase } from './purchase.entity';
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
import type { CreatePurchaseDto } from '../../purchases/dto/purchase.dto';
import type { OrderLineSnapshot } from './sales-order.entity';
@Check(
  'purchase_orders_state_check',
  `state IN ('DRAFT','CONFIRMED','RECEIVED','CANCELLED')`,
)
@Index('purchase_orders_purchase_id_key', ['purchaseId'], { unique: true })
@Entity('purchase_orders')
export class PurchaseOrder extends UuidBaseEntity {
  @ManyToOne(() => Location)
  @JoinColumn({ name: 'location_id' })
  location: Location;
  @ManyToOne(() => Purchase, { nullable: true })
  @JoinColumn({ name: 'purchase_id' })
  purchase: Purchase | null;
  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: 'created_by_id' })
  createdBy: User | null;
  @Column({ type: 'varchar', default: 'DRAFT' }) state:
    | 'DRAFT'
    | 'CONFIRMED'
    | 'RECEIVED'
    | 'CANCELLED';
  @Column({ name: 'location_id', type: 'uuid' }) locationId: string;
  @Column({ type: 'jsonb' }) payload: CreatePurchaseDto;
  @Column({
    name: 'normalized_lines',
    type: 'jsonb',
    default: () => "'[]'::jsonb",
  })
  normalizedLines: (OrderLineSnapshot & {
    lotNumber?: string;
    expiryDate?: string;
    lotWidthMetres?: number;
    lotShade?: string;
  })[];
  @Column({ type: 'numeric', precision: 14, scale: 2, default: 0 })
  total: string;
  @Column({ name: 'purchase_id', type: 'uuid', nullable: true }) purchaseId:
    | string
    | null;
  @Column({ name: 'created_by_id', type: 'uuid', nullable: true }) createdById:
    | string
    | null;
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" }) history: {
    action: string;
    actorId: string;
    at: string;
  }[];
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt: Date;
}
