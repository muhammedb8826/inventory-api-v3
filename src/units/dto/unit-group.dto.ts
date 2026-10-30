import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
} from 'class-validator';
import { UpdateItemConversionsDto } from './item-conversion.dto';
import { UNIT_CATEGORIES } from '../../database/entities/unit-of-measure.entity';
export class SaveUnitGroupDto extends UpdateItemConversionsDto {
  @IsOptional() @IsIn(['CATEGORY', 'PACKAGING']) kind?:
    | 'CATEGORY'
    | 'PACKAGING';
  @IsString() @Length(1, 100) name: string;
  @IsIn(UNIT_CATEGORIES) category: string;
  @IsUUID() baseUnitId: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}
