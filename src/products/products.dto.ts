import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { ItemType } from '../common/enums';

export class SaveAttributeDto {
  @IsString() @IsNotEmpty() @MaxLength(80) name: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  values: string[];
  @IsOptional() @IsBoolean() isActive?: boolean;
}
export class FamilyAttributeDto {
  @IsUUID() attributeId: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  values: string[];
}
export class SaveFamilyDto {
  @IsString() @IsNotEmpty() @MaxLength(160) name: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsEnum(ItemType) itemType: ItemType;
  @IsUUID() unitId: string;
  @IsOptional() @IsUUID() unitGroupId?: string | null;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(8)
  @ValidateNested({ each: true })
  @Type(() => FamilyAttributeDto)
  attributes: FamilyAttributeDto[];
  @IsOptional() @IsBoolean() isActive?: boolean;
}
export class VariantSelectionDto {
  @IsUUID() attributeId: string;
  @IsString() @IsNotEmpty() @MaxLength(80) value: string;
}
export class CreateVariantDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(8)
  @ValidateNested({ each: true })
  @Type(() => VariantSelectionDto)
  values: VariantSelectionDto[];
  @IsOptional() @IsString() @MaxLength(80) sku?: string;
  @IsOptional() @IsString() @MaxLength(80) barcode?: string;
  @IsOptional() @IsUUID() existingItemId?: string;
}
export class CreateVariantsDto {
  @IsUUID() locationId: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CreateVariantDto)
  variants: CreateVariantDto[];
}
export class VariantStatusDto {
  @IsBoolean() isActive: boolean;
}
export class ProductCatalogQueryDto {
  @IsOptional() @IsString() @MaxLength(100) q?: string;
}
