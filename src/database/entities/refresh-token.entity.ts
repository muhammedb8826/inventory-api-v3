import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
} from 'typeorm';
import { User } from './user.entity';
import { UuidBaseEntity } from './uuid-base.entity';

@Entity('refresh_tokens')
export class RefreshToken extends UuidBaseEntity {
  @Column({ name: 'user_id' })
  userId: string;

  /** SHA-256 hex of the refresh JWT — never store the raw token. */
  @Column({ name: 'token_hash', length: 64 })
  tokenHash: string;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  @Column({ name: 'is_revoked', default: false })
  isRevoked: boolean;

  @ManyToOne(() => User, (user) => user.refreshTokens, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
