import { Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { Location } from './location.entity';
import { User } from './user.entity';

@Entity('user_locations')
export class UserLocation {
  @PrimaryColumn({ name: 'user_id', type: 'uuid' })
  userId: string;

  @PrimaryColumn({ name: 'location_id', type: 'uuid' })
  locationId: string;

  @ManyToOne(() => User, (u) => u.userLocations, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @ManyToOne(() => Location, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'location_id' })
  location: Location;
}
