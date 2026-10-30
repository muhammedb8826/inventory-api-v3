import type { UnitSnapshot } from '../../units/conversion';
import { Column, Entity, JoinColumn, ManyToOne } from 'typeorm';
import { Item } from './item.entity';
import { StockTransfer } from './stock-transfer.entity';
import { UuidBaseEntity } from './uuid-base.entity';

@Entity('stock_transfer_lines')
export class StockTransferLine extends UuidBaseEntity {
  @Column({ name: 'transfer_id' })
  transferId: string;

  @Column({ name: 'item_id' })
  itemId: string;

  @Column({ type: 'decimal', precision: 14, scale: 3 })
  quantity: string;

  @Column({ name: 'unit_snapshot', type: 'jsonb', nullable: true })
  unitSnapshot: UnitSnapshot | null;

  /** Snapshot of source unit cost when shipped (IN_TRANSIT). */
  @Column({
    name: 'unit_cost',
    type: 'decimal',
    precision: 22,
    scale: 10,
    nullable: true,
  })
  unitCost: string | null;

  @ManyToOne(() => StockTransfer, (transfer) => transfer.lines, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'transfer_id' })
  transfer: StockTransfer;

  @ManyToOne(() => Item, { eager: true })
  @JoinColumn({ name: 'item_id' })
  item: Item;
}
