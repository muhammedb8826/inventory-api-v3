import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { DateRangeQueryDto } from '../../common/dto/date-range.dto';

export class CreateMessageDto {
  @IsUUID()
  recipientId: string;

  @IsString()
  @MinLength(1)
  @MaxLength(10000)
  body: string;
}

export class MessageListQueryDto extends DateRangeQueryDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  search?: string;

  /** inbox | sent — default inbox */
  @IsOptional()
  @IsIn(['inbox', 'sent'])
  folder?: 'inbox' | 'sent';

  @IsOptional()
  @IsString()
  unreadOnly?: string;
}
