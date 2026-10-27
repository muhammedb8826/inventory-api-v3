import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';

export class CreateStocktakeDto {
  @IsUUID()
  locationId: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class StocktakeCountLineDto {
  @IsUUID()
  itemId: string;

  @IsNumber()
  @Min(0)
  countedQty: number;
}

export class SubmitStocktakeCountsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => StocktakeCountLineDto)
  lines: StocktakeCountLineDto[];
}
