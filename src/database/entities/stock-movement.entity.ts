import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
} from 'typeorm';
import { StockMovementType } from '../../common/enums';
import { Item } from './item.entity';
import { Location } from './location.entity';
import { User } from './user.entity';
import { UuidBaseEntity } from './uuid-base.entity';

@Entity('stock_movements')
@Index(['locationId', 'createdAt'])
@Index(['itemId', 'createdAt'])
@Index(['refType', 'refId'])
@Index(['type', 'createdAt'])
export class StockMovement extends UuidBaseEntity {
  @Column({ name: 'location_id', type: 'uuid' })
  locationId: string;

  @Column({ name: 'item_id', type: 'uuid' })
  itemId: string;

  @Column({
    type: 'enum',
    enum: StockMovementType,
    enumName: 'stock_movements_type_enum',
  })
  type: StockMovementType;

  @Column({
    name: 'quantity_delta',
    type: 'decimal',
    precision: 14,
    scale: 3,
  })
  quantityDelta: string;

  @Column({
    name: 'quantity_before',
    type: 'decimal',
    precision: 14,
    scale: 3,
  })
  quantityBefore: string;

  @Column({
    name: 'quantity_after',
    type: 'decimal',
    precision: 14,
    scale: 3,
  })
  quantityAfter: string;

  @Column({
    name: 'unit_cost',
    type: 'decimal',
    precision: 14,
    scale: 2,
    nullable: true,
  })
  unitCost: string | null;

  @Column({ name: 'ref_type', type: 'varchar', length: 40, nullable: true })
  refType: string | null;

  @Column({ name: 'ref_id', type: 'uuid', nullable: true })
  refId: string | null;

  @Column({ type: 'text', nullable: true })
  notes: string | null;

  @Column({ name: 'created_by_id', type: 'uuid', nullable: true })
  createdById: string | null;

  @ManyToOne(() => Location)
  @JoinColumn({ name: 'location_id' })
  location: Location;

  @ManyToOne(() => Item)
  @JoinColumn({ name: 'item_id' })
  item: Item;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'created_by_id' })
  createdBy: User | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
