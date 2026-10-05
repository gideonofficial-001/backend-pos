import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { UserRole, MovementType, AuditAction, NotificationType } from '@prisma/client';

@Injectable()
export class InventoryService {
  constructor(
    private prisma: PrismaService,
    private notificationsService: NotificationsService,
  ) {}

  private withComputedEmptyCylinders<
    T extends { quantity: number; fullCylinders: number | null; product?: any },
  >(item: T) {
    const isLpg =
      item.fullCylinders != null ||
      item.product?.isLpg ||
      item.product?.isCylinderTracked ||
      item.product?.type === 'LPG_REFILL' ||
      item.product?.type === 'LPG_CYLINDER' ||
      item.product?.category?.name?.toUpperCase().includes('LPG');

    const effectiveFull = isLpg ? (item.fullCylinders ?? 0) : null;

    return {
      ...item,
      fullCylinders: isLpg ? (item.fullCylinders ?? 0) : item.fullCylinders,
      emptyCylinders:
        effectiveFull != null ? Math.max(0, item.quantity - effectiveFull) : null,
    };
  }

  async findAll(query: { branchId?: string; user?: any; lowStock?: boolean }) {
    const { branchId, user, lowStock } = query;
    const where: any = {};

    if (branchId) {
      if (
        user?.role === UserRole.BRANCH_MANAGER &&
        user.branchId !== branchId
      ) {
        throw new ForbiddenException('You can only view your branch inventory');
      }
      where.branchId = branchId;
    } else if (user?.role === UserRole.BRANCH_MANAGER) {
      where.branchId = user.branchId;
    }

    if (lowStock) where.quantity = { lte: 10 };

    const items = await this.prisma.inventory.findMany({
      where,
      include: {
        product: { include: { category: true } },
        branch: { select: { id: true, name: true, code: true } },
      },
      orderBy: { product: { name: 'asc' } },
    });

    return items.map((item) => this.withComputedEmptyCylinders(item));
  }

  async findOne(id: string) {
    const inventory = await this.prisma.inventory.findUnique({
      where: { id },
      include: {
        product: { include: { category: true } },
        branch: true,
        stockMovements: {
          orderBy: { createdAt: 'desc' },
          take: 20,
          include: {
            performedBy: { select: { firstName: true, lastName: true } },
          },
        },
      },
    });

    if (!inventory) throw new NotFoundException('Inventory item not found');
    return this.withComputedEmptyCylinders(inventory);
  }

  async restock(inventoryId: string, quantity: number, userId: string) {
    const inventory = await this.prisma.inventory.findUnique({
      where: { id: inventoryId },
      include: { product: { include: { category: true } } },
    });
    if (!inventory) throw new NotFoundException('Inventory item not found');

    const isLpg =
      inventory.product.type === 'LPG_REFILL' ||
      inventory.product.type === 'LPG_CYLINDER' ||
      inventory.product.isLpg ||
      inventory.product.isCylinderTracked ||
      inventory.product.category?.name?.toUpperCase().includes('LPG') ||
      inventory.fullCylinders != null;

    const currentFull = inventory.fullCylinders ?? 0;

    const updated = await this.prisma.inventory.update({
      where: { id: inventoryId },
      data: {
        quantity: { increment: quantity },
        fullCylinders: isLpg ? currentFull + quantity : undefined,
        totalRefilled: { increment: quantity },
        lastRestocked: new Date(),
      },
      include: { product: { include: { category: true } }, branch: true },
    });

    await this.prisma.stockMovement.create({
      data: {
        inventoryId,
        type: MovementType.RESTOCK,
        quantity,
        performedById: userId,
        notes: `Restocked ${quantity} units`,
      },
    });

    return this.withComputedEmptyCylinders(updated);
  }

