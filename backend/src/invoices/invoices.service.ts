import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UserRole } from '@prisma/client';

@Injectable()
export class InvoicesService {
  constructor(private prisma: PrismaService) {}

  async create(data: any, user: any) {
    throw new BadRequestException('Invoices must be created via the New Sale POS interface.');
  }

  async findAll(query: any) {
    const { branchId, status, search, user } = query;
    const where: any = {};

    if (user?.role === UserRole.BRANCH_MANAGER) {
      where.branchId = user.branchId;
    } else if (branchId) {
      where.branchId = branchId;
    }

    if (status) where.status = status;
    if (search) {
      where.OR = [
        { invoiceCode: { contains: search, mode: 'insensitive' } },
        { customer: { name: { contains: search, mode: 'insensitive' } } }
      ];
    }

    return this.prisma.invoice.findMany({
      where,
      include: {
        customer: true,
        branch: { select: { id: true, name: true } },
        sale: { 
          include: { 
            // 🚀 THE FIX: We are now fetching the user who created the sale!
            user: { select: { firstName: true, lastName: true } },
            saleItems: { include: { product: true } } 
          } 
        }
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string, user?: any) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id },
      include: {
        customer: true,
        branch: true,
        sale: { 
          include: { 
            user: { select: { firstName: true, lastName: true } },
            saleItems: { include: { product: true } } 
          } 
        }
      }
    });

    if (!invoice) throw new NotFoundException('Invoice not found');

    if (user?.role === UserRole.BRANCH_MANAGER && invoice.branchId !== user.branchId) {
      throw new ForbiddenException('You can only view invoices for your assigned branch');
    }

