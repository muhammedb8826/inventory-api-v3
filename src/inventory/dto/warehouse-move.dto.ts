import { Type } from 'class-transformer';
import {
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';

/** Putaway: move stock into a BIN. Pick: move stock out of a BIN. */
export class WarehouseMoveDto {
  @IsUUID()
  fromLocationId: string;

  @IsUUID()
  toLocationId: string;

  @IsUUID()
  itemId: string;

  @Type(() => Number)
  @IsNumber()
  @Min(0.001)
  quantity: number;

  @IsOptional()
  @IsString()
  lotNumber?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class LotListQueryDto {
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @IsOptional()
  @IsUUID()
  itemId?: string;

  /** ISO date — lots expiring on or before this date. */
  @IsOptional()
  @IsString()
  expiringBefore?: string;
}
