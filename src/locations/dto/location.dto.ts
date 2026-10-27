import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  ValidateIf,
} from 'class-validator';
import { LocationType } from '../../common/enums';

export class CreateLocationDto {
  @IsString()
  name: string;

  @IsEnum(LocationType)
  type: LocationType;

  @IsOptional()
  @IsString()
  address?: string;

  /** Required when type is BIN (parent warehouse/showroom). */
  @ValidateIf((o: CreateLocationDto) => o.type === LocationType.BIN)
  @IsUUID()
  parentId?: string;
}

export class UpdateLocationDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsEnum(LocationType)
  type?: LocationType;

  @IsOptional()
  @IsString()
  address?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  parentId?: string | null;
}
