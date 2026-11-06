import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { UserRole, UserStatus } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';

@Injectable()
export class UsersService {
  constructor(
    private prisma: PrismaService,
    private auditLogsService: AuditLogsService,
  ) {}

  async create(createUserDto: CreateUserDto, performedBy: string) {
    const { email, password, firstName, lastName, phone, role, branchId } = createUserDto;

    const existingUser = await this.prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      throw new ConflictException('Email is already registered');
    }

    if (role === UserRole.BRANCH_MANAGER && !branchId) {
      throw new BadRequestException('Branch ID is required for branch managers');
    }

    if (branchId) {
      const branch = await this.prisma.branch.findUnique({ where: { id: branchId } });
      if (branch?.code?.trim().toUpperCase() === 'HQ' && role !== UserRole.SUPER_ADMIN) {
        throw new BadRequestException('Only administrators can be assigned to the Headquarters branch.');
      }
    }

    // Encrypt the password
    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await this.prisma.user.create({
      data: {
        email,
        password: hashedPassword, // Reverted to match Prisma schema
        firstName,
        lastName,
        phone,
        role,
        branchId,
        dailyPettyCash: createUserDto.dailyPettyCash !== undefined ? createUserDto.dailyPettyCash : 0,
        status: UserStatus.ACTIVE,
      },
      include: { branch: true },
    });

    await this.auditLogsService.create({
      userId: performedBy,
      action: 'USER_CREATED',
      description: `Created user ${email} with role ${role}`,
      entityType: 'User',
      entityId: user.id,
      newValues: { email, firstName, lastName, role, branchId },
    });

    // Strip the password before returning to the frontend
    const { password: _, ...result } = user;

    if (branchId && role === UserRole.BRANCH_MANAGER) {
      const targetBranch = await this.prisma.branch.findUnique({ where: { id: branchId } });
      if (targetBranch && !targetBranch.managerId && targetBranch.code !== 'HQ') {
        await this.prisma.branch.update({
          where: { id: branchId },
          data: { managerId: user.id },
        });
      }
    }

