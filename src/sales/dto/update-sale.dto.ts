import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { PaymentMethod, CommissionBasis } from '../../common/enums';
import { EmptyToUndefined } from '../../common/transforms/empty-to-undefined';
import { SaleLineDto } from './sale.dto';

export class UpdateSaleDto {
  @IsOptional()
  @EmptyToUndefined()
  @IsUUID()
  customerId?: string;

  @IsOptional()
  @EmptyToUndefined()
  @IsUUID()
  locationId?: string;

  @IsOptional()
  @IsEnum(PaymentMethod)
  paymentMethod?: PaymentMethod;

  @IsOptional()
  @EmptyToUndefined()
  @IsUUID()
  bankAccountId?: string;

  @IsOptional()
  @IsBoolean()
  allowNegativeStock?: boolean;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsDateString()
  creditDueDate?: string;

  @IsOptional()
  @EmptyToUndefined()
  @IsUUID()
  soldByUserId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  commissionPercent?: number;

  @IsOptional()
  @IsEnum(CommissionBasis)
  commissionBasis?: CommissionBasis;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => SaleLineDto)
  lines?: SaleLineDto[];
}
