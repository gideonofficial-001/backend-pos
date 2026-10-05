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

    // 1. Calculate today's cash received through SalePayment records
    // This accurately includes cash from today's cash sales AND cash received on invoice debt payments today!
    const paymentsToday = await this.prisma.salePayment.findMany({
      where: {
        createdAt: { gte: today },
        sale: { branchId, status: 'COMPLETED' },
      },
      select: { method: true, amount: true, saleId: true },
    });

    let cashSales = 0;
    let mpesaSales = 0;

    for (const p of paymentsToday) {
      if (p.method === 'CASH') {
        cashSales += Number(p.amount);
      } else if (p.method === 'MPESA') {
        mpesaSales += Number(p.amount);
      }
    }

    // Fallback for legacy sales created today that might not have SalePayment rows
    const legacySales = await this.prisma.sale.findMany({
      where: {
        branchId,
        createdAt: { gte: today },
        status: 'COMPLETED',
        type: { not: 'INVOICE' },
        payments: { none: {} },
      },
      select: { paymentProvider: true, total: true },
    });

    for (const s of legacySales) {
      if (s.paymentProvider === 'MPESA') {
        mpesaSales += Number(s.total);
      } else if (s.paymentProvider === 'CASH') {
        cashSales += Number(s.total);
      }
    }

    // 2. Invoice sales issued today (debt created, not cash in drawer)
    const invoiceSalesToday = await this.prisma.sale.findMany({
      where: {
        branchId,
        type: 'INVOICE',
        createdAt: { gte: today },
        status: 'COMPLETED',
      },
      select: { total: true },
    });
    const invoiceSales = invoiceSalesToday.reduce((sum, s) => sum + Number(s.total), 0);

    // 3. Approved cash expenses today
    const expenses = await this.prisma.expense.findMany({
      where: {
        branchId,
        createdAt: { gte: today },
        status: 'APPROVED',
      },
    });
    const totalExpenses = expenses.reduce((sum, e) => sum + Number(e.amount), 0);

    // 4. Approved cash refunds today
    const refunds = await this.prisma.return.findMany({
      where: {
        branchId,
        approvedAt: { gte: today },
        status: 'APPROVED',
      },
    });
    const totalRefunds = refunds.reduce((sum, r) => sum + Number(r.refundAmount || 0), 0);

    const openingCash = existing ? Number(existing.openingCash) : 0;
    const expectedCash = Math.round((openingCash + cashSales - totalExpenses - totalRefunds) * 100) / 100;

    return {
      date: today,
      existingClosing: existing,
      calculated: {
        openingCash,
        cashSales: Math.round(cashSales * 100) / 100,
        mpesaSales: Math.round(mpesaSales * 100) / 100,
        invoiceSales: Math.round(invoiceSales * 100) / 100,
        totalExpenses: Math.round(totalExpenses * 100) / 100,
        totalRefunds: Math.round(totalRefunds * 100) / 100,
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
    const totalRefunds = summary.calculated.totalRefunds;

    const expectedCash = Math.round((openingCash + cashSales - totalExpenses - totalRefunds) * 100) / 100;
    const variance = Math.round((closingCash - expectedCash) * 100) / 100;

    if (variance !== 0 && (!data.notes || !data.notes.trim())) {
      throw new BadRequestException(
        `A note/reason is required explaining the cash variance of KES ${variance.toFixed(2)}.`,
      );
    }

    const closing = await this.prisma.branchClosing.upsert({
      where: {
        branchId_date: { branchId, date: today },
      },
      create: {
        branchId,
        date: today,
        openingCash,
        cashSales,
        mpesaSales,
        totalExpenses: totalExpenses + totalRefunds,
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
        totalExpenses: totalExpenses + totalRefunds,
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

    // Record audit log
    await this.prisma.auditLog.create({
      data: {
        userId: user.userId,
        action: 'BRANCH_CLOSING_SUBMITTED' as any,
        entityType: 'BranchClosing',
        entityId: closing.id,
        description: `Branch closing submitted for ${branchId} on ${today.toISOString().split('T')[0]}: Expected KES ${expectedCash.toFixed(2)}, Actual KES ${closingCash.toFixed(2)}, Variance KES ${variance.toFixed(2)}`,
        newValues: {
          branchId,
          date: today,
          openingCash,
          cashSales,
          mpesaSales,
          totalExpenses,
          totalRefunds,
          closingCash,
          expectedCash,
          variance,
          notes: data.notes || '',
        },
      },
    });

    return closing;
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
