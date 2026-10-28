import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  UpdateDateColumn,
} from 'typeorm';
import { ItemType } from '../../common/enums';
import { StockLevel } from './stock-level.entity';
import { UuidBaseEntity } from './uuid-base.entity';

@Entity('items')
@Index('UQ_items_sku_not_null', ['sku'], {
  unique: true,
  where: '"sku" IS NOT NULL',
})
@Index('UQ_items_barcode_not_null', ['barcode'], {
  unique: true,
  where: '"barcode" IS NOT NULL',
})
export class Item extends UuidBaseEntity {
  /** Unique when set (partial unique index `UQ_items_sku_not_null`). */
  @Column({ type: 'varchar', length: 80, nullable: true })
  sku: string | null;

  /** Unique when set (scan / POS lookup). */
  @Column({ type: 'varchar', length: 80, nullable: true })
  barcode: string | null;

  @Column({ type: 'text' })
  description: string;

  @Column({ type: 'varchar', length: 40, nullable: true })
  unit: string | null;

  @Column({
    name: 'item_type',
    type: 'enum',
    enum: ItemType,
    enumName: 'items_item_type_enum',
    default: ItemType.OTHER,
  })
  itemType: ItemType;

  /**
   * Phantom item: when used as a BOM component, requirements pass through to its
   * default BOM (unless the BOM line overrides isPhantom).
   */
  @Column({ name: 'is_phantom', default: false })
  isPhantom: boolean;

  /** Relative path e.g. `/uploads/items/item-….webp`. */
  @Column({ name: 'image_path', type: 'varchar', length: 500, nullable: true })
  imagePath: string | null;

  /** Absolute (or relative) URL for API clients — set in service, not persisted. */
  imageUrl?: string | null;

  @Column({ name: 'is_active', default: true })
  isActive: boolean;

  @OneToMany(() => StockLevel, (stock) => stock.item)
  stockLevels: StockLevel[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
