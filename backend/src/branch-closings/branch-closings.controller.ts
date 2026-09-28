import { Controller, Get, Post, Body, Query, UseGuards, Request } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { BranchClosingsService } from './branch-closings.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '@prisma/client';

@ApiTags('Branch Closings')
@Controller('branch-closings')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class BranchClosingsController {
  constructor(private readonly closingsService: BranchClosingsService) {}

  @Get('today')
  @Roles(UserRole.SUPER_ADMIN, UserRole.OVERALL_MANAGER, UserRole.BRANCH_MANAGER)
  @ApiOperation({ summary: 'Get current day sales and cash drawer closing summary' })
  async getTodaySummary(@Query('branchId') queryBranchId: string, @Request() req: any) {
    const branchId =
      req.user.role === UserRole.BRANCH_MANAGER
        ? req.user.branchId
        : queryBranchId || req.user.branchId;
    return this.closingsService.getTodaySummary(branchId);
  }

  @Post()
  @Roles(UserRole.SUPER_ADMIN, UserRole.OVERALL_MANAGER, UserRole.BRANCH_MANAGER)
  @ApiOperation({ summary: 'Submit end-of-day cash drawer closing count' })
  async submitClosing(
    @Body()
    body: {
      branchId?: string;
      openingCash: number;
      closingCash: number;
      notes?: string;
    },
    @Request() req: any,
  ) {
    const branchId =
      req.user.role === UserRole.BRANCH_MANAGER
        ? req.user.branchId
        : body.branchId || req.user.branchId;
    return this.closingsService.submitClosing(branchId, body, req.user);
  }

  @Get('history')
  @Roles(UserRole.SUPER_ADMIN, UserRole.OVERALL_MANAGER, UserRole.BRANCH_MANAGER)
  @ApiOperation({ summary: 'Get past branch closings history' })
  async getHistory(
    @Query('branchId') branchId?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Request() req?: any,
  ) {
    const targetBranch =
      req.user.role === UserRole.BRANCH_MANAGER ? req.user.branchId : branchId;
    return this.closingsService.getHistory(targetBranch, startDate, endDate);
  }
}
