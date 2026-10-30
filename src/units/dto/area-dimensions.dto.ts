import { Type } from 'class-transformer';
import { IsInt, IsNumber, Min } from 'class-validator';
export class AreaDimensionsDto {
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0.001)
  widthMetres: number;
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0.001)
  lengthMetres: number;
  @Type(() => Number) @IsInt() @Min(1) count: number;
}
