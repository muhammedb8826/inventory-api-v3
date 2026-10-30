import { AreaDimensionsDto } from '../../units/dto/area-dimensions.dto';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';
import { PaymentMethod } from '../../common/enums';
import { EmptyToUndefined } from '../../common/transforms/empty-to-undefined';
import { resolveLineItemIdFromPayload } from '../../common/utils/line-item-id.util';

export class PurchaseLineDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => AreaDimensionsDto)
  dimensions?: AreaDimensionsDto;
  @IsOptional()
  @IsUUID()
  unitId?: string;

  @Transform(({ obj }) =>
    resolveLineItemIdFromPayload(obj as Record<string, unknown>),
  )
  @IsUUID('4', {
    message:
      'itemId must be a product UUID — use inventory.itemId or item.id from GET /inventory, not the stock row id alone unless it is the item id',
  })
  itemId: string;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0.001)
  quantity: number;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  unitPrice: number;

  @IsOptional()
  @IsString()
  lotNumber?: string;

  @IsOptional()
  @IsDateString()
  expiryDate?: string;
}

export class CreatePurchaseDto {
  @IsUUID()
  supplierId: string;

  @IsUUID()
  locationId: string;

  @IsEnum(PaymentMethod)
  paymentMethod: PaymentMethod;

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

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PurchaseLineDto)
  lines: PurchaseLineDto[];
}