  async adjustStock(
    inventoryId: string,
    payload: { quantity?: number; fullCylinders?: number; reason: string },
    userId: string,
  ) {
    const inventory = await this.prisma.inventory.findUnique({
      where: { id: inventoryId },
      include: { product: { include: { category: true } }, branch: true },
    });
    if (!inventory) throw new NotFoundException('Inventory item not found');

    const isLpg =
      inventory.product.type === 'LPG_REFILL' ||
      inventory.product.type === 'LPG_CYLINDER' ||
      inventory.product.isLpg ||
      inventory.product.isCylinderTracked ||
      inventory.product.category?.name?.toUpperCase().includes('LPG') ||
      inventory.fullCylinders != null ||
      payload.fullCylinders !== undefined;

    const previousQuantity = inventory.quantity;
    const newQuantity = payload.quantity ?? previousQuantity;
    const previousFull = isLpg ? (inventory.fullCylinders ?? 0) : 0;
    const previousEmpty = isLpg ? Math.max(0, previousQuantity - previousFull) : 0;

    let newFull: number | null | undefined = undefined;

    if (isLpg) {
      newFull = payload.fullCylinders !== undefined ? payload.fullCylinders : previousFull;
      if (newFull > newQuantity) {
        throw new BadRequestException(
          'Full cylinders cannot exceed total shells',
        );
      }

      // Self-heal: ensure product has isLpg & isCylinderTracked set
      if (!inventory.product.isLpg || !inventory.product.isCylinderTracked) {
        await this.prisma.product.update({
          where: { id: inventory.productId },
          data: {
            isLpg: true,
            isCylinderTracked: true,
            hasRefill: true,
            hasCylinder: true,
          },
        });
      }
    }

    const difference = newQuantity - previousQuantity;
    const newEmpty = isLpg ? Math.max(0, newQuantity - (newFull ?? 0)) : 0;

    // Detailed description of what changed
    let changeSummary = '';
    if (isLpg) {
      const parts: string[] = [];
      if (previousFull !== newFull) {
        const diff = (newFull ?? 0) - previousFull;
        parts.push(`Refill: ${previousFull} → ${newFull} (${diff >= 0 ? '+' : ''}${diff})`);
      }
      if (previousQuantity !== newQuantity) {
        parts.push(`Total Shells: ${previousQuantity} → ${newQuantity} (${difference >= 0 ? '+' : ''}${difference})`);
      }
      if (previousEmpty !== newEmpty) {
        const diffEmpty = newEmpty - previousEmpty;
        parts.push(`Empty Shells: ${previousEmpty} → ${newEmpty} (${diffEmpty >= 0 ? '+' : ''}${diffEmpty})`);
      }
      changeSummary = parts.length > 0 ? parts.join(', ') : `Quantity: ${previousQuantity} → ${newQuantity}`;
    } else {
      changeSummary = `Quantity: ${previousQuantity} → ${newQuantity} (${difference >= 0 ? '+' : ''}${difference})`;
    }

    const updated = await this.prisma.inventory.update({
      where: { id: inventoryId },
      data: {
        quantity: newQuantity,
        ...(isLpg ? { fullCylinders: newFull } : {}),
      },
      include: { product: { include: { category: true } }, branch: true },
    });

    await this.prisma.stockMovement.create({
      data: {
        inventoryId,
        type: MovementType.ADJUSTMENT,
        quantity: difference,
        performedById: userId,
        notes: payload.reason ? `${payload.reason} | ${changeSummary}` : changeSummary,
      },
    });

    await this.prisma.stockAdjustment.create({
      data: {
        inventoryId,
        type: difference >= 0 ? 'INCREASE' : 'DECREASE',
        quantity: Math.abs(difference),
        reason: payload.reason ? `${payload.reason} | ${changeSummary}` : changeSummary,
        userId,
      },
    });

    // Record in AuditLog for rich structured audit history
    await this.prisma.auditLog.create({
      data: {
        userId,
        action: AuditAction.STOCK_ADJUSTED,
        entityType: 'Inventory',
        entityId: inventoryId,
        description: `${updated.branch?.name}: ${updated.product.name} — ${changeSummary}. Reason: ${payload.reason || 'Manual adjustment'}`,
        oldValues: {
          quantity: previousQuantity,
          fullCylinders: previousFull,
          emptyCylinders: previousEmpty,
          branchId: updated.branchId,
          branchName: updated.branch?.name,
          productId: updated.productId,
          productName: updated.product.name,
          isLpg,
          changeSummary,
          userReason: payload.reason || '',
        },
        newValues: {
          quantity: newQuantity,
          fullCylinders: newFull ?? 0,
          emptyCylinders: newEmpty,
          branchId: updated.branchId,
          branchName: updated.branch?.name,
          productId: updated.productId,
          productName: updated.product.name,
          isLpg,
          changeSummary,
          userReason: payload.reason || '',
        },
      },
    });

    // Notify branch manager of this branch if not the one who performed it
    if (updated.branch?.managerId && updated.branch.managerId !== userId) {
      const userObj = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { firstName: true, lastName: true },
      });
      const performer = userObj ? `${userObj.firstName} ${userObj.lastName}` : 'Administrator';

