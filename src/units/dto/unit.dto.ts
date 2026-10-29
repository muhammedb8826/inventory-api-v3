import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import { PartialType } from '@nestjs/mapped-types';
import {
  UNIT_CATEGORIES,
  type UnitCategory,
} from '../../database/entities/unit-of-measure.entity';
export class CreateUnitDto {
  @IsString() @Matches(/^[A-Z][A-Z0-9_-]{0,39}$/) code: string;
  @IsString() @Length(1, 100) name: string;
  @IsString() @Length(1, 40) symbol: string;
  @IsIn(UNIT_CATEGORIES) category: UnitCategory;
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Matches(/^[A-Z0-9]{3}$/)
  uneceCode?: string | null;
  @IsInt() @Min(0) @Max(3) decimalPlaces: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
}
export class UpdateUnitDto extends PartialType(CreateUnitDto) {
  @IsOptional() @IsBoolean() confirmLegacyReview?: boolean;
}
