import { IsNotEmpty, IsString, IsOptional, IsNumber, IsArray, ValidateNested, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { LpgSaleVariant } from '@prisma/client';

export class ReturnItemDto {
  @ApiProperty()
  @IsNotEmpty()
  @IsString()
  productId: string;

  @ApiProperty()
  @IsNotEmpty()
  @IsNumber()
  @Min(1)
  quantity: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  refundAmount?: number;

  @ApiProperty({ enum: LpgSaleVariant, required: false })
  @IsOptional()
  lpgVariant?: LpgSaleVariant;
}

export class CreateReturnDto {
  @ApiProperty()
  @IsNotEmpty({ message: 'Sale ID is required' })
  @IsString()
  saleId: string;

  @ApiProperty()
  @IsNotEmpty({ message: 'Return reason is required' })
  @IsString()
  reason: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  amount?: number;

  @ApiProperty({ type: [ReturnItemDto], required: false })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReturnItemDto)
  items?: ReturnItemDto[];
}