      await this.notificationsService.create({
        type: NotificationType.LOW_STOCK,
        title: 'Stock Adjusted',
        message: `${performer} adjusted stock for ${updated.product.name} at ${updated.branch.name}: ${changeSummary}. Reason: ${payload.reason || 'Manual adjustment'}`,
        userId: updated.branch.managerId,
        entityId: inventoryId,
        entityType: 'Inventory',
      });
    }

    return this.withComputedEmptyCylinders(updated);
  }

  async getLowStock(user?: any) {
    const where: any = { quantity: { lte: 10 } };
    if (user?.role === UserRole.BRANCH_MANAGER) {
      where.branchId = user.branchId;
    }

    const items = await this.prisma.inventory.findMany({
      where,
      include: {
        product: true,
        branch: { select: { id: true, name: true, code: true } },
      },
      orderBy: { quantity: 'asc' },
    });

    return items.map((item) => this.withComputedEmptyCylinders(item));
  }

    async getStockMovements(inventoryId?: string, branchId?: string) {
    const where: any = {};

    if (inventoryId) where.inventoryId = inventoryId;

    // Filter by branch through the inventory relation
    if (branchId) {
      where.inventory = { branchId };
    }

    return this.prisma.stockMovement.findMany({
      where,
      include: {
        inventory: {
          include: {
            product: {
              select: { name: true },
            },
          },
        },
        performedBy: {
          select: {
            firstName: true,
            lastName: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  async getStockAdjustments(params: {
    branchId?: string;
    startDate?: string;
    endDate?: string;
    search?: string;
  }) {
    const where: any = {};

    if (params.branchId && params.branchId !== 'all') {
      where.inventory = { branchId: params.branchId };
    }

    if (params.startDate || params.endDate) {
      where.createdAt = {};
      if (params.startDate) {
        where.createdAt.gte = new Date(params.startDate);
      }
      if (params.endDate) {
        const end = new Date(params.endDate);
        end.setHours(23, 59, 59, 999);
        where.createdAt.lte = end;
      }
    }

    const [stockAdjustments, auditLogs] = await Promise.all([
      this.prisma.stockAdjustment.findMany({
        where,
        include: {
          inventory: {
            include: {
              product: {
                select: {
                  id: true,
                  name: true,
                  code: true,
                  isLpg: true,
                  cylinderSize: true,
                },
              },
              branch: {
                select: {
                  id: true,
                  name: true,
                  code: true,
                },
              },
            },
          },
          user: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
              role: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: 250,
      }),
      this.prisma.auditLog.findMany({
        where: {
          action: AuditAction.STOCK_ADJUSTED,
          entityType: 'Inventory',
          ...(params.startDate || params.endDate
            ? {
                createdAt: {
                  ...(params.startDate ? { gte: new Date(params.startDate) } : {}),
                  ...(params.endDate
                    ? { lte: new Date(new Date(params.endDate).setHours(23, 59, 59, 999)) }
                    : {}),
                },
              }
            : {}),
        },
        include: {
          user: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
              role: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: 250,
      }),
    ]);

    // Map each stockAdjustment with its matching auditLog if available
    const records = stockAdjustments.map((adj) => {
      // Find matching audit log within 5 seconds for same entityId
      const adjTime = new Date(adj.createdAt).getTime();
      const match = auditLogs.find((al) => {
        if (al.entityId !== adj.inventoryId) return false;
        const alTime = new Date(al.createdAt).getTime();
        return Math.abs(alTime - adjTime) < 5000;
      });

      const oldVals = (match?.oldValues as any) || {};
      const newVals = (match?.newValues as any) || {};

      // Parse summary & reason from adj.reason if it was formatted as "Reason | Summary"
      let userReason = adj.reason || '';
      let changeSummary = newVals.changeSummary || '';
      if (!changeSummary && adj.reason && adj.reason.includes(' | ')) {
        const parts = adj.reason.split(' | ');
        userReason = parts[0];
        changeSummary = parts.slice(1).join(' | ');
      } else if (!changeSummary) {
        changeSummary = adj.reason || '';
      }

      const isLpg = adj.inventory.product.isLpg;

      return {
        id: adj.id,
        createdAt: adj.createdAt,
        inventoryId: adj.inventoryId,
        branchId: adj.inventory.branchId,
        branchName: adj.inventory.branch?.name || oldVals.branchName || 'Unknown Branch',
        branchCode: adj.inventory.branch?.code,
        productId: adj.inventory.productId,
        productName: adj.inventory.product?.name || oldVals.productName || 'Unknown Product',
        productCode: adj.inventory.product?.code,
        isLpg,
        type: adj.type,
        quantity: adj.quantity,
        previousQuantity: oldVals.quantity !== undefined ? oldVals.quantity : null,
        newQuantity: newVals.quantity !== undefined ? newVals.quantity : null,
        previousFull: oldVals.fullCylinders !== undefined ? oldVals.fullCylinders : null,
        newFull: newVals.fullCylinders !== undefined ? newVals.fullCylinders : null,
        previousEmpty: oldVals.emptyCylinders !== undefined ? oldVals.emptyCylinders : null,
        newEmpty: newVals.emptyCylinders !== undefined ? newVals.emptyCylinders : null,
        changeSummary,
        reason: newVals.userReason || userReason || 'Manual adjustment',
        performedBy: adj.user,
      };
    });

    // Also include any audit logs that didn't match a stockAdjustment record
    for (const al of auditLogs) {
      const alTime = new Date(al.createdAt).getTime();
      const alreadyIncluded = records.some((r) => {
        return (
          r.inventoryId === al.entityId &&
          Math.abs(new Date(r.createdAt).getTime() - alTime) < 5000
        );
      });

      if (!alreadyIncluded) {
        const oldVals = (al.oldValues as any) || {};
        const newVals = (al.newValues as any) || {};

        if (
          params.branchId &&
          params.branchId !== 'all' &&
          newVals.branchId !== params.branchId
        ) {
          continue;
        }

        records.push({
          id: al.id,
          createdAt: al.createdAt,
          inventoryId: al.entityId || '',
          branchId: newVals.branchId || oldVals.branchId || '',
          branchName: newVals.branchName || oldVals.branchName || 'Unknown Branch',
          branchCode: undefined,
          productId: newVals.productId || oldVals.productId || '',
          productName:
            newVals.productName || oldVals.productName || 'Unknown Product',
          productCode: undefined,
          isLpg: newVals.isLpg ?? oldVals.isLpg ?? false,
          type: 'ADJUSTMENT',
          quantity: Math.abs((newVals.quantity ?? 0) - (oldVals.quantity ?? 0)),
          previousQuantity: oldVals.quantity !== undefined ? oldVals.quantity : null,
          newQuantity: newVals.quantity !== undefined ? newVals.quantity : null,
          previousFull:
            oldVals.fullCylinders !== undefined ? oldVals.fullCylinders : null,
          newFull:
            newVals.fullCylinders !== undefined ? newVals.fullCylinders : null,
          previousEmpty:
            oldVals.emptyCylinders !== undefined ? oldVals.emptyCylinders : null,
          newEmpty:
            newVals.emptyCylinders !== undefined ? newVals.emptyCylinders : null,
          changeSummary: newVals.changeSummary || al.description,
          reason: newVals.userReason || 'Manual adjustment',
          performedBy: al.user,
        });
      }
    }

    // Filter by search query if provided
    let result = records;
    if (params.search && params.search.trim()) {
      const query = params.search.toLowerCase().trim();
      result = result.filter(
        (r) =>
          r.productName?.toLowerCase().includes(query) ||
          r.branchName?.toLowerCase().includes(query) ||
          r.reason?.toLowerCase().includes(query) ||
          r.changeSummary?.toLowerCase().includes(query) ||
          (r.performedBy &&
            `${r.performedBy.firstName} ${r.performedBy.lastName}`
              .toLowerCase()
              .includes(query)),
      );
    }

    // Sort by createdAt descending
    result.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );

    return result;
  }

  async delete(id: string) {
    try {
      // First check that the inventory record exists
      const inventory = await this.prisma.inventory.findUnique({
        where: { id },
        include: {
          product: true,
        },
      });

      if (!inventory) {
        throw new NotFoundException('Inventory item not found');
      }

      /*
       * Try to delete the inventory record.
       *
       * If other records reference this inventory item, Prisma will
       * throw P2003. In that case we preserve the historical record
       * rather than destroying it.
       */
      await this.prisma.inventory.delete({
        where: { id },
      });

      return {
        message: 'Inventory item successfully removed from this branch.',
        deleted: true,
      };
    } catch (error: any) {
      if (error instanceof NotFoundException) {
        throw error;
      }

      if (error?.code === 'P2003') {
        throw new BadRequestException(
          'This inventory item cannot be permanently deleted because it has existing transaction history. Deactivate the product instead to preserve historical records.',
        );
      }

      throw error;
    }
  }
}
