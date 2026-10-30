import { Column, Entity, JoinColumn, ManyToOne } from 'typeorm';
import { Item } from './item.entity';
import { SaleReturn } from './sale-return.entity';
import { UuidBaseEntity } from './uuid-base.entity';

@Entity('sale_return_lines')
export class SaleReturnLine extends UuidBaseEntity {
  @Column({ name: 'return_id' })
  returnId: string;

  @Column({ name: 'sale_line_id', type: 'uuid', nullable: true })
  saleLineId: string | null;

  @Column({ name: 'item_id' })
  itemId: string;

  @Column({ type: 'decimal', precision: 14, scale: 3 })
  quantity: string;

  @Column({ name: 'unit_price', type: 'decimal', precision: 22, scale: 10 })
  unitPrice: string;

  @ManyToOne(() => SaleReturn, (ret) => ret.lines, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'return_id' })
  saleReturn: SaleReturn;

  @ManyToOne(() => Item, { eager: true })
  @JoinColumn({ name: 'item_id' })
  item: Item;
}
