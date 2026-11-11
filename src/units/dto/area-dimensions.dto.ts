import { Type } from 'class-transformer';
import { IsInt, IsNumber, IsOptional, Min } from 'class-validator';

/**
 * Cut / piece dimensions in metres.
 * AREA stock: quantity must equal width×length×count (in m² then converted).
 * LENGTH stock (fabric rolls): quantity must equal cut length×count in the
 * selected length unit; width is a characteristic (line or item default).
 */
export class AreaDimensionsDto {
  /** Omit to use the item's defaultWidthMetres (LENGTH fabric). */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0.001)
  widthMetres?: number;
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0.001)
  lengthMetres: number;
  @Type(() => Number) @IsInt() @Min(1) count: number;
}
