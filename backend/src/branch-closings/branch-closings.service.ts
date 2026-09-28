import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class BranchClosingsService {
  constructor(private prisma: PrismaService) {}

  private getTodayDate(): Date {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Africa/Nairobi',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    const [year, month, day] = parts.split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
  }

  async getTodaySummary(branchId: string) {
    const today = this.getTodayDate();

    // Check existing record
    const existing = await this.prisma.branchClosing.findUnique({
      where: {
        branchId_date: { branchId, date: today },
      },
      include: {
        submittedBy: { select: { firstName: true, lastName: true } },
      },
    });

    // Calculate today's sales from SalePayment
    const sales = await this.prisma.sale.findMany({
      where: {
        branchId,
        createdAt: { gte: today },
        status: 'COMPLETED',
      },
      include: { payments: true },
    });

    let cashSales = 0;
    let mpesaSales = 0;
    let invoiceSales = 0;

    for (const s of sales) {
      if (s.type === 'INVOICE') {
        invoiceSales += Number(s.total);
      }
      if (s.payments && s.payments.length > 0) {
        for (const p of s.payments) {
          if (p.method === 'CASH') cashSales += Number(p.amount);
          else if (p.method === 'MPESA') mpesaSales += Number(p.amount);
        }
      } else {
        if (s.paymentProvider === 'MPESA') mpesaSales += Number(s.total);
        else if (s.paymentProvider === 'CASH') cashSales += Number(s.total);
      }
    }

    // Calculate today's branch expenses
    const expenses = await this.prisma.expense.findMany({
      where: {
        branchId,
        createdAt: { gte: today },
        status: { in: ['APPROVED', 'PENDING'] },
      },
    });
    const totalExpenses = expenses.reduce((sum, e) => sum + Number(e.amount), 0);

    const openingCash = existing ? Number(existing.openingCash) : 0;
    const expectedCash = openingCash + cashSales - totalExpenses;

    return {
      date: today,
      existingClosing: existing,
      calculated: {
        openingCash,
        cashSales,
        mpesaSales,
        invoiceSales,
        totalExpenses,
        expectedCash,
      },
    };
  }

  async submitClosing(
    branchId: string,
    data: { openingCash: number; closingCash: number; notes?: string },
    user: any,
  ) {
    const today = this.getTodayDate();
    const summary = await this.getTodaySummary(branchId);

    const openingCash = Number(data.openingCash || 0);
    const closingCash = Number(data.closingCash || 0);
    const cashSales = summary.calculated.cashSales;
    const mpesaSales = summary.calculated.mpesaSales;
    const totalExpenses = summary.calculated.totalExpenses;

    const expectedCash = openingCash + cashSales - totalExpenses;
    const variance = closingCash - expectedCash;

    return this.prisma.branchClosing.upsert({
      where: {
        branchId_date: { branchId, date: today },
      },
      create: {
        branchId,
        date: today,
        openingCash,
        cashSales,
        mpesaSales,
        totalExpenses,
        closingCash,
        expectedCash,
        variance,
        notes: data.notes || null,
        submittedById: user.userId,
      },
      update: {
        openingCash,
        cashSales,
        mpesaSales,
        totalExpenses,
        closingCash,
        expectedCash,
        variance,
        notes: data.notes || null,
        submittedById: user.userId,
      },
      include: {
        submittedBy: { select: { firstName: true, lastName: true } },
      },
    });
  }

  async getHistory(branchId?: string, startDate?: string, endDate?: string) {
    const where: any = {};
    if (branchId) where.branchId = branchId;
    if (startDate && endDate) {
      where.date = {
        gte: new Date(startDate),
        lte: new Date(endDate),
      };
    }

    return this.prisma.branchClosing.findMany({
      where,
      include: {
        branch: { select: { id: true, name: true, code: true } },
        submittedBy: { select: { firstName: true, lastName: true } },
      },
      orderBy: { date: 'desc' },
    });
  }
}
