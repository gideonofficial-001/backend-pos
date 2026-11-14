import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UserRole, SaleStatus } from '@prisma/client';
import {
  getNairobiStartOfDay,
  getNairobiEndOfDay,
  getNairobiDateString,
  getNairobiCalendarDate,
} from '../common/utils/timezone.util';

@Injectable()
export class ReportsService {
  constructor(private prisma: PrismaService) {}

  async getDashboardStats(user?: any) {
    const where: any = {};
    if (user?.role === UserRole.BRANCH_MANAGER) {
      where.branchId = user.branchId;
    }

    const startOfToday = getNairobiStartOfDay();
    const endOfToday = getNairobiEndOfDay();

    let hiddenCategoryIds: string[] = [];
    if (user?.role === UserRole.BRANCH_MANAGER && user.branchId) {
      const hiddenSetting = await this.prisma.systemSetting.findUnique({
        where: { key: `HIDDEN_CATEGORIES_BRANCH_${user.branchId}` },
      });
      try {
        if (hiddenSetting?.value) {
          const parsed = JSON.parse(hiddenSetting.value);
          if (Array.isArray(parsed)) hiddenCategoryIds = parsed;
        }
      } catch {}
    }

    const lowStockWhere: any = { quantity: { lte: 10 } };
    const productWhere: any = { isActive: true };

    if (user?.role === UserRole.BRANCH_MANAGER && user.branchId) {
      lowStockWhere.branchId = user.branchId;
      if (hiddenCategoryIds.length > 0) {
        lowStockWhere.product = {
          OR: [
            { categoryId: null },
            { categoryId: { notIn: hiddenCategoryIds } },
          ],
        };
        productWhere.OR = [
          { categoryId: null },
          { categoryId: { notIn: hiddenCategoryIds } },
        ];
      }
    }

    const [
      totalSales,
      todaySales,
      totalRevenue,
      totalBranches,
      totalProducts,
      totalUsers,
      lowStock,
      pendingInvoices,
      recentSales,
      todaySalesData,
    ] = await Promise.all([
      this.prisma.sale.count({ where }),
      this.prisma.sale.count({ where: { ...where, createdAt: { gte: startOfToday, lte: endOfToday } } }),
      this.prisma.sale.aggregate({
        where: { ...where, status: SaleStatus.COMPLETED },
        _sum: { total: true },
      }),
      this.prisma.branch.count(),
      this.prisma.product.count({ where: productWhere }),
      this.prisma.user.count(),
      this.prisma.inventory.count({ where: lowStockWhere }),
      this.prisma.invoice.count({ where: { status: { in: ['PENDING', 'SENT'] } } }),
      this.prisma.sale.findMany({
        where,
        take: 10,
        orderBy: { createdAt: 'desc' },
        include: {
          saleItems: { include: { product: true } },
          branch: { select: { name: true } },
          user: { select: { firstName: true, lastName: true } },
        },
      }),
      this.prisma.sale.findMany({
        where: { ...where, createdAt: { gte: startOfToday, lte: endOfToday }, status: SaleStatus.COMPLETED },
        include: {
          saleItems: {
            include: {
              product: { select: { type: true, name: true } },
            },
          },
        },
      }),
    ]);

    let refillQty = 0;
    let refillRevenue = 0;
    let completeSetQty = 0;
    let completeSetRevenue = 0;
    let emptyShellQty = 0;
    let emptyShellRevenue = 0;
    let generalQty = 0;
    let generalRevenue = 0;
    let todayDiscount = 0;
    let todayGross = 0;
    let todayNet = 0;

    for (const sale of todaySalesData) {
      todayDiscount += Number(sale.discount || 0);
      todayGross += Number(sale.subtotal || sale.total || 0);
      todayNet += Number(sale.total || 0);

      for (const item of sale.saleItems) {
        const qty = Number(item.quantity || 0);
        const itemTotal = Number(item.total || 0);
        const variant = item.variantSnapshot || item.lpgVariant;
        const isLpg = item.product?.type === 'LPG_REFILL' || item.product?.type === 'LPG_CYLINDER';

        if (variant === 'REFILL') {
          refillQty += qty;
          refillRevenue += itemTotal;
        } else if (variant === 'COMPLETE_SET') {
          completeSetQty += qty;
          completeSetRevenue += itemTotal;
        } else if (variant === 'EMPTY_SHELL') {
          emptyShellQty += qty;
          emptyShellRevenue += itemTotal;
        } else if (isLpg) {
          refillQty += qty;
          refillRevenue += itemTotal;
        } else {
          generalQty += qty;
          generalRevenue += itemTotal;
        }
      }
    }

    const todaySummary = {
      refill: { quantity: refillQty, revenue: refillRevenue },
      completeSet: { quantity: completeSetQty, revenue: completeSetRevenue },
      emptyShell: { quantity: emptyShellQty, revenue: emptyShellRevenue },
      general: { quantity: generalQty, revenue: generalRevenue },
      totalRevenue: todayGross > 0 ? todayGross : (todayNet + todayDiscount),
      totalDiscount: todayDiscount,
      netRevenue: todayNet,
    };

    return {
      totalSales,
      todaySales,
      totalRevenue: totalRevenue._sum.total || 0,
      totalBranches,
      totalProducts,
      totalUsers,
      lowStock,
      pendingInvoices,
      recentSales,
      todaySummary,
    };
  }