    return result;
  }

  async findAll() {
    // Auto-heal: Ensure any user who is set as branch manager has branchId populated
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

    const users = await this.prisma.user.findMany({
      include: {
        branch: { select: { id: true, name: true, code: true } },
        managedBranch: { select: { id: true, name: true, code: true } },
        _count: { select: { sales: true, devices: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Strip passwords from the list and ensure effective branch is populated
    return users.map(({ password, ...user }) => {
      const effectiveBranch = user.branch || user.managedBranch;
      return {
        ...user,
        branchId: user.branchId || user.managedBranch?.id,
        branch: effectiveBranch,
      };
    });
  }

  async findOne(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: {
        branch: true,
        managedBranch: true,
        devices: {
          select: { id: true, fingerprint: true, name: true, status: true, lastUsedAt: true, createdAt: true },
        },
        _count: { select: { sales: true } },
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (!user.branchId && user.managedBranch?.id) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { branchId: user.managedBranch.id },
      });
      user.branchId = user.managedBranch.id;
    }

    const effectiveBranch = user.branch || user.managedBranch;
    const { password, ...result } = user;
    return {
      ...result,
      branchId: user.branchId || user.managedBranch?.id,
      branch: effectiveBranch,
    };
  }

  async findByEmail(email: string) {
    return this.prisma.user.findUnique({ where: { email }, include: { branch: true, managedBranch: true } });
  }

  async update(id: string, updateUserDto: UpdateUserDto, performedBy: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: { managedBranch: true },
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (updateUserDto.branchId) {
      const branch = await this.prisma.branch.findUnique({ where: { id: updateUserDto.branchId } });
      const targetRole = updateUserDto.role || user.role;
      if (branch?.code?.trim().toUpperCase() === 'HQ' && targetRole !== UserRole.SUPER_ADMIN) {
        throw new BadRequestException('Only administrators can be assigned to the Headquarters branch.');
      }
    }

    // If branchId is modified:
    if (updateUserDto.branchId !== undefined) {
      // If user was managing another branch, clear managerId on that branch
      if (user.managedBranch && user.managedBranch.id !== updateUserDto.branchId) {
        await this.prisma.branch.update({
          where: { id: user.managedBranch.id },
          data: { managerId: null },
        });
      }
      // If assigned to a new branch as branch manager and branch has no manager, assign as manager
      if (updateUserDto.branchId) {
        const targetBranch = await this.prisma.branch.findUnique({ where: { id: updateUserDto.branchId } });
        const isBranchManager = (updateUserDto.role || user.role) === UserRole.BRANCH_MANAGER;
        if (targetBranch && !targetBranch.managerId && isBranchManager && targetBranch.code !== 'HQ') {
          await this.prisma.branch.update({
            where: { id: updateUserDto.branchId },
            data: { managerId: id },
          });
        }
      }
    }

    const updateData: any = { ...updateUserDto };
    
    // Hash the password if the Admin is overwriting it
    if (updateUserDto.password) {
      updateData.password = await bcrypt.hash(updateUserDto.password, 10);
    }

    const updatedUser = await this.prisma.user.update({
      where: { id },
      data: updateData,
      include: {
        branch: { select: { id: true, name: true, code: true } },
        managedBranch: { select: { id: true, name: true, code: true } },
      },
    });

    await this.auditLogsService.create({
      userId: performedBy,
      action: 'USER_UPDATED',
      description: `Updated user ${user.email}`,
      entityType: 'User',
      entityId: id,
      oldValues: { role: user.role, status: user.status, branchId: user.branchId },
      newValues: updateUserDto,
    });

    const effectiveBranch = updatedUser.branch || updatedUser.managedBranch;
    const { password, ...result } = updatedUser;
    return {
      ...result,
      branchId: updatedUser.branchId || updatedUser.managedBranch?.id,
      branch: effectiveBranch,
    };
  }

  async remove(id: string, performedBy: string, confirmationText: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: { _count: { select: { sales: true } } },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (user.role === UserRole.SUPER_ADMIN) {
      throw new BadRequestException('Cannot delete super admin user');
    }

    const expectedText = `delete user ${user.email}`;
    if (confirmationText !== expectedText) {
      throw new BadRequestException(`Please type "delete user ${user.email}" to confirm deletion`);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.branch.updateMany({ where: { managerId: id }, data: { managerId: null } });
      await tx.device.deleteMany({ where: { userId: id } });
      await tx.user.delete({ where: { id } });
    });

    await this.auditLogsService.create({
      userId: performedBy,
      action: 'USER_DELETED',
      description: `Deleted user ${user.email}`,
      entityType: 'User',
      entityId: id,
      oldValues: { email: user.email, role: user.role },
    });

    return { message: `User ${user.email} has been permanently deleted` };
  }

  async updateStatus(id: string, status: UserStatus, performedBy: string) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const updatedUser = await this.prisma.user.update({
      where: { id },
      data: { status },
      include: { branch: true },
    });

    await this.auditLogsService.create({
      userId: performedBy,
      action: 'USER_UPDATED',
      description: `Changed user ${user.email} status to ${status}`,
      entityType: 'User',
      entityId: id,
      oldValues: { status: user.status },
      newValues: { status },
    });

    // Strip password
    const { password, ...result } = updatedUser;
    return result;
  }

  async getStats() {
    const [total, active, inactive, byRole] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.user.count({ where: { status: UserStatus.ACTIVE } }),
      this.prisma.user.count({ where: { status: UserStatus.INACTIVE } }),
      this.prisma.user.groupBy({ by: ['role'], _count: { role: true } }),
    ]);

    return { total, active, inactive, byRole };
  }

  // ── Self-Management Logic ──────────────────────────────────────────────────

  async updateProfile(userId: string, data: { firstName?: string; lastName?: string }) {
    return this.prisma.user.update({
      where: { id: userId },
      data: {
        firstName: data.firstName,
        lastName: data.lastName,
      },
      select: { id: true, firstName: true, lastName: true, email: true, role: true }
    });
  }

  async updatePassword(userId: string, currentPass: string, newPass: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    // Compare against the DB 'password' column
    const isMatch = await bcrypt.compare(currentPass, user.password);
    if (!isMatch) {
      throw new BadRequestException('Incorrect current password');
    }

    const hashedNewPassword = await bcrypt.hash(newPass, 10);
    
    await this.prisma.user.update({
      where: { id: userId },
      data: { password: hashedNewPassword },
    });

    return { message: 'Password updated successfully' };
  }

  async setPettyCash(id: string, amount: number, performedBy: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: { branch: true, managedBranch: true },
    });
    if (!user) throw new NotFoundException('User not found');

    const cleanAmount = Math.max(0, Number(amount || 0));

    const updated = await this.prisma.user.update({
      where: { id },
      data: { dailyPettyCash: cleanAmount },
      include: {
        branch: { select: { id: true, name: true, code: true } },
        managedBranch: { select: { id: true, name: true, code: true } },
      },
    });

    await this.auditLogsService.create({
      userId: performedBy,
      action: 'USER_UPDATED',
      description: `Updated daily petty cash allowance for ${user.email} (${user.firstName} ${user.lastName}) to KES ${cleanAmount.toFixed(2)}`,
      entityType: 'User',
      entityId: id,
      oldValues: { dailyPettyCash: Number(user.dailyPettyCash || 0) },
      newValues: { dailyPettyCash: cleanAmount },
    });

    const { password: _, ...result } = updated;
    return result;
  }

  async getPettyCashAllocations() {
    const users = await this.prisma.user.findMany({
      where: {
        status: UserStatus.ACTIVE,
      },
      include: {
        branch: { select: { id: true, name: true, code: true } },
        managedBranch: { select: { id: true, name: true, code: true } },
      },
      orderBy: [
        { role: 'asc' },
        { firstName: 'asc' },
      ],
    });

    return users.map(({ password: _, ...u }) => ({
      ...u,
      dailyPettyCash: Number(u.dailyPettyCash || 0),
      effectiveBranch: u.branch || u.managedBranch || null,
    }));
  }
}
