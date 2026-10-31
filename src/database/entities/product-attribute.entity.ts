import { Column, CreateDateColumn, Entity, UpdateDateColumn } from 'typeorm';
import { UuidBaseEntity } from './uuid-base.entity';

@Entity('product_attributes')
export class ProductAttribute extends UuidBaseEntity {
  @Column({ length: 80, unique: true }) name: string;
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" }) values: string[];
  @Column({ name: 'is_active', default: true }) isActive: boolean;
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt: Date;
}
