import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  UpdateDateColumn,
} from 'typeorm';
import { Item } from './item.entity';
import { BomLine } from './bom-line.entity';
import { UuidBaseEntity } from './uuid-base.entity';

@Entity('boms')
export class Bom extends UuidBaseEntity {
  @Column({ name: 'finished_item_id', type: 'uuid' })
  finishedItemId: string;

  @Column({ length: 120 })
  name: string;

  @Column({ type: 'varchar', length: 40, nullable: true })
  version: string | null;

  @Column({ name: 'is_active', default: true })
  isActive: boolean;

  /** Only one active default BOM per finished item. */
  @Column({ name: 'is_default', default: false })
  isDefault: boolean;

  /** Expected yield % of finished output (100 = no loss). */
  @Column({
    name: 'yield_percent',
    type: 'decimal',
    precision: 7,
    scale: 2,
    default: 100,
  })
  yieldPercent: string;

  @Column({ name: 'effective_from', type: 'date', nullable: true })
  effectiveFrom: string | null;

  @Column({ name: 'effective_to', type: 'date', nullable: true })
  effectiveTo: string | null;

  @Column({ name: 'revised_from_id', type: 'uuid', nullable: true })
  revisedFromId: string | null;

  @Column({ type: 'text', nullable: true })
  notes: string | null;

  @ManyToOne(() => Item)
  @JoinColumn({ name: 'finished_item_id' })
  finishedItem: Item;

  @ManyToOne(() => Bom, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'revised_from_id' })
  revisedFrom: Bom | null;

  @OneToMany(() => BomLine, (line) => line.bom, { cascade: true })
  lines: BomLine[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
