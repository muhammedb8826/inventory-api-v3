import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  UpdateDateColumn,
} from 'typeorm';
import { LocationType } from '../../common/enums';
import { StockLevel } from './stock-level.entity';
import { UuidBaseEntity } from './uuid-base.entity';

@Entity('locations')
export class Location extends UuidBaseEntity {
  @Column({ length: 120 })
  name: string;

  @Column({ type: 'enum', enum: LocationType })
  type: LocationType;

  @Column({ type: 'text', nullable: true })
  address: string | null;

  @Column({ name: 'is_active', default: true })
  isActive: boolean;

  /** Parent warehouse/showroom when type is BIN (putaway target). */
  @Column({ name: 'parent_id', type: 'uuid', nullable: true })
  parentId: string | null;

  @ManyToOne(() => Location, (loc) => loc.children, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'parent_id' })
  parent: Location | null;

  @OneToMany(() => Location, (loc) => loc.parent)
  children: Location[];

  @OneToMany(() => StockLevel, (stock) => stock.location)
  stockLevels: StockLevel[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
