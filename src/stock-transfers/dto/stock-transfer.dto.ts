import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';

export class StockTransferLineDto {
  @IsUUID()
  itemId: string;

  @Type(() => Number)
  @IsNumber()
  @Min(0.001)
  quantity: number;
}

export class CreateStockTransferDto {
  @IsUUID()
  fromLocationId: string;

  @IsUUID()
  toLocationId: string;

  @IsOptional()
  @IsString()
  notes?: string;

  /**
   * When true, ship + receive immediately (legacy one-shot).
   * Default false → PENDING with source reservation.
   */
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  shipImmediately?: boolean;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique((line: StockTransferLineDto) => line.itemId)
  @ValidateNested({ each: true })
  @Type(() => StockTransferLineDto)
  lines: StockTransferLineDto[];
}
