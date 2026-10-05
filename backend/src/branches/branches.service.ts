import { Injectable, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { CreateBranchDto } from './dto/create-branch.dto';
import { UpdateBranchDto } from './dto/update-branch.dto';

@Injectable()
export class BranchesService {
  constructor(
    private prisma: PrismaService,
    private auditLogsService: AuditLogsService,
  ) {}

  async create(createBranchDto: CreateBranchDto, performedBy: string) {
    const existing = await this.prisma.branch.findUnique({
      where: { code: createBranchDto.code },
    });
    if (existing) {
      throw new ConflictException(
        `Branch with code ${createBranchDto.code} already exists`,
      );
    }

    if (createBranchDto.code?.trim().toUpperCase() === 'HQ') {
      if (createBranchDto.managerId) {
        throw new BadRequestException('Headquarters is hardcoded for administrator management only. Managers cannot be assigned to Headquarters.');
      }
      delete createBranchDto.managerId;
    }

    const branch = await this.prisma.branch.create({
      data: createBranchDto,
      include: {
        manager: {
          select: { id: true, firstName: true, lastName: true, email: true },
        },
      },
    });

    if (branch.managerId) {
      await this.prisma.user.update({
        where: { id: branch.managerId },
        data: { branchId: branch.id },
      });
    }

    await this.auditLogsService.create({
      userId: performedBy,
      action: 'BRANCH_CREATED',
      description: `Created branch ${branch.name} (${branch.code})`,
      entityType: 'Branch',
      entityId: branch.id,
      newValues: createBranchDto,
    });

    return branch;
  }

  async findAll() {
    const branchesWithManagers = await this.prisma.branch.findMany({
      where: { managerId: { not: null } },
      select: { id: true, managerId: true },
    });
    for (const b of branchesWithManagers) {
      if (b.managerId) {
        await this.prisma.user.updateMany({
          where: { id: b.managerId, branchId: null },
          data: { branchId: b.id },
        });
      }
    }

    return this.prisma.branch.findMany({
      include: {
        manager: {
          select: { id: true, firstName: true, lastName: true, email: true },
        },
        _count: { select: { users: true, inventory: true, sales: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string) {
    const branch = await this.prisma.branch.findUnique({
      where: { id },
      include: {
        manager: {
          select: { id: true, firstName: true, lastName: true, email: true },
        },
        users: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            role: true,
          },
        },
        inventory: { include: { product: true } },
        _count: { select: { sales: true } },
      },
    });
    if (!branch) throw new NotFoundException('Branch not found');
    return branch;
  }

  async update(id: string, updateBranchDto: UpdateBranchDto, performedBy: string) {
    const branch = await this.prisma.branch.findUnique({ where: { id } });
    if (!branch) throw new NotFoundException('Branch not found');

    if (branch.code?.trim().toUpperCase() === 'HQ') {
      if (updateBranchDto.managerId) {
        throw new BadRequestException('Headquarters is hardcoded for administrator management only. Managers cannot be assigned to Headquarters.');
      }
      updateBranchDto.managerId = null;
    }

    if (updateBranchDto.managerId !== undefined) {
      if (branch.managerId && branch.managerId !== updateBranchDto.managerId) {
        await this.prisma.user.updateMany({
          where: { id: branch.managerId, branchId: branch.id },
          data: { branchId: null },
        });
      }
      if (updateBranchDto.managerId) {
        await this.prisma.user.update({
          where: { id: updateBranchDto.managerId },
          data: { branchId: branch.id },
        });
      }
    }

    const updated = await this.prisma.branch.update({
      where: { id },
      data: updateBranchDto,
      include: {
        manager: {
          select: { id: true, firstName: true, lastName: true, email: true },
        },
      },
    });

    await this.auditLogsService.create({
      userId: performedBy,
      action: 'BRANCH_UPDATED',
      description: `Updated branch ${branch.name}`,
      entityType: 'Branch',
      entityId: id,
      oldValues: branch,
      newValues: updateBranchDto,
    });

    return updated;
  }

  async toggleStatus(id: string, performedBy: string) {
    const branch = await this.prisma.branch.findUnique({ where: { id } });
    if (!branch) throw new NotFoundException('Branch not found');
    return this.prisma.branch.update({
      where: { id },
      data: { isActive: !branch.isActive },
    });
  }

  async getBranchInventory(id: string) {
    const branch = await this.prisma.branch.findUnique({ where: { id } });
    if (!branch) throw new NotFoundException('Branch not found');

    return this.prisma.inventory.findMany({
      where: { branchId: id },
      include: { product: { include: { category: true } } },
      orderBy: { product: { name: 'asc' } },
    });
  }

  async getBranchSales(id: string, startDate?: string, endDate?: string) {
    const branch = await this.prisma.branch.findUnique({ where: { id } });
    if (!branch) throw new NotFoundException('Branch not found');

    const where: any = { branchId: id };
    if (startDate && endDate) {
      where.createdAt = { gte: new Date(startDate), lte: new Date(endDate) };
    }

    return this.prisma.sale.findMany({
      where,
      include: {
        saleItems: { include: { product: true } },
        user: { select: { firstName: true, lastName: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }
}
