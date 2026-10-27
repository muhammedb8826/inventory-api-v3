import { IsEnum, IsOptional, IsString, IsUUID, MinLength } from 'class-validator';
import { StockMovementType } from '../../common/enums';
import { DateRangeQueryDto } from '../../common/dto/date-range.dto';

export class StockMovementListQueryDto extends DateRangeQueryDto {
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @IsOptional()
  @IsUUID()
  itemId?: string;

  @IsOptional()
  @IsEnum(StockMovementType)
  type?: StockMovementType;

  @IsOptional()
  @IsString()
  @MinLength(1)
  refType?: string;

  @IsOptional()
  @IsUUID()
  refId?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  search?: string;
}
