import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ExpenseStatus, UserRole } from '@prisma/client';
import { CreateExpenseDto } from './dto/create-expense.dto';

@Injectable()
export class ExpensesService {
  constructor(
    private prisma: PrismaService,
    private notificationsService: NotificationsService,
  ) {}

  async create(createExpenseDto: CreateExpenseDto, user: any) {
    const { branchId, amount, category, description, receiptUrl } = createExpenseDto;

    if ((category as any) === 'PETTY_CASH') {
      throw new BadRequestException('Petty cash is a daily constant allowance configured by the Admin and cannot be manually submitted.');
    }

    if (user.role !== UserRole.SUPER_ADMIN && !user.branchId) {
      throw new ForbiddenException('You are not assigned to any branch. Please contact your administrator.');
    }
    if (user.role === UserRole.BRANCH_MANAGER && user.branchId !== branchId) {
      throw new ForbiddenException('You can only submit expenses for your assigned branch');
    }

    const targetBranch = await this.prisma.branch.findUnique({ where: { id: branchId } });
    if (!targetBranch) throw new NotFoundException('Branch not found');
    if (targetBranch.code?.trim().toUpperCase() === 'HQ' && user.role !== UserRole.SUPER_ADMIN) {
      throw new ForbiddenException('Only administrators can record expenses for Headquarters.');
    }

    const count = await this.prisma.expense.count();
    const expenseCode = `EXP-${String(count + 1).padStart(5, '0')}`;

    const expense = await this.prisma.expense.create({
      data: {
        expenseCode,
        branchId,
        userId: user.userId,
        amount,
        category,
        description,
        receiptUrl,
        status: ExpenseStatus.PENDING,
      },
      include: {
        branch: { select: { id: true, name: true, code: true } },
        user: { select: { firstName: true, lastName: true } },
      },
    });

    // Notify all admins who need to action the expense — NOT the submitter.
    const admins = await this.prisma.user.findMany({
      where: { role: UserRole.SUPER_ADMIN },
      select: { id: true },
    });
    await Promise.all(
      admins.map((admin) =>
        this.notificationsService.create({
          type: 'EXPENSE_SUBMITTED',
          title: 'New Expense Submitted',
          message: `Expense ${expenseCode} from ${expense.branch.name} — KES ${Number(amount).toFixed(2)}`,
          userId: admin.id,
          entityId: expense.id,
          entityType: 'Expense',
        }),
      ),
    );

    await this.prisma.activityFeed.create({
      data: {
        type: 'EXPENSE_SUBMITTED',
        branchId,
        title: 'Expense Submitted',
        message: `Expense ${expenseCode} - KES ${Number(amount).toFixed(2)}: ${description}`,
        entityId: expense.id,
        entityType: 'Expense',
        visibleToBranch: true,
      },
    });

    return expense;
  }

  async ensureDailyPettyCash(branchId: string) {
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Africa/Nairobi',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date());
      const [year, month, day] = parts.split('-').map(Number);
      const today = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));

      // 1. Check if sales exist today (skip if zero sales)
      const saleCount = await this.prisma.sale.count({
        where: {
          branchId,
          createdAt: { gte: today },
          status: 'COMPLETED',
        },
      });
      if (saleCount === 0) return;

      // 2. Lookup branch manager or user with dailyPettyCash
      const branch = await this.prisma.branch.findUnique({
        where: { id: branchId },
        include: {
          manager: true,
          users: { where: { status: 'ACTIVE' } },
        },
      });
      if (!branch) return;

      let pettyCashAmount = 0;
      let pettyCashUser = branch.manager || null;
      if (branch.manager && Number(branch.manager.dailyPettyCash || 0) > 0) {
        pettyCashAmount = Number(branch.manager.dailyPettyCash);
      } else if (branch.users && branch.users.length > 0) {
        const mgr = branch.users.find(u => u.role === UserRole.BRANCH_MANAGER && Number(u.dailyPettyCash || 0) > 0)
          || branch.users.find(u => Number(u.dailyPettyCash || 0) > 0);
        if (mgr) {
          pettyCashAmount = Number(mgr.dailyPettyCash || 0);
          pettyCashUser = mgr;
        }
      }

      if (pettyCashAmount <= 0 || !pettyCashUser) return;

      // 3. Check if already recorded today
      const existing = await this.prisma.expense.findFirst({
        where: {
          branchId,
          category: 'PETTY_CASH' as any,
          createdAt: { gte: today },
        },
      });

      if (!existing) {
        const dateCode = parts.split('-').join('');
        const codeSuffix = (branch.code || branchId.slice(0, 4)).toUpperCase();
        const expenseCode = `PETTY-${codeSuffix}-${dateCode}`;

        await this.prisma.expense.create({
          data: {
            expenseCode,
            branchId,
            userId: pettyCashUser.id,
            amount: pettyCashAmount,
            category: 'PETTY_CASH' as any,
            description: `Daily constant petty cash allowance (${pettyCashUser.firstName} ${pettyCashUser.lastName})`,
            status: ExpenseStatus.APPROVED,
            approvedById: pettyCashUser.id,
            approvedAt: new Date(),
          },
        });
      }
    } catch {
      // Non-blocking
    }
  }

  async findAll(query?: { branchId?: string; status?: string; user?: any }) {
    if (query?.branchId) {
      await this.ensureDailyPettyCash(query.branchId);
    }

    const where: any = {};
    if (query?.branchId) where.branchId = query.branchId;
    if (query?.status) where.status = query.status;

    return this.prisma.expense.findMany({
      where,
      include: {
        branch: { select: { id: true, name: true, code: true } },
        user: { select: { firstName: true, lastName: true } },
        approvedBy: { select: { firstName: true, lastName: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string) {
    const expense = await this.prisma.expense.findUnique({
      where: { id },
      include: {
        branch: true,
        user: { select: { firstName: true, lastName: true } },
        approvedBy: { select: { firstName: true, lastName: true } },
      },
    });
    if (!expense) throw new NotFoundException('Expense not found');
    return expense;
  }

  async approve(id: string, approvedById: string) {
    const expense = await this.prisma.expense.findUnique({ where: { id } });
    if (!expense) throw new NotFoundException('Expense not found');
    if (expense.status !== ExpenseStatus.PENDING) {
      throw new BadRequestException('Expense is not pending');
    }

    const updated = await this.prisma.expense.update({
      where: { id },
      data: { status: ExpenseStatus.APPROVED, approvedById, approvedAt: new Date() },
      include: { branch: true, user: { select: { firstName: true, lastName: true } } },
    });

    await this.notificationsService.create({
      type: 'EXPENSE_APPROVED',
      title: 'Expense Approved',
      message: `Your expense ${expense.expenseCode} has been approved`,
      userId: expense.userId,
      entityId: id,
      entityType: 'Expense',
    });

    return updated;
  }

  async reject(id: string, approvedById: string, rejectionReason: string) {
    const expense = await this.prisma.expense.findUnique({ where: { id } });
    if (!expense) throw new NotFoundException('Expense not found');
    if (expense.status !== ExpenseStatus.PENDING) {
      throw new BadRequestException('Expense is not pending');
    }

    const updated = await this.prisma.expense.update({
      where: { id },
      data: { status: ExpenseStatus.REJECTED, approvedById, approvedAt: new Date(), rejectionReason },
    });

    await this.notificationsService.create({
      type: 'EXPENSE_REJECTED',
      title: 'Expense Rejected',
      message: `Your expense ${expense.expenseCode} has been rejected. Reason: ${rejectionReason}`,
      userId: expense.userId,
      entityId: id,
      entityType: 'Expense',
    });

    return updated;
  }
}
