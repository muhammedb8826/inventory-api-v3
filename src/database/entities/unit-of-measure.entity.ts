import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  UpdateDateColumn,
} from 'typeorm';
import { UuidBaseEntity } from './uuid-base.entity';
export const UNIT_CATEGORIES = [
  'COUNT',
  'LENGTH',
  'AREA',
  'VOLUME',
  'MASS',
  'TIME',
  'OTHER',
] as const;
export type UnitCategory = (typeof UNIT_CATEGORIES)[number];
@Entity('units_of_measure')
@Check('unit_precision', 'decimal_places BETWEEN 0 AND 3')
@Check(
  'unit_category',
  "category IN ('COUNT','LENGTH','AREA','VOLUME','MASS','TIME','OTHER')",
)
export class UnitOfMeasure extends UuidBaseEntity {
  @Index({ unique: true })
  @Column({ length: 40 })
  code: string;
  @Column({ length: 100 }) name: string;
  @Column({ length: 40 }) symbol: string;
  @Column({ type: 'varchar', length: 20 }) category: UnitCategory;
  @Column({ name: 'unece_code', type: 'varchar', length: 3, nullable: true })
  uneceCode: string | null;
  @Column({ name: 'decimal_places', type: 'smallint', default: 3 })
  decimalPlaces: number;
  @Column({ name: 'is_active', default: true }) isActive: boolean;
  @Column({ name: 'requires_review', default: false }) requiresReview: boolean;
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt: Date;
}
