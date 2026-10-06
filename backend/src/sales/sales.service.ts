import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  UserRole,
  SaleType,
  SaleStatus,
  MovementType,
  ProductType,
  LpgSaleVariant,
  PaymentProvider,
  AuditAction,
} from '@prisma/client';
import { CreateSaleDto } from './dto/create-sale.dto';
import { TransfersService } from '../transfers/transfers.service';
import { MpesaService } from '../mpesa/mpesa.service';

@Injectable()
export class SalesService {
  constructor(
    private prisma: PrismaService,
    private auditLogsService: AuditLogsService,
    private notificationsService: NotificationsService,
    private transfersService: TransfersService,
    private mpesaService: MpesaService,
  ) {}

  async create(createSaleDto: CreateSaleDto, user: any) {
    const { branchId, type, customerId, items, notes, payments } =
      createSaleDto;

    if (user.role !== UserRole.SUPER_ADMIN && !user.branchId) {
      throw new ForbiddenException(
        'You are not assigned to any branch. Please contact your administrator to be assigned a branch.',
      );
    }

    if (
      user.role === UserRole.BRANCH_MANAGER &&
      user.branchId !== branchId
    ) {
      throw new ForbiddenException(
        'You can only create sales for your assigned branch',
      );
    }

    const targetBranch = await this.prisma.branch.findUnique({ where: { id: branchId } });
    if (!targetBranch) throw new NotFoundException('Branch not found');
    if (targetBranch.code?.trim().toUpperCase() === 'HQ' && user.role !== UserRole.SUPER_ADMIN) {
      throw new ForbiddenException('Only administrators have access to manage or record sales for Headquarters.');
    }

    if (type === SaleType.INVOICE && !customerId) {
      throw new BadRequestException('A registered customer is required for invoice sales.');
    }

    // ── 1. IDEMPOTENCY CHECK ───────────────────────────────────────────────
    if (createSaleDto.idempotencyKey) {
      const existingSale = await this.prisma.sale.findUnique({
        where: { idempotencyKey: createSaleDto.idempotencyKey },
        include: {
          saleItems: { include: { product: true } },
          payments: true,
          branch: true,
          user: { select: { id: true, firstName: true, lastName: true } },
          customer: true,
        },
      });
      if (existingSale) {
        return existingSale;
      }
    }

    // ── 2. PRE-CALCULATION, PRICING & CYLINDER VALIDATION ───────────────────
    let subtotal = 0;
    let totalDiscount = 0;
    const saleItems: any[] = [];

    for (const item of items) {
      const product = await this.prisma.product.findUnique({
        where: { id: item.productId },
      });
      if (!product) {
        throw new BadRequestException(`Product with ID ${item.productId} not found`);
      }
      const variant = this.resolveVariant(product.type, item.lpgVariant);

      let basePrice = Number(product.price);
      let emptyPrice = Number(product.emptyPrice || 0);

      if (type === SaleType.WHOLESALE) {
        basePrice = Number((product as any).wholesalePrice || product.price);
        emptyPrice = Number((product as any).wholesaleEmptyPrice || product.emptyPrice || 0);
      }

      let unitPrice = basePrice;
      if (variant === LpgSaleVariant.EMPTY_SHELL) {
        unitPrice = emptyPrice;
        if (emptyPrice === 0) throw new BadRequestException(`Empty shell price is not configured for ${product.name}`);
      } else if (variant === LpgSaleVariant.COMPLETE_SET) {
        if (emptyPrice === 0) throw new BadRequestException(`Empty shell price is not configured for ${product.name}`);
        unitPrice = basePrice + emptyPrice;
      }

      const lineSubtotal = unitPrice * item.quantity;
      const itemDiscount = Math.min(Math.max(0, Number(item.discount || 0)), lineSubtotal);
      const lineTotal = lineSubtotal - itemDiscount;
      subtotal += lineSubtotal;
      totalDiscount += itemDiscount;

      // Validate cylinder selection if provided
      let assignedCylinderId = item.cylinderId;
      if (assignedCylinderId) {
        const cyl = await this.prisma.cylinder.findUnique({ where: { id: assignedCylinderId } });
        if (!cyl) {
          throw new BadRequestException(`Cylinder with ID ${assignedCylinderId} not found`);
        }
        if (cyl.branchId !== branchId) {
          throw new BadRequestException(`Cylinder ${cyl.serialNumber} does not belong to this branch`);
        }
        if (cyl.productId !== item.productId) {
          throw new BadRequestException(`Cylinder ${cyl.serialNumber} does not match product ${product.name}`);
        }
        if (variant === LpgSaleVariant.EMPTY_SHELL) {
          if (cyl.status !== 'EMPTY') {
            throw new BadRequestException(`Cylinder ${cyl.serialNumber} is not EMPTY (current status: ${cyl.status})`);
          }
        } else {
          if (cyl.status !== 'FULL') {
            throw new BadRequestException(`Cylinder ${cyl.serialNumber} is not FULL (current status: ${cyl.status})`);
          }
        }
      }

      saleItems.push({
        productId: item.productId,
        productNameSnapshot: product.name,
        variantSnapshot: variant ? String(variant) : undefined,
        quantity: item.quantity,
        unitPrice,
        discount: itemDiscount,
        total: lineTotal,
        lpgVariant: variant ?? undefined,
        cylinderId: assignedCylinderId || undefined,
      });
    }

    const total = Math.max(0, subtotal - totalDiscount);

    // ── 3. DISCOUNT AUTHORIZATION & THRESHOLD CHECK ─────────────────────────
    if (totalDiscount > 0 && user.role === UserRole.BRANCH_MANAGER) {
      const isExceeded = totalDiscount > 500 || totalDiscount > (subtotal * 0.10 + 0.01);
      if (isExceeded) {
        const overrideSetting = await this.prisma.systemSetting.findUnique({
          where: { key: 'DISCOUNT_OVERRIDE_CODE' },
        });
        const validCode = overrideSetting?.value || 'ADMIN123';
        if (!createSaleDto.managerOverrideCode || createSaleDto.managerOverrideCode.trim() !== validCode.trim()) {
          throw new BadRequestException(
            `Discount of KES ${totalDiscount.toFixed(2)} exceeds branch manager authorization limit (Max 10% or KES 500). A valid manager override code is required.`,
          );
        }
      }
    }

    // Unique sale code
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let saleCode = '';
    do {
      saleCode = Array.from(
        { length: 6 },
        () => chars.charAt(Math.floor(Math.random() * chars.length)),
      ).join('');
    } while (await this.prisma.sale.findUnique({ where: { saleCode } }));

    // ── 4. PAYMENT AMOUNT VALIDATION & PROCESSING (CASH & PAYBILL ONLY) ────
    let derivedPaymentRef: string | null = null;
    let finalNotes = notes || '';
    const paymentRecords: any[] = [];
    let hasPaybill = false;

    if (type !== SaleType.INVOICE) {
      const totalPaid = (payments && payments.length > 0)
        ? payments.reduce((sum, p) => sum + Number(p.amount || 0), 0)
        : total;

      if (totalPaid < total) {
        throw new BadRequestException(
          `Underpayment not permitted. Total is KES ${total.toFixed(2)}, but total payments provided are KES ${totalPaid.toFixed(2)}`,
        );
      }

      const nonCashTotal = payments
        ? payments.filter((p) => String(p.method).toUpperCase() !== 'CASH').reduce((s, p) => s + Number(p.amount || 0), 0)
        : 0;

      if (nonCashTotal > total) {
        throw new BadRequestException(
          `Non-cash overpayment is not permitted. Non-cash payments sum to KES ${nonCashTotal.toFixed(2)} for a total of KES ${total.toFixed(2)}`,
        );
      }

      const changeTendered = totalPaid - total;
      if (changeTendered > 0) {
        finalNotes = (finalNotes ? `${finalNotes} | ` : '') +
          `Cash tendered: KES ${totalPaid.toFixed(2)}, Change given: KES ${changeTendered.toFixed(2)}`;
      }

      // Record payments: non-cash exact, cash adjusted for net cash collected in drawer
      let remainingToCover = total;
      if (payments && payments.length > 0) {
        for (const p of payments) {
          const m = String(p.method).toUpperCase();
          if (m !== 'CASH' && p.amount > 0) {
            hasPaybill = true;
            const ref = p.paymentRef || p.mpesaRef || null;
            if (ref) derivedPaymentRef = ref;
            paymentRecords.push({
              method: PaymentProvider.PAYBILL,
              amount: p.amount,
              paymentRef: ref,
              customerName: p.customerName || createSaleDto.customerName || null,
              mpesaRef: ref,
            });
            remainingToCover -= p.amount;
          }
        }
        const cashPayments = payments.filter((p) => String(p.method).toUpperCase() === 'CASH');
        if (cashPayments.length > 0) {
          paymentRecords.push({
            method: PaymentProvider.CASH,
            amount: Math.max(0, remainingToCover),
            mpesaRef: null,
            paymentRef: null,
            customerName: null,
          });
        }
      } else {
        paymentRecords.push({
          method: PaymentProvider.CASH,
          amount: total,
          mpesaRef: null,
          paymentRef: null,
          customerName: null,
        });
      }
    }

    const derivedPaymentProvider: PaymentProvider = hasPaybill
      ? PaymentProvider.PAYBILL
      : PaymentProvider.CASH;

    // ── 6. ATOMIC TRANSACTION (Stock Deductions, Payments, Customer Debt) ──
    let sale: any;
    try {
      sale = await this.prisma.$transaction(async (tx) => {
        // A. Customer Debt Tracking
        if (type === SaleType.INVOICE && customerId) {
          const customer = await tx.customer.findUnique({ where: { id: customerId } });
          if (!customer) throw new NotFoundException('Customer not found');
          const currentDebt = Number(customer.creditUsed || 0);
          const creditLimit = Number(customer.creditLimit || 0);
          if (creditLimit > 0 && currentDebt + total > creditLimit) {
            throw new BadRequestException(
              `Credit limit exceeded for ${customer.name}. Current debt: KES ${currentDebt.toFixed(2)}, Limit: KES ${creditLimit.toFixed(2)}, This Sale: KES ${total.toFixed(2)}`,
            );
          }
          await tx.customer.update({
            where: { id: customerId },
            data: {
              creditUsed: { increment: total },
              totalPurchases: { increment: total },
            },
          });
        } else if (customerId) {
          await tx.customer.update({
            where: { id: customerId },
            data: { totalPurchases: { increment: total } },
          });
        }

        // B. Create Sale Record
        const newSale = await tx.sale.create({
          data: {
            saleCode,
            branchId,
            userId: user.userId,
            customerId,
            type,
            status: SaleStatus.COMPLETED,
            subtotal,
            discount: totalDiscount,
            total,
            paymentProvider: derivedPaymentProvider,
            mpesaRef: derivedPaymentRef || null,
            notes: finalNotes || null,
            idempotencyKey: createSaleDto.idempotencyKey || null,
            saleItems: { create: saleItems },
            payments: { create: paymentRecords },
          },
          include: {
            saleItems: { include: { product: true } },
            payments: true,
            branch: true,
            user: { select: { id: true, firstName: true, lastName: true } },
            customer: true,
          },
        });

        // C. Link Matching M-Pesa Transaction if provided
        if (derivedPaymentRef) {
          await tx.mpesaTransaction.updateMany({
            where: { receiptNumber: derivedPaymentRef, saleId: null },
            data: { saleId: newSale.id },
          });
        }

        // D. Automatic Invoice Generation
        if (type === SaleType.INVOICE && customerId) {
          const invCount = await tx.invoice.count();
          const invoiceCode = `INV-${String(invCount + 1).padStart(5, '0')}`;

          await tx.invoice.create({
            data: {
              invoiceCode,
              branchId,
              customerId,
              userId: user.userId,
              saleId: newSale.id,
              status: 'PENDING',
              subtotal,
              discount: totalDiscount,
              total,
              balance: total,
              dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
              notes: notes || 'Auto-generated from POS checkout',
            },
          });
        }

        // E. Atomic Stock Deductions (using updateMany with gte guards)
        for (const item of items) {
          const product = await tx.product.findUnique({
            where: { id: item.productId },
          });
          const variant = this.resolveVariant(product!.type, item.lpgVariant);
          let quantityDelta = -item.quantity;

          if (product!.type === ProductType.LPG_REFILL) {
            if (variant === LpgSaleVariant.REFILL) {
              const res = await tx.inventory.updateMany({
                where: {
                  branchId,
                  productId: item.productId,
                  fullCylinders: { gte: item.quantity },
                },
                data: {
                  fullCylinders: { decrement: item.quantity },
                  totalSold: { increment: item.quantity },
                },
              });
              if (res.count !== 1) {
                throw new BadRequestException(`Insufficient full cylinders for ${product!.name}`);
              }
              quantityDelta = 0;
            } else if (variant === LpgSaleVariant.EMPTY_SHELL) {
              const res = await tx.inventory.updateMany({
                where: {
                  branchId,
                  productId: item.productId,
                  quantity: { gte: item.quantity },
                },
                data: {
                  quantity: { decrement: item.quantity },
                  totalSold: { increment: item.quantity },
                },
              });
              if (res.count !== 1) {
                throw new BadRequestException(`Insufficient empty shells for ${product!.name}`);
              }
            } else if (variant === LpgSaleVariant.COMPLETE_SET) {
              const res = await tx.inventory.updateMany({
                where: {
                  branchId,
                  productId: item.productId,
                  quantity: { gte: item.quantity },
                  fullCylinders: { gte: item.quantity },
                },
                data: {
                  quantity: { decrement: item.quantity },
                  fullCylinders: { decrement: item.quantity },
                  totalSold: { increment: item.quantity },
                },
              });
              if (res.count !== 1) {
                throw new BadRequestException(`Insufficient stock or full cylinders for ${product!.name}`);
              }
            }
          } else if (product!.type === ProductType.LPG_CYLINDER) {
            const res = await tx.inventory.updateMany({
              where: {
                branchId,
                productId: item.productId,
                quantity: { gte: item.quantity },
                fullCylinders: { gte: item.quantity },
              },
              data: {
                quantity: { decrement: item.quantity },
                fullCylinders: { decrement: item.quantity },
                totalSold: { increment: item.quantity },
              },
            });
            if (res.count !== 1) {
              throw new BadRequestException(`Insufficient stock for ${product!.name}`);
            }
          } else {
            const res = await tx.inventory.updateMany({
              where: {
                branchId,
                productId: item.productId,
                quantity: { gte: item.quantity },
              },
              data: {
                quantity: { decrement: item.quantity },
                totalSold: { increment: item.quantity },
              },
            });
            if (res.count !== 1) {
              throw new BadRequestException(`Insufficient stock for ${product!.name}`);
            }
          }

          // Update cylinder status if tracked
          if (item.cylinderId) {
            await tx.cylinder.updateMany({
              where: { id: item.cylinderId, branchId },
              data: { status: 'EMPTY' },
            });
          } else if (item.serialNumber) {
            await tx.cylinder.updateMany({
              where: { serialNumber: item.serialNumber, branchId },
              data: { status: 'EMPTY' },
            });
          }

          // Stock Movement
          const inv = await tx.inventory.findUnique({
            where: { branchId_productId: { branchId, productId: item.productId } },
          });
          await tx.stockMovement.create({
            data: {
              inventoryId: inv!.id,
              type: MovementType.SALE,
              quantity: quantityDelta,
              referenceId: newSale.id,
              referenceType: 'Sale',
              performedById: user.userId,
              notes: `Sale ${saleCode}${variant ? ` (${variant})` : ''}`,
            },
          });
        }

        return newSale;
      });
    } catch (err: any) {
      if (err.code === 'P2002' && createSaleDto.idempotencyKey) {
        return this.prisma.sale.findUnique({
          where: { idempotencyKey: createSaleDto.idempotencyKey },
          include: {
            saleItems: { include: { product: true } },
            payments: true,
            branch: true,
            user: { select: { id: true, firstName: true, lastName: true } },
            customer: true,
          },
        });
      }
      throw err;
    }

    // ── 7. AUDIT LOGGING & NOTIFICATIONS ───────────────────────────────────
    if (totalDiscount > 0) {
      await this.auditLogsService.create({
        userId: user.userId,
        action: AuditAction.DISCOUNT_APPLIED,
        description: `Applied discount of KES ${totalDiscount.toFixed(2)} on sale ${saleCode}. Reason: ${createSaleDto.discountReason || 'None'}`,
        entityType: 'Sale',
        entityId: sale.id,
        newValues: { totalDiscount, discountReason: createSaleDto.discountReason },
      });
    }

    await this.auditLogsService.create({
      userId: user.userId,
      action: 'SALE_CREATED',
      description: `Created ${type} sale ${saleCode} for KES ${total.toFixed(2)}${totalDiscount > 0 ? ` (discount: KES ${totalDiscount.toFixed(2)})` : ''}`,
      entityType: 'Sale',
      entityId: sale.id,
      newValues: { type, total, items: saleItems },
    });

    await this.prisma.activityFeed.create({
      data: {
        type: 'SALE_COMPLETED',
        branchId: sale.branchId,
        title: type === SaleType.INVOICE ? 'Invoice Created' : 'Sale Completed',
        message: `${type} sale ${saleCode} for KES ${total.toFixed(2)}`,
        entityId: sale.id,
        entityType: 'Sale',
        visibleToBranch: true,
      },
    });

    if (type === SaleType.INVOICE) {
      const admins = await this.prisma.user.findMany({
        where: { role: { in: [UserRole.SUPER_ADMIN, UserRole.OVERALL_MANAGER] } },
        select: { id: true },
      });
      const branch = await this.prisma.branch.findUnique({ where: { id: branchId } });
      await Promise.all(
        admins.map((admin) =>
          this.notificationsService.create({
            type: 'INVOICE_CREATED',
            title: 'New Invoice Issued',
            message: `${branch?.name} issued an invoice (${saleCode}) for KES ${total.toFixed(2)}`,
            userId: admin.id,
            entityId: sale.id,
            entityType: 'Sale',
          }),
        ),
      );
    }

    // Check & auto-cancel pending transfers if stock is now insufficient
    try {
      await this.transfersService.cancelPendingTransfersWithInsufficientStock(
        branchId,
        items.map((i) => i.productId),
      );
    } catch (err) {
      console.error('Failed to auto-cancel pending transfers with insufficient stock:', err);
    }

    return sale;
  }

