import { Transform, Type } from 'class-transformer';
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
import { resolveLineItemIdFromPayload } from '../../common/utils/line-item-id.util';

export class SaleLineDto {
  @Transform(({ obj }) =>
    resolveLineItemIdFromPayload(obj as Record<string, unknown>),
  )
  @IsUUID('4', {
    message:
      'itemId must be a product UUID — use inventory.itemId or item.id from GET /inventory',
  })
  itemId: string;

  @Type(() => Number)
  @IsNumber()
  @Min(0.001)
  quantity: number;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  unitPrice: number;

  /** Optional lot; when omitted issues use FEFO if lots exist. */
  @IsOptional()
  @IsString()
  lotNumber?: string;
}

export class CreateSaleDto {
  @IsOptional()
  @EmptyToUndefined()
  @IsUUID()
  customerId?: string;

  /** Close the MTO loop: sale from this inquiry. */
  @IsOptional()
  @EmptyToUndefined()
  @IsUUID()
  inquiryId?: string;

  /** Prefer FG from this completed production order. */
  @IsOptional()
  @EmptyToUndefined()
  @IsUUID()
  productionOrderId?: string;

  @IsUUID()
  locationId: string;

  @IsEnum(PaymentMethod)
  paymentMethod: PaymentMethod;

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

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => SaleLineDto)
  lines: SaleLineDto[];
}
