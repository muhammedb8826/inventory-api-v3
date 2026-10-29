import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { PaymentMethod } from '../../common/enums';
import { EmptyToUndefined } from '../../common/transforms/empty-to-undefined';
import { PurchaseLineDto } from './purchase.dto';

export class UpdatePurchaseDto {
  @IsOptional()
  @EmptyToUndefined()
  @IsUUID()
  supplierId?: string;

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
  @IsString()
  notes?: string;

  @IsOptional()
  @IsDateString()
  creditDueDate?: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PurchaseLineDto)
  lines?: PurchaseLineDto[];
}
