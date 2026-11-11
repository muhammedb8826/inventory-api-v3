import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  UpdateDateColumn,
} from 'typeorm';
import { Item } from './item.entity';
import { Location } from './location.entity';
import { UuidBaseEntity } from './uuid-base.entity';

@Entity('stock_lots')
@Index(['locationId', 'itemId', 'lotNumber'], { unique: true })
export class StockLot extends UuidBaseEntity {
  @Column({ name: 'location_id', type: 'uuid' })
  locationId: string;

  @ManyToOne(() => Location, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'location_id' })
  location: Location;

  @Column({ name: 'item_id', type: 'uuid' })
  itemId: string;

  @ManyToOne(() => Item, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'item_id' })
  item: Item;

  @Column({ name: 'lot_number', length: 80 })
  lotNumber: string;

  @Column({ name: 'expiry_date', type: 'date', nullable: true })
  expiryDate: string | null;

  /** Actual roll usable width (m); overrides item default when set. */
  @Column({
    name: 'width_metres',
    type: 'numeric',
    precision: 14,
    scale: 3,
    nullable: true,
  })
  widthMetres: string | null;

  /** Dye-lot / shade band for textile matching. */
  @Column({ type: 'varchar', length: 80, nullable: true })
  shade: string | null;

  @Column({ type: 'numeric', precision: 14, scale: 3, default: 0 })
  quantity: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
