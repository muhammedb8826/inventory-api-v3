import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  UpdateDateColumn,
} from 'typeorm';
import { DocumentStatus } from '../../common/enums';
import { Location } from './location.entity';
import { Sale } from './sale.entity';
import { SaleReturnLine } from './sale-return-line.entity';
import { User } from './user.entity';
import { UuidBaseEntity } from './uuid-base.entity';

@Entity('sale_returns')
export class SaleReturn extends UuidBaseEntity {
  @Column({ name: 'sale_id' })
  saleId: string;

  @Column({ name: 'location_id' })
  locationId: string;

  @Column({ type: 'text', nullable: true })
  notes: string | null;

  @Column({
    type: 'varchar',
    length: 20,
    default: DocumentStatus.ACTIVE,
  })
  status: DocumentStatus;

  @Column({ name: 'created_by_id', type: 'uuid', nullable: true })
  createdById: string | null;

  @ManyToOne(() => Sale)
  @JoinColumn({ name: 'sale_id' })
  sale: Sale;

  @ManyToOne(() => Location)
  @JoinColumn({ name: 'location_id' })
  location: Location;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'created_by_id' })
  createdBy: User | null;

  @OneToMany(() => SaleReturnLine, (line) => line.saleReturn, {
    cascade: true,
    eager: true,
  })
  lines: SaleReturnLine[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
