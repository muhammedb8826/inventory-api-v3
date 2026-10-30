import type { UnitSnapshot } from '../../units/conversion';
import { Column, Entity, JoinColumn, ManyToOne } from 'typeorm';
import { Item } from './item.entity';
import { Sale } from './sale.entity';
import { UuidBaseEntity } from './uuid-base.entity';

@Entity('sale_lines')
export class SaleLine extends UuidBaseEntity {
  @Column({ name: 'sale_id' })
  saleId: string;

  @Column({ name: 'item_id' })
  itemId: string;

  @Column({ type: 'decimal', precision: 14, scale: 3 })
  quantity: string;

  @Column({ name: 'unit_snapshot', type: 'jsonb', nullable: true })
  unitSnapshot: UnitSnapshot | null;

  @Column({ name: 'unit_price', type: 'decimal', precision: 22, scale: 10 })
  unitPrice: string;

  @Column({ name: 'purchase_cost', type: 'decimal', precision: 22, scale: 10 })
  purchaseCost: string;

  @Column({ type: 'decimal', precision: 14, scale: 2 })
  lineTotal: string;

  @ManyToOne(() => Sale, (sale) => sale.lines, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'sale_id' })
  sale: Sale;

  @ManyToOne(() => Item, { eager: true })
  @JoinColumn({ name: 'item_id' })
  item: Item;
}