  async getSalesTrend(days = 30, user?: any) {
    const where: any = { status: SaleStatus.COMPLETED };
    if (user?.role === UserRole.BRANCH_MANAGER) {
      where.branchId = user.branchId;
    }

    const startDate = getNairobiStartOfDay();
    startDate.setDate(startDate.getDate() - days);

    const sales = await this.prisma.sale.findMany({
      where: { ...where, createdAt: { gte: startDate } },
      select: { total: true, createdAt: true, type: true },
      orderBy: { createdAt: 'asc' },
    });

    const grouped: Record<string, any> = {};
    sales.forEach((sale) => {
      const date = getNairobiDateString(sale.createdAt);
      if (!grouped[date]) {
        grouped[date] = { date, total: 0, cash: 0, invoice: 0, count: 0 };
      }
      grouped[date].total += Number(sale.total);
      grouped[date].count += 1;
      if (sale.type === 'CASH') grouped[date].cash += Number(sale.total);
      else grouped[date].invoice += Number(sale.total);
    });

    return Object.values(grouped);
  }

  async getBranchPerformance() {
    const branches = await this.prisma.branch.findMany({
      include: {
        _count: { select: { sales: true, users: true } },
        sales: {
          where: { status: SaleStatus.COMPLETED },
          select: { total: true },
        },
      },
    });

    return branches.map((branch) => ({
      id: branch.id,
      name: branch.name,
      code: branch.code,
      totalSales: branch._count.sales,
      totalRevenue: branch.sales.reduce((sum, s) => sum + Number(s.total), 0),
      staffCount: branch._count.users,
      isActive: branch.isActive,
    }));
  }

  async getProductPerformance(user?: any) {
    const branchId = user?.role === UserRole.BRANCH_MANAGER ? user.branchId : undefined;
    const products = await this.prisma.product.findMany({
      where: { isActive: true },
      include: {
        saleItems: branchId
          ? {
              where: { sale: { branchId, status: SaleStatus.COMPLETED } },
              select: { quantity: true, total: true },
            }
          : {
              where: { sale: { status: SaleStatus.COMPLETED } },
              select: { quantity: true, total: true },
            },
        inventory: branchId
          ? { where: { branchId } }
          : true,
      },
    });

    return products.map((product) => ({
      id: product.id,
      name: product.name,
      code: product.code,
      type: product.type,
      price: product.price,
      totalSold: product.saleItems.reduce((sum, item) => sum + item.quantity, 0),
      totalRevenue: product.saleItems.reduce(
        (sum, item) => sum + Number(item.total),
        0,
      ),
      currentStock: product.inventory.reduce((sum, inv) => sum + inv.quantity, 0),
    }));
  }

