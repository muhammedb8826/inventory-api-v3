import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ProductionOrderStatus } from '../../common/enums';
import { DateRangeQueryDto } from '../../common/dto/date-range.dto';

export class CreateProductionOrderDto {
  @IsUUID()
  bomId: string;

  /** Component issue location. */
  @IsUUID()
  locationId: string;

  /** FG receipt location; defaults to locationId. */
  @IsOptional()
  @IsUUID()
  finishedLocationId?: string;

  @Type(() => Number)
  @IsNumber()
  @Min(0.001)
  quantityPlanned: number;

  /**
   * Force-explode all SEMI/FINISHED components to leaves (ignore phantom flags).
   * Default false: industry behavior — explode only phantom components;
   * stocked SEMIs are issued as-is.
   */
  @IsOptional()
  @IsBoolean()
  explodeBom?: boolean;

  /** Link to customer inquiry (MTO spine). */
  @IsOptional()
  @IsUUID()
  inquiryId?: string;

  /** Link to an existing sale this production fulfills. */
  @IsOptional()
  @IsUUID()
  saleId?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

/** Create PO from an accepted inquiry (resolves BOM from item if omitted). */
export class StartProductionFromInquiryDto {
  @IsUUID()
  inquiryId: string;

  @IsUUID()
  locationId: string;

  @IsOptional()
  @IsUUID()
  finishedLocationId?: string;

  /** Inquiry line item to produce; defaults to first line. */
  @IsOptional()
  @IsUUID()
  itemId?: string;

  /** Defaults to the item's default active BOM. */
  @IsOptional()
  @IsUUID()
  bomId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.001)
  quantityPlanned?: number;

  @IsOptional()
  @IsBoolean()
  explodeBom?: boolean;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class IssueProductionLineDto {
  @IsUUID()
  componentItemId: string;

  @Type(() => Number)
  @IsNumber()
  @Min(0.001)
  quantity: number;
}

export class IssueProductionDto {
  /** If omitted, issues all remaining required material. */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => IssueProductionLineDto)
  lines?: IssueProductionLineDto[];
}

export class CompleteProductionDto {
  @Type(() => Number)
  @IsNumber()
  @Min(0.001)
  quantity: number;

  /** If true, auto-issue any missing materials needed for this completion qty. Default true. */
  @IsOptional()
  @IsBoolean()
  autoIssue?: boolean;
}

export class UnbuildProductionDto {
  @Type(() => Number)
  @IsNumber()
  @Min(0.001)
  quantity: number;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class ScrapProductionDto {
  @Type(() => Number)
  @IsNumber()
  @Min(0.001)
  quantity: number;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class ProductionOrderListQueryDto extends DateRangeQueryDto {
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @IsOptional()
  @IsUUID()
  finishedItemId?: string;

  @IsOptional()
  @IsUUID()
  bomId?: string;

  @IsOptional()
  @IsUUID()
  inquiryId?: string;

  @IsOptional()
  @IsUUID()
  saleId?: string;

  @IsOptional()
  @IsEnum(ProductionOrderStatus)
  status?: ProductionOrderStatus;

  @IsOptional()
  @IsString()
  @MinLength(1)
  search?: string;
}
