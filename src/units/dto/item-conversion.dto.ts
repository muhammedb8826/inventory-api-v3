import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsNumber,
  IsOptional,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
export class ItemConversionDto {
  @IsUUID() unitId: string;
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 10 })
  @Min(0.0000000001)
  @Max(1000000000)
  factor?: number;
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0.001)
  @Max(1000000000)
  stockQuantity?: number;
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0.001)
  @Max(1000000000)
  unitQuantity?: number;
  @IsOptional() @IsBoolean() purchaseDefault?: boolean;
  @IsOptional() @IsBoolean() salesDefault?: boolean;
}
export class UpdateItemConversionsDto {
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ItemConversionDto)
  conversions: ItemConversionDto[];
}
