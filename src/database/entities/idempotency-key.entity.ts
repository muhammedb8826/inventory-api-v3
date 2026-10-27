import { Column, CreateDateColumn, Entity, Index, Unique } from 'typeorm';
import { UuidBaseEntity } from './uuid-base.entity';

@Entity('idempotency_keys')
@Unique('UQ_idempotency_keys_scope', ['key', 'userId', 'method', 'route'])
@Index('IDX_idempotency_keys_created', ['createdAt'])
export class IdempotencyKey extends UuidBaseEntity {
  @Column({ type: 'varchar', length: 128 })
  key: string;

  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId: string | null;

  @Column({ type: 'varchar', length: 16 })
  method: string;

  @Column({ type: 'varchar', length: 200 })
  route: string;

  @Column({ name: 'status_code', type: 'int' })
  statusCode: number;

  @Column({ name: 'response_body', type: 'jsonb', nullable: true })
  responseBody: unknown;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
