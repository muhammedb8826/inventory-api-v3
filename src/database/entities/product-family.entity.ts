import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  UpdateDateColumn,
} from 'typeorm';
import { ItemType } from '../../common/enums';
import { UnitGroup } from './unit-group.entity';
import { UnitOfMeasure } from './unit-of-measure.entity';
import { UuidBaseEntity } from './uuid-base.entity';

export interface FamilyAttribute {
  attributeId: string;
  values: string[];
}
export interface VariantValue {
  attributeId: string;
  name: string;
  value: string;
}

@Entity('product_families')
export class ProductFamily extends UuidBaseEntity {
  @Column({ length: 160 }) name: string;
  @Column({ type: 'text', default: '' }) description: string;
  @Column({
    name: 'item_type',
    type: 'enum',
    enum: ItemType,
    enumName: 'items_item_type_enum',
    default: ItemType.FINISHED,
  })
  itemType: ItemType;
  @Column({ name: 'unit_id', type: 'uuid' }) unitId: string;
  @ManyToOne(() => UnitOfMeasure, { eager: true })
  @JoinColumn({ name: 'unit_id' })
  stockUnit: UnitOfMeasure;
  @Column({ name: 'unit_group_id', type: 'uuid', nullable: true }) unitGroupId:
    | string
    | null;
  @ManyToOne(() => UnitGroup, { eager: true, nullable: true })
  @JoinColumn({ name: 'unit_group_id' })
  unitGroup: UnitGroup | null;
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  attributes: FamilyAttribute[];
  @Column({ name: 'is_active', default: true }) isActive: boolean;
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt: Date;
}