  async cancel(id: string, user: any) {
    const sale = await this.prisma.sale.findUnique({
      where: { id },
      include: { payments: true },
    });
    if (!sale) throw new NotFoundException('Sale not found');
    if (user.role === UserRole.BRANCH_MANAGER && user.branchId !== sale.branchId) {
      throw new ForbiddenException('You can only cancel sales for your branch');
    }
    if (sale.status === SaleStatus.COMPLETED) {
      throw new BadRequestException('Cannot cancel a completed sale. Use returns/refunds instead.');
    }
    if (sale.status === SaleStatus.CANCELLED) {
      return sale;
    }
    return this.prisma.sale.update({
      where: { id },
      data: {
        status: SaleStatus.CANCELLED,
        notes: (sale.notes ? `${sale.notes} | ` : '') + `Cancelled by ${user.email || user.userId}`,
      },
    });
  }

  async findAll(query: {
    branchId?: string;
    startDate?: string;
    endDate?: string;
    type?: string;
    search?: string;
    user?: any;
  }) {
    const { branchId, startDate, endDate, type, search, user } = query;
    const where: any = {
      status: { not: 'RETURNED' },
    };

    if (branchId) {
      if (
        user?.role === UserRole.BRANCH_MANAGER &&
        user.branchId !== branchId
      ) {
        throw new ForbiddenException('You can only view your branch sales');
      }
      where.branchId = branchId;
    } else if (user?.role === UserRole.BRANCH_MANAGER) {
      where.branchId = user.branchId;
    }

    if (startDate && endDate) {
      where.createdAt = { gte: new Date(startDate), lte: new Date(endDate) };
    }
    if (type) where.type = type;
    if (search) where.saleCode = { contains: search, mode: 'insensitive' };

    return this.prisma.sale.findMany({
      where,
      include: {
        saleItems: { include: { product: true } },
        payments: true,
        branch: { select: { id: true, name: true, code: true } },
        user: { select: { id: true, firstName: true, lastName: true } },
        customer: { select: { id: true, name: true, phone: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string, user?: any) {
    const sale = await this.prisma.sale.findUnique({
      where: { id },
      include: {
        saleItems: { include: { product: true } },
        payments: true,
        branch: true,
        user: { select: { id: true, firstName: true, lastName: true } },
        customer: true,
        returns: true,
      },
    });

    if (!sale) throw new NotFoundException('Sale not found');
    if (
      user?.role === UserRole.BRANCH_MANAGER &&
      user.branchId !== sale.branchId
    ) {
      throw new ForbiddenException('You can only view your branch sales');
    }
    return sale;
  }

  async findByCode(saleCode: string, user?: any) {
    const sale = await this.prisma.sale.findUnique({
      where: { saleCode },
      include: {
        saleItems: { include: { product: true } },
        payments: true,
        branch: true,
        user: { select: { id: true, firstName: true, lastName: true } },
        customer: true,
        returns: true,
      },
    });

    if (!sale) throw new NotFoundException('Sale not found');
    if (
      user?.role === UserRole.BRANCH_MANAGER &&
      user.branchId !== sale.branchId
    ) {
      throw new ForbiddenException('You can only view your branch sales');
    }
    return sale;
  }

  async getWeeklySales(year?: number, week?: number, user?: any) {
    const now = new Date();
    const targetYear = year || now.getFullYear();
    const targetWeek = week || this.getWeekNumber(now);

    const weekStart = this.getWeekStartDate(targetYear, targetWeek);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 6);
    weekEnd.setHours(23, 59, 59, 999);

    const where: any = {
      createdAt: { gte: weekStart, lte: weekEnd },
      status: SaleStatus.COMPLETED,
    };
    if (user?.role === UserRole.BRANCH_MANAGER) {
      where.branchId = user.branchId;
    }

    const sales = await this.prisma.sale.findMany({
      where,
      include: {
        saleItems: { include: { product: true } },
        branch: { select: { name: true } },
        user: { select: { firstName: true, lastName: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const groupedByDate: Record<string, typeof sales> = {};
    sales.forEach((sale) => {
      const date = sale.createdAt.toISOString().split('T')[0];
      if (!groupedByDate[date]) groupedByDate[date] = [];
      groupedByDate[date].push(sale);
    });

    return {
      weekStart: weekStart.toISOString().split('T')[0],
      weekEnd: weekEnd.toISOString().split('T')[0],
      weekNumber: targetWeek,
      year: targetYear,
      totalSales: sales.length,
      totalAmount: sales.reduce((sum, s) => sum + Number(s.total), 0),
      groupedByDate,
      sales,
    };
  }

  private getWeekNumber(date: Date): number {
    const d = new Date(
      Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()),
    );
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil(
      ((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7,
    );
  }

  private getWeekStartDate(year: number, week: number): Date {
    const jan4 = new Date(year, 0, 4);
    const jan4Day = jan4.getDay() || 7;
    const firstMonday = new Date(jan4);
    firstMonday.setDate(jan4.getDate() - jan4Day + 1);
    return new Date(firstMonday.getTime() + (week - 1) * 7 * 86400000);
  }

  private resolveVariant(
    productType: ProductType,
    requested?: LpgSaleVariant,
  ): LpgSaleVariant | null {
    if (productType !== ProductType.LPG_REFILL) return null;
    return requested ?? LpgSaleVariant.REFILL;
  }
}
