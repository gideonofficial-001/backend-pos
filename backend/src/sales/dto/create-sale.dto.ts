import { IsNotEmpty, IsString, IsOptional, IsEnum, IsNumber, IsArray, ValidateNested, Min, IsBoolean } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { SaleType, PaymentProvider, LpgSaleVariant } from '@prisma/client';

class SaleItemDto {
  @ApiProperty()
  @IsNotEmpty()
  @IsString()
  productId: string;

  @ApiProperty()
  @IsNotEmpty()
  @IsNumber()
  @Min(1)
  quantity: number;

  @ApiProperty({ enum: LpgSaleVariant, required: false })
  @IsOptional()
  @IsEnum(LpgSaleVariant)
  lpgVariant?: LpgSaleVariant;

  @ApiProperty({ required: false, default: 0, description: 'Per-item discount in KES' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  discount?: number;

  @ApiProperty({ required: false, description: 'Optional cylinder ID for tracked serialized cylinders' })
  @IsOptional()
  @IsString()
  cylinderId?: string;

  @ApiProperty({ required: false, description: 'Optional cylinder serial number' })
  @IsOptional()
  @IsString()
  serialNumber?: string;
}

export class SalePaymentDto {
  @ApiProperty({ enum: ['CASH', 'PAYBILL', 'MPESA'], description: 'Payment method (CASH or PAYBILL)' })
  @IsNotEmpty()
  @IsString()
  method: string;

  @ApiProperty({ description: 'Amount for this payment method in KES' })
  @IsNumber()
  @Min(0)
  amount: number;

  @ApiProperty({ required: false, description: 'PayBill tracking / reference number' })
  @IsOptional()
  @IsString()
  paymentRef?: string;

  @ApiProperty({ required: false, description: 'Client name for PayBill payment' })
  @IsOptional()
  @IsString()
  customerName?: string;

  @ApiProperty({ required: false, description: 'M-Pesa receipt number (legacy)' })
  @IsOptional()
  @IsString()
  mpesaRef?: string;

  @ApiProperty({ required: false, description: 'Customer phone number (legacy)' })
  @IsOptional()
  @IsString()
  phoneNumber?: string;
}

export class CreateSaleDto {
  @ApiProperty()
  @IsNotEmpty()
  @IsString()
  branchId: string;

  @ApiProperty({ enum: SaleType })
  @IsEnum(SaleType)
  @IsNotEmpty()
  type: SaleType;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  customerId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  customerName?: string;

  @ApiProperty({ type: [SaleItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SaleItemDto)
  items: SaleItemDto[];

  @ApiProperty({ type: [SalePaymentDto], required: false, description: 'Payment breakdown (supports split payments)' })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SalePaymentDto)
  payments?: SalePaymentDto[];

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiProperty({ required: false, description: 'Unique idempotency key to prevent double charging/creation' })
  @IsOptional()
  @IsString()
  idempotencyKey?: string;

  @ApiProperty({ required: false, description: 'True if sale is pending M-Pesa STK push callback' })
  @IsOptional()
  @IsBoolean()
  isStkPending?: boolean;

  @ApiProperty({ required: false, description: 'Customer phone number for M-Pesa STK push' })
  @IsOptional()
  @IsString()
  phoneNumber?: string;

  @ApiProperty({ required: false, description: 'Reason for discounts applied' })
  @IsOptional()
  @IsString()
  discountReason?: string;

  @ApiProperty({ required: false, description: 'Admin/Manager authorization code for high discounts' })
  @IsOptional()
  @IsString()
  managerOverrideCode?: string;
}
