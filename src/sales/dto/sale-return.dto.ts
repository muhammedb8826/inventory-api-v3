import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';

export class SaleReturnLineDto {
  @IsOptional() @IsUUID() unitId?: string;
  @IsUUID()
  saleLineId: string;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0.001)
  quantity: number;
}

export class CreateSaleReturnDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique((line: SaleReturnLineDto) => line.saleLineId)
  @ValidateNested({ each: true })
  @Type(() => SaleReturnLineDto)
  lines: SaleReturnLineDto[];

  @IsOptional()
  @IsUUID()
  bankAccountId?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}
