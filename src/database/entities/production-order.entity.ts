import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  UpdateDateColumn,
} from 'typeorm';
import { ProductionOrderStatus } from '../../common/enums';
import { Bom } from './bom.entity';
import { CustomerInquiry } from './customer-inquiry.entity';
import { Item } from './item.entity';
import { Location } from './location.entity';
import { ProductionOrderLine } from './production-order-line.entity';
import { Sale } from './sale.entity';
import { User } from './user.entity';
import { UuidBaseEntity } from './uuid-base.entity';

@Entity('production_orders')
export class ProductionOrder extends UuidBaseEntity {
  @Column({ name: 'order_number', type: 'varchar', length: 40, nullable: true })
  orderNumber: string | null;

  @Column({ name: 'bom_id', type: 'uuid' })
  bomId: string;

  @Column({ name: 'finished_item_id', type: 'uuid' })
  finishedItemId: string;

  /** Originating customer inquiry (MTO spine). */
  @Column({ name: 'inquiry_id', type: 'uuid', nullable: true })
  inquiryId: string | null;

  /** Optional sales order / sale this production fulfills. */
  @Column({ name: 'sale_id', type: 'uuid', nullable: true })
  saleId: string | null;

  /** Component issue location. */
  @Column({ name: 'location_id', type: 'uuid' })
  locationId: string;

  /** Finished-goods receipt location (defaults to component location). */
  @Column({ name: 'finished_location_id', type: 'uuid', nullable: true })
  finishedLocationId: string | null;

  @Column({
    name: 'quantity_planned',
    type: 'decimal',
    precision: 14,
    scale: 3,
  })
  quantityPlanned: string;

  @Column({
    name: 'quantity_completed',
    type: 'decimal',
    precision: 14,
    scale: 3,
    default: 0,
  })
  quantityCompleted: string;

  @Column({
    name: 'quantity_scrapped',
    type: 'decimal',
    precision: 14,
    scale: 3,
    default: 0,
  })
  quantityScrapped: string;

  @Column({
    type: 'enum',
    enum: ProductionOrderStatus,
    enumName: 'production_orders_status_enum',
    default: ProductionOrderStatus.DRAFT,
  })
  status: ProductionOrderStatus;

  /** True after release reserved component qty. */
  @Column({ name: 'materials_reserved', default: false })
  materialsReserved: boolean;

  @Column({ type: 'text', nullable: true })
  notes: string | null;

  @Column({ name: 'created_by_id', type: 'uuid', nullable: true })
  createdById: string | null;

  @Column({ name: 'released_at', type: 'timestamptz', nullable: true })
  releasedAt: Date | null;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt: Date | null;

  @ManyToOne(() => Bom)
  @JoinColumn({ name: 'bom_id' })
  bom: Bom;

  @ManyToOne(() => Item)
  @JoinColumn({ name: 'finished_item_id' })
  finishedItem: Item;

  @ManyToOne(() => CustomerInquiry, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'inquiry_id' })
  inquiry: CustomerInquiry | null;

  @ManyToOne(() => Sale, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'sale_id' })
  sale: Sale | null;

  @ManyToOne(() => Location)
  @JoinColumn({ name: 'location_id' })
  location: Location;

  @ManyToOne(() => Location, { nullable: true })
  @JoinColumn({ name: 'finished_location_id' })
  finishedLocation: Location | null;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'created_by_id' })
  createdBy: User | null;

  @OneToMany(() => ProductionOrderLine, (line) => line.productionOrder, {
    cascade: true,
  })
  lines: ProductionOrderLine[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
