import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Item } from './item.entity';
import { Stocktake } from './stocktake.entity';

@Entity('stocktake_lines')
export class StocktakeLine {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'stocktake_id', type: 'uuid' })
  stocktakeId: string;

  @ManyToOne(() => Stocktake, (s) => s.lines, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'stocktake_id' })
  stocktake: Stocktake;

  @Column({ name: 'item_id', type: 'uuid' })
  itemId: string;

  @ManyToOne(() => Item, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'item_id' })
  item: Item;

  @Column({
    name: 'system_qty',
    type: 'numeric',
    precision: 14,
    scale: 3,
  })
  systemQty: string;

  @Column({
    name: 'counted_qty',
    type: 'numeric',
    precision: 14,
    scale: 3,
    nullable: true,
  })
  countedQty: string | null;
}