    return invoice;
  }

  async getDashboardStats(user?: any) {
    const where: any = {};
    
    if (user?.role === UserRole.BRANCH_MANAGER) {
      where.branchId = user.branchId;
    }

    const invoices = await this.prisma.invoice.findMany({ where });

    const totalOutstanding = invoices.reduce((sum, inv) => sum + Number(inv.balance || 0), 0);
    const totalPaid = invoices.reduce((sum, inv) => sum + Number(inv.amountPaid || 0), 0);
    const overdueCount = invoices.filter(inv => inv.dueDate && new Date(inv.dueDate) < new Date() && Number(inv.balance) > 0).length;

    return {
      totalInvoices: invoices.length,
      totalOutstanding,
      totalPaid,
      overdueCount
    };
  }

  async recordPayment(
    id: string,
    amount: number,
    performedById: string,
    paymentMethod = 'CASH',
    mpesaRef?: string,
  ) {
    if (amount <= 0) throw new BadRequestException('Payment amount must be greater than zero');

    const invoice = await this.prisma.invoice.findUnique({
      where: { id },
      include: { customer: true, branch: true },
    });
    if (!invoice) throw new NotFoundException('Invoice not found');

    if (Number(invoice.balance) < amount) {
      throw new BadRequestException(`Payment amount (${amount}) exceeds the remaining balance (${invoice.balance})`);
    }

    const newAmountPaid = Number(invoice.amountPaid || 0) + amount;
    const newBalance = Number(invoice.total) - newAmountPaid;
    const newStatus = newBalance <= 0 ? 'PAID' : 'PENDING';

    const updatedInvoice = await this.prisma.$transaction(async (tx) => {
      // 1. Update Invoice balance
      const updated = await tx.invoice.update({
        where: { id },
        data: {
          amountPaid: newAmountPaid,
          balance: newBalance,
          status: newStatus,
          paidAt: newBalance <= 0 ? new Date() : null,
        },
        include: { customer: true, branch: true },
      });

      // 2. Decrement Customer debt
      if (invoice.customerId) {
        await tx.customer.update({
          where: { id: invoice.customerId },
          data: { creditUsed: { decrement: amount } },
        });
      }

      // 3. Record in SalePayment if linked to a sale
      if (invoice.saleId) {
        await tx.salePayment.create({
          data: {
            saleId: invoice.saleId,
            method: (paymentMethod as any) || 'CASH',
            amount,
            mpesaRef: mpesaRef || null,
          },
        });
      }

      return updated;
    });

    await this.prisma.activityFeed.create({
      data: {
        type: 'PAYMENT_RECEIVED',
        branchId: updatedInvoice.branchId,
        title: 'Invoice Payment Received',
        message: `Payment of KES ${amount.toFixed(2)} (${paymentMethod}) received for Invoice ${updatedInvoice.invoiceCode}`,
        entityId: updatedInvoice.id,
        entityType: 'Invoice',
        visibleToBranch: true,
      },
    });

    await this.prisma.auditLog.create({
      data: {
        userId: performedById,
        action: 'INVOICE_PAID' as any,
        entityType: 'Invoice',
        entityId: updatedInvoice.id,
        description: `Payment of KES ${amount.toFixed(2)} (${paymentMethod}${mpesaRef ? ` - ${mpesaRef}` : ''}) recorded for Invoice ${updatedInvoice.invoiceCode}`,
        newValues: {
          invoiceId: updatedInvoice.id,
          invoiceCode: updatedInvoice.invoiceCode,
          amountPaid: amount,
          balance: newBalance,
          paymentMethod,
          mpesaRef: mpesaRef || null,
        },
      },
    });

    return updatedInvoice;
  }

  async cancel(id: string) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id },
      include: {
        sale: {
          include: {
            saleItems: { include: { product: true } },
          },
        },
      },
    });
    if (!invoice) throw new NotFoundException('Invoice not found');

    if (invoice.status === 'PAID') {
      throw new BadRequestException('Cannot cancel an invoice that has already been fully paid');
    }

    await this.prisma.$transaction(async (tx) => {
      // 1. Mark Invoice as CANCELLED
      await tx.invoice.update({
        where: { id },
        data: { status: 'CANCELLED' },
      });

      // 2. Restore customer credit/debt
      if (invoice.customerId && Number(invoice.balance) > 0) {
        await tx.customer.update({
          where: { id: invoice.customerId },
          data: { creditUsed: { decrement: Number(invoice.balance) } },
        });
      }

      // 3. Mark linked Sale as CANCELLED & restore inventory stock
      if (invoice.sale) {
        await tx.sale.update({
          where: { id: invoice.sale.id },
          data: { status: 'CANCELLED' },
        });

        for (const item of invoice.sale.saleItems) {
          const inv = await tx.inventory.findUnique({
            where: {
              branchId_productId: {
                branchId: invoice.branchId,
                productId: item.productId,
              },
            },
          });

          if (inv) {
            let updateData: any = {
              totalSold: { decrement: item.quantity },
            };

            if (item.product.type === 'LPG_REFILL') {
              if (item.lpgVariant === 'REFILL') {
                updateData.fullCylinders = { increment: item.quantity };
              } else if (item.lpgVariant === 'EMPTY_SHELL') {
                updateData.quantity = { increment: item.quantity };
              } else if (item.lpgVariant === 'COMPLETE_SET') {
                updateData.fullCylinders = { increment: item.quantity };
                updateData.quantity = { increment: item.quantity };
              }
            } else if (item.product.type === 'LPG_CYLINDER') {
              updateData.fullCylinders = { increment: item.quantity };
              updateData.quantity = { increment: item.quantity };
            } else {
              updateData.quantity = { increment: item.quantity };
            }

            await tx.inventory.update({
              where: { id: inv.id },
              data: updateData,
            });

            await tx.stockMovement.create({
              data: {
                inventoryId: inv.id,
                type: 'ADJUSTMENT',
                quantity: item.quantity,
                referenceId: invoice.id,
                referenceType: 'Invoice Cancellation',
                notes: `Stock restored from cancelled invoice ${invoice.invoiceCode}`,
              },
            });
          }
        }
      }
    });

    return { message: 'Invoice cancelled successfully and inventory restored' };
  }
}
