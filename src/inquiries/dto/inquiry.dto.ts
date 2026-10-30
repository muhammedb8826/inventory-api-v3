import { ApiPropertyOptional } from '@nestjs/swagger';
import { AreaDimensionsDto } from '../../units/dto/area-dimensions.dto';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEmail,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  ArrayMaxSize,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  InquiryAssignmentStatus,
  InquiryPriority,
  InquirySource,
  InquiryStatus,
} from '../../common/enums';
import { ListQueryDto } from '../../common/dto/list-query.dto';

export class InquiryLineDto {
  @IsOptional() @IsUUID() unitId?: string;
  @IsOptional()
  @ValidateNested()
  @Type(() => AreaDimensionsDto)
  dimensions?: AreaDimensionsDto;
  @IsUUID()
  itemId: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0.001)
  quantity?: number;

  @IsOptional()
  @IsString()
  notes?: string;
}

/** Shared contact + message fields for public and internal create. */
export class CreateInquiryBaseDto {
  @IsString()
  @MinLength(1)
  @MaxLength(150)
  contactName: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  phone?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(150)
  email?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  subject: string;

  @IsOptional()
  @IsString()
  @MaxLength(20000)
  message?: string;
  @IsOptional()
  @IsDateString({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  requestedDeliveryDate?: string;

  /**
   * Preferred: multiple catalog items of interest.
   * Legacy: single `itemId` still accepted and stored as one line.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => InquiryLineDto)
  lines?: InquiryLineDto[];

  /** @deprecated Prefer `lines`. Converted to a single line when `lines` omitted. */
  @IsOptional()
  @IsUUID()
  itemId?: string;
}

/** Website / unauthenticated submission. */
export class PublicCreateInquiryDto extends CreateInquiryBaseDto {}

/** Staff-created inquiry (walk-in / phone). */
export class CreateInquiryDto extends CreateInquiryBaseDto {
  /** Derived from the linked customer or submitting employee for internal requests. */
  @ApiPropertyOptional()
  @IsOptional()
  declare contactName: string;

  /** Generated from requested products when omitted. */
  @ApiPropertyOptional()
  @IsOptional()
  declare subject: string;

  @IsOptional()
  @IsEnum(InquiryPriority)
  priority?: InquiryPriority;

  @IsOptional()
  @IsUUID()
  customerId?: string;

  @IsOptional()
  @IsUUID()
  assignedToUserId?: string;

  @IsOptional()
  @IsString()
  internalNotes?: string;

  @IsOptional()
  @IsDateString()
  followUpAt?: string;
}

export class UpdateInquiryDto {
  @ApiPropertyOptional({
    readOnly: true,
    deprecated: true,
    description:
      'Legacy clients may echo the unchanged link. It cannot be assigned or cleared here.',
  })
  @IsOptional()
  @IsUUID()
  readonly convertedSaleId?: string | null;
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(150)
  contactName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  phone?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v != null && v !== '')
  @IsEmail()
  @MaxLength(150)
  email?: string | null;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  subject?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20000)
  message?: string;

  @IsOptional()
  @IsEnum(InquiryStatus)
  status?: InquiryStatus;

  @IsOptional()
  @IsEnum(InquiryPriority)
  priority?: InquiryPriority;

  @IsOptional()
  @IsUUID()
  customerId?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => InquiryLineDto)
  lines?: InquiryLineDto[];

  /** @deprecated Prefer `lines`. */
  @IsOptional()
  @IsUUID()
  itemId?: string | null;

  @IsOptional()
  @IsUUID()
  assignedToUserId?: string | null;

  @IsOptional()
  @IsString()
  internalNotes?: string | null;

  @IsOptional()
  @IsDateString()
  followUpAt?: string | null;

  @IsOptional()
  @IsDateString({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  requestedDeliveryDate?: string | null;
}

export class InquiryListQueryDto extends ListQueryDto {
  @IsOptional()
  @IsEnum(InquiryStatus)
  status?: InquiryStatus;

  @IsOptional()
  @IsEnum(InquirySource)
  source?: InquirySource;

  @IsOptional()
  @IsEnum(InquiryPriority)
  priority?: InquiryPriority;

  @IsOptional()
  @IsUUID()
  customerId?: string;

  @IsOptional()
  @IsUUID()
  assignedToUserId?: string;

  /** Filter inquiries that include this catalog item on any line. */
  @IsOptional()
  @IsUUID()
  itemId?: string;

  @IsOptional()
  @IsEnum(InquiryAssignmentStatus)
  assignmentStatus?: InquiryAssignmentStatus;
}