  async getExpenseReport(startDate?: string, endDate?: string, user?: any) {
    const where: any = {};
    if (user?.role === UserRole.BRANCH_MANAGER && user.branchId) {
      where.branchId = user.branchId;
    }
    if (startDate && endDate) {
      where.createdAt = { gte: new Date(startDate), lte: new Date(endDate) };
    }

    const expenses = await this.prisma.expense.findMany({
      where,
      include: {
        branch: { select: { name: true } },
        user: { select: { firstName: true, lastName: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const byCategory = await this.prisma.expense.groupBy({
      by: ['category'],
      where,
      _sum: { amount: true },
      _count: { category: true },
    });

    return {
      expenses,
      byCategory,
      total: expenses.reduce((sum, e) => sum + Number(e.amount), 0),
    };
  }

  async getInventoryValuation(user?: any) {
    const branchId = user?.role === UserRole.BRANCH_MANAGER ? user.branchId : undefined;
    const inventory = await this.prisma.inventory.findMany({
      where: branchId ? { branchId } : {},
      include: { product: true, branch: { select: { name: true } } },
    });

    const totalValue = inventory.reduce(
      (sum, item) => sum + item.quantity * Number(item.product.price),
      0,
    );
    const totalCost = inventory.reduce(
      (sum, item) => sum + item.quantity * Number(item.product.costPrice || 0),
      0,
    );

    return {
      items: inventory,
      summary: {
        totalItems: inventory.length,
        totalQuantity: inventory.reduce((sum, item) => sum + item.quantity, 0),
        totalValue,
        totalCost,
        potentialProfit: totalValue - totalCost,
      },
    };
  }

  async getLiveDailySales(branchId?: string, dateStr?: string) {
    const startOfDay = getNairobiStartOfDay(dateStr);
    const endOfDay = getNairobiEndOfDay(dateStr);
    const reportDateStr = dateStr || getNairobiDateString();

    const saleWhere: any = {
      status: SaleStatus.COMPLETED,
      createdAt: { gte: startOfDay, lte: endOfDay },
    };
    if (branchId && branchId !== 'all') {
      saleWhere.branchId = branchId;
    }

    const sales = await this.prisma.sale.findMany({
      where: saleWhere,
      include: {
        customer: true,
        branch: { select: { id: true, name: true } },
        payments: true,
        saleItems: {
          include: {
            product: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    const retailItems: any[] = [];
    const wholesaleItems: any[] = [];

    let retailTotal = 0;
    let retailDiscountTotal = 0;
    let retailItemsCount = 0;

    let wholesaleTotal = 0;
    let wholesaleDiscountTotal = 0;
    let wholesaleItemsCount = 0;

    let paybillTotal = 0;
    let cashSalesTotal = 0;

    for (const sale of sales) {
      const isRetail = sale.type === 'CASH';
      const isWholesale = sale.type === 'WHOLESALE';

      // Payment breakdown (Cash vs Paybill / M-Pesa)
      if (sale.type !== 'INVOICE') {
        if (sale.payments && sale.payments.length > 0) {
          for (const p of sale.payments) {
            const method = String(p.method).toUpperCase();
            if (method === 'PAYBILL' || method === 'MPESA' || method === 'BANK') {
              paybillTotal += Number(p.amount || 0);
            } else if (method === 'CASH') {
              cashSalesTotal += Number(p.amount || 0);
            } else {
              paybillTotal += Number(p.amount || 0);
            }
          }
        } else {
          const prov = String(sale.paymentProvider).toUpperCase();
          if (prov === 'PAYBILL' || prov === 'MPESA' || prov === 'BANK') {
            paybillTotal += Number(sale.total || 0);
          } else {
            cashSalesTotal += Number(sale.total || 0);
          }
        }
      }

      for (const item of sale.saleItems) {
        const qty = item.quantity;
        const sellingPrice = Number(item.unitPrice);
        const discount = Number(item.discount || 0);
        const subtotal = Number(item.total);
        const markedPrice = isWholesale
          ? Number(item.product?.wholesalePrice || item.product?.price || sellingPrice)
          : Number(item.product?.price || sellingPrice);

        const productName = item.productNameSnapshot || item.product?.name || 'Unknown Item';
        const variant = item.variantSnapshot || item.lpgVariant;
        const lpgLabel = variant === 'REFILL' ? ' (Refill)' : variant === 'EMPTY_SHELL' ? ' (Empty Shell)' : variant === 'COMPLETE_SET' ? ' (Complete Set)' : '';

        const itemData = {
          id: item.id,
          saleId: sale.id,
          saleCode: sale.saleCode,
          productId: item.productId,
          productName: `${productName}${lpgLabel}`,
          markedPrice,
          sellingPrice,
          quantity: qty,
          discount,
          subtotal,
          isRetailSale: isRetail,
          customerName: sale.customer?.name || (isWholesale ? 'Walk-in Client' : undefined),
          branchName: sale.branch?.name,
          createdAt: sale.createdAt,
        };

        if (isRetail) {
          retailItems.push(itemData);
          retailTotal += subtotal;
          retailDiscountTotal += discount;
          retailItemsCount += qty;
        } else if (isWholesale) {
          wholesaleItems.push(itemData);
          wholesaleTotal += subtotal;
          wholesaleDiscountTotal += discount;
          wholesaleItemsCount += qty;
        }
      }
    }

    // Expenses for the day
    const expenseWhere: any = {
      status: 'APPROVED',
      createdAt: { gte: startOfDay, lte: endOfDay },
    };
    if (branchId && branchId !== 'all') {
      expenseWhere.branchId = branchId;
    }

    const expenses = await this.prisma.expense.findMany({
      where: expenseWhere,
      include: {
        branch: { select: { name: true } },
      },
    });

    // Check if petty cash is in expenses or configured on branch/manager
    let pettyCashTotal = expenses
      .filter((e) => e.category === 'PETTY_CASH')
      .reduce((sum, e) => sum + Number(e.amount), 0);

    if (pettyCashTotal === 0 && sales.length > 0 && branchId && branchId !== 'all') {
      const branch = await this.prisma.branch.findUnique({
        where: { id: branchId },
        include: {
          manager: true,
          users: { where: { status: 'ACTIVE' } },
        },
      });

      if (branch?.manager && Number(branch.manager.dailyPettyCash || 0) > 0) {
        pettyCashTotal = Number(branch.manager.dailyPettyCash);
      } else if (branch?.users && branch.users.length > 0) {
        const mgr =
          branch.users.find(
            (u) => u.role === 'BRANCH_MANAGER' && Number(u.dailyPettyCash || 0) > 0,
          ) || branch.users.find((u) => Number(u.dailyPettyCash || 0) > 0);
        if (mgr) {
          pettyCashTotal = Number(mgr.dailyPettyCash || 0);
        }
      }
    }

    const regularExpenseTotal = expenses
      .filter((e) => e.category !== 'PETTY_CASH')
      .reduce((sum, e) => sum + Number(e.amount), 0);

    const totalExpensesInclusive = regularExpenseTotal + pettyCashTotal;
    const netSales = retailTotal + wholesaleTotal;
    const difference1 = netSales - paybillTotal;
    const difference2 = difference1 - totalExpensesInclusive;
    const amountToBeSubmittedCash = difference2;

    const grandTotal = retailTotal + wholesaleTotal;
    const totalDiscount = retailDiscountTotal + wholesaleDiscountTotal;
    const netTotal = grandTotal - totalExpensesInclusive;

    return {
      date: reportDateStr,
      branchId: branchId || 'all',
      retailSales: {
        items: retailItems,
        total: retailTotal,
        discountTotal: retailDiscountTotal,
        itemsCount: retailItemsCount,
      },
      wholesaleSales: {
        items: wholesaleItems,
        total: wholesaleTotal,
        discountTotal: wholesaleDiscountTotal,
        itemsCount: wholesaleItemsCount,
      },
      expenses: {
        items: expenses.map((e) => ({
          id: e.id,
          category: e.category,
          amount: Number(e.amount),
          description: e.description,
          branchName: e.branch?.name,
        })),
        total: totalExpensesInclusive,
        regularTotal: regularExpenseTotal,
        pettyCashTotal,
      },
      summary: {
        retailTotal,
        wholesaleTotal,
        totalDiscount,
        grandTotal,
        netSales,
        paybillTotal: Math.round(paybillTotal * 100) / 100,
        cashSalesTotal: Math.round(cashSalesTotal * 100) / 100,
        difference1: Math.round(difference1 * 100) / 100,
        expenseTotal: Math.round(totalExpensesInclusive * 100) / 100,
        regularExpenseTotal: Math.round(regularExpenseTotal * 100) / 100,
        pettyCashTotal: Math.round(pettyCashTotal * 100) / 100,
        difference2: Math.round(difference2 * 100) / 100,
        amountToBeSubmittedCash: Math.round(amountToBeSubmittedCash * 100) / 100,
        netTotal: Math.round(netTotal * 100) / 100,
      },
    };
  }

  async archiveDailyReport(branchId: string, dateStr?: string) {
    if (!branchId || branchId === 'all') {
      throw new BadRequestException('Branch ID is required to archive a daily report.');
    }
    const reportData = await this.getLiveDailySales(branchId, dateStr);
    const reportDate = getNairobiCalendarDate(reportData.date);

    // Delete existing archive for this branch and date if any to refresh cleanly
    await this.prisma.dailyReport.deleteMany({
      where: {
        branchId,
        reportDate,
      },
    });

    const created = await this.prisma.dailyReport.create({
      data: {
        branchId,
        reportDate,
        retailSalesTotal: reportData.summary.retailTotal,
        retailItemsCount: reportData.retailSales.itemsCount,
        retailDiscountTotal: reportData.retailSales.discountTotal,
        wholesaleSalesTotal: reportData.summary.wholesaleTotal,
        wholesaleItemsCount: reportData.wholesaleSales.itemsCount,
        expenseTotal: reportData.summary.expenseTotal,
        grandTotal: reportData.summary.grandTotal,
        netTotal: reportData.summary.netTotal,
        isArchived: true,
        archivedAt: new Date(),
        salesItems: {
          create: [
            ...reportData.retailSales.items.map((i) => ({
              productId: i.productId,
              productNameSnapshot: i.productName,
              saleType: 'CASH' as any,
              markedPrice: i.markedPrice,
              sellingPrice: i.sellingPrice,
              quantity: i.quantity,
              discount: i.discount,
              subtotal: i.subtotal,
              isRetailSale: true,
            })),
            ...reportData.wholesaleSales.items.map((i) => ({
              productId: i.productId,
              productNameSnapshot: i.productName,
              customerName: i.customerName,
              saleType: 'WHOLESALE' as any,
              markedPrice: i.markedPrice,
              sellingPrice: i.sellingPrice,
              quantity: i.quantity,
              discount: i.discount,
              subtotal: i.subtotal,
              isRetailSale: false,
            })),
          ],
        },
        expenses: {
          create: reportData.expenses.items.map((e) => ({
            expenseCategory: e.category,
            amount: e.amount,
            description: e.description,
          })),
        },
      },
      include: {
        salesItems: true,
        expenses: true,
        branch: { select: { name: true } },
      },
    });

    return created;
  }

  async getArchivedReports(branchId?: string, startDate?: string, endDate?: string) {
    const where: any = { isArchived: true };
    if (branchId && branchId !== 'all') {
      where.branchId = branchId;
    }
    if (startDate && endDate) {
      where.reportDate = {
        gte: new Date(startDate),
        lte: new Date(endDate),
      };
    }

    return this.prisma.dailyReport.findMany({
      where,
      include: {
        branch: { select: { id: true, name: true } },
        salesItems: true,
        expenses: true,
      },
      orderBy: { reportDate: 'desc' },
    });
  }
}
