import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  UpdateDateColumn,
} from 'typeorm';
import { UuidBaseEntity } from './uuid-base.entity';
import { UnitOfMeasure } from './unit-of-measure.entity';
import type { ItemConversion } from '../../units/conversion';
@Entity('unit_groups')
export class UnitGroup extends UuidBaseEntity {
  @Column({ length: 100, unique: true }) name: string;
  @Column({ length: 20 }) category: string;
  @Column({ type: 'varchar', length: 20, default: 'CATEGORY' }) kind:
    | 'CATEGORY'
    | 'PACKAGING';
  @Column({ name: 'base_unit_id', type: 'uuid' }) baseUnitId: string;
  @ManyToOne(() => UnitOfMeasure, { eager: true })
  @JoinColumn({ name: 'base_unit_id' })
  baseUnit: UnitOfMeasure;
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  conversions: ItemConversion[];
  @Column({ name: 'is_active', default: true }) isActive: boolean;
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt: Date;
}
