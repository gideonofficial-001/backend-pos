import { Module } from '@nestjs/common';
import { BranchClosingsService } from './branch-closings.service';
import { BranchClosingsController } from './branch-closings.controller';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [BranchClosingsController],
  providers: [BranchClosingsService],
  exports: [BranchClosingsService],
})
export class BranchClosingsModule {}
