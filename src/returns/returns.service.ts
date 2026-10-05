import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ReturnStatus, MovementType, UserRole } from '@prisma/client';
import { CreateReturnDto } from './dto/create-return.dto';

@Injectable()
export class ReturnsService {
  constructor(
    private prisma: PrismaService,
    private notificationsService: NotificationsService,
  ) {}

  async create(createReturnDto: CreateReturnDto, user: any) {
    const { saleId, reason, amount, items } = createReturnDto;

    const sale = await this.prisma.sale.findUnique({
      where: { id: saleId },
      include: { saleItems: { include: { product: true } }, branch: true },
    });

    if (!sale) throw new NotFoundException('Sale not found');

    const existingReturn = await this.prisma.return.findFirst({
      where: { saleId, status: { in: ['PENDING', 'APPROVED'] } },
    });
    if (existingReturn) {
      throw new BadRequestException('A return request already exists for this sale');
    }

    const count = await this.prisma.return.count();
    const returnCode = `RTN-${String(count + 1).padStart(5, '0')}`;

    const calculatedRefund = amount
      ? amount
      : items && items.length > 0
        ? items.reduce((sum, i) => sum + Number(i.refundAmount || 0), 0)
        : Number(sale.total);

    const returnRequest = await this.prisma.return.create({
      data: {
        returnCode,
        saleId,
        branchId: sale.branchId,
        userId: user.userId,
        reason,
        refundAmount: calculatedRefund,
        status: ReturnStatus.PENDING,
        ...(items && items.length > 0
          ? {
              items: {
                create: items.map((i) => ({
                  productId: i.productId,
                  quantity: i.quantity,
                  refundAmount: i.refundAmount || 0,
                  lpgVariant: i.lpgVariant,
                })),
              },
            }
          : {}),
      },
      include: {
        items: true,
        sale: { include: { saleItems: { include: { product: true } } } },
        user: { select: { firstName: true, lastName: true } },
      },
    });

    // Notify all admins who need to action the return — NOT the submitter.
    const admins = await this.prisma.user.findMany({
      where: { role: UserRole.SUPER_ADMIN },
      select: { id: true },
    });
    await Promise.all(
      admins.map((admin) =>
        this.notificationsService.create({
          type: 'RETURN_REQUEST',
          title: 'New Return Request',
          message: `Return ${returnCode} for sale ${sale.saleCode} — Reason: ${reason}`,
          userId: admin.id,
          entityId: returnRequest.id,
          entityType: 'Return',
        }),
      ),
    );

    await this.prisma.activityFeed.create({
      data: {
        type: 'RETURN_REQUESTED',
        branchId: sale.branchId,
        title: 'Return Requested',
        message: `Return ${returnCode} for sale ${sale.saleCode}`,
        entityId: returnRequest.id,
        entityType: 'Return',
        visibleToBranch: true,
      },
    });

    return returnRequest;
  }

  async findAll(query?: { branchId?: string; status?: string; user?: any }) {
    const where: any = {};
    if (query?.status) where.status = query.status;
    if (query?.branchId) where.branchId = query.branchId;

    return this.prisma.return.findMany({
      where,
      include: {
        items: { include: { product: true } },
        sale: {
          include: {
            saleItems: { include: { product: true } },
            branch: { select: { id: true, name: true, code: true } },
          },
        },
        user: { select: { firstName: true, lastName: true } },
        approvedBy: { select: { firstName: true, lastName: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string) {
    const returnRequest = await this.prisma.return.findUnique({
      where: { id },
      include: {
        items: { include: { product: true } },
        sale: { include: { saleItems: { include: { product: true } } } },
        user: { select: { firstName: true, lastName: true } },
        approvedBy: { select: { firstName: true, lastName: true } },
      },
    });
    if (!returnRequest) throw new NotFoundException('Return request not found');
    return returnRequest;
  }

  async approve(id: string, approvedById: string) {
    const returnRequest = await this.prisma.return.findUnique({
      where: { id },
      include: {
        items: true,
        sale: { include: { saleItems: true } },
      },
    });
    if (!returnRequest) throw new NotFoundException('Return request not found');
    if (returnRequest.status !== ReturnStatus.PENDING) {
      throw new BadRequestException('Return request is not pending');
    }

    const itemsToRestore =
      returnRequest.items && returnRequest.items.length > 0
        ? returnRequest.items
        : returnRequest.sale.saleItems;

    await this.prisma.$transaction(async (tx) => {
      // 1. Mark Return as Approved
      await tx.return.update({
        where: { id },
        data: {
          status: ReturnStatus.APPROVED,
          approvedById,
          approvedAt: new Date(),
        },
      });

      // 2. Restore Inventory & Decrement totalSold
      for (const item of itemsToRestore) {
        const inventory = await tx.inventory.findFirst({
          where: {
            branchId: returnRequest.branchId,
            productId: item.productId,
          },
        });

        if (inventory) {
          let inventoryUpdate: any = {
            totalSold: { decrement: item.quantity },
          };

          if (item.lpgVariant === 'REFILL') {
            inventoryUpdate.fullCylinders = { increment: item.quantity };
          } else if (item.lpgVariant === 'EMPTY_SHELL') {
            inventoryUpdate.quantity = { increment: item.quantity };
          } else if (item.lpgVariant === 'COMPLETE_SET') {
            inventoryUpdate.quantity = { increment: item.quantity };
            inventoryUpdate.fullCylinders = { increment: item.quantity };
          } else {
            inventoryUpdate.quantity = { increment: item.quantity };
          }

          await tx.inventory.update({
            where: { id: inventory.id },
            data: inventoryUpdate,
          });

          await tx.stockMovement.create({
            data: {
              inventoryId: inventory.id,
              type: MovementType.RETURN,
              quantity: item.quantity,
              referenceId: id,
              referenceType: 'Return',
              performedById: approvedById,
              notes: `Return approved: ${returnRequest.returnCode}`,
            },
          });
        }
      }

      // 3. Mark Sale status
      await tx.sale.update({
        where: { id: returnRequest.saleId },
        data: { status: 'RETURNED' },
      });
    });

    await this.notificationsService.create({
      type: 'RETURN_APPROVED',
      title: 'Return Approved',
      message: `Your return request ${returnRequest.returnCode} has been approved`,
      userId: returnRequest.userId,
      entityId: id,
      entityType: 'Return',
    });

    return this.findOne(id);
  }


  async reject(id: string, approvedById: string, rejectionReason: string) {
    const returnRequest = await this.prisma.return.findUnique({ where: { id } });
    if (!returnRequest) throw new NotFoundException('Return request not found');
    if (returnRequest.status !== ReturnStatus.PENDING) {
      throw new BadRequestException('Return request is not pending');
    }

    await this.prisma.return.update({
      where: { id },
      data: { status: ReturnStatus.REJECTED, approvedById, approvedAt: new Date(), rejectionReason },
    });

    await this.notificationsService.create({
      type: 'RETURN_REJECTED',
      title: 'Return Rejected',
      message: `Your return request ${returnRequest.returnCode} has been rejected. Reason: ${rejectionReason}`,
      userId: returnRequest.userId,
      entityId: id,
      entityType: 'Return',
    });

    return this.findOne(id);
  }
}
