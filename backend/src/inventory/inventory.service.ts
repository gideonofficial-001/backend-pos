import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UserRole, MovementType } from '@prisma/client';

@Injectable()
export class InventoryService {
  constructor(private prisma: PrismaService) {}

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
      include: { product: { include: { category: true } } },
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
    let newFull: number | null | undefined = undefined;

    if (isLpg) {
      newFull = payload.fullCylinders !== undefined ? payload.fullCylinders : (inventory.fullCylinders ?? 0);
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
        notes: payload.reason || 'Manual inventory adjustment',
      },
    });

    await this.prisma.stockAdjustment.create({
      data: {
        inventoryId,
        type: difference >= 0 ? 'INCREASE' : 'DECREASE',
        quantity: Math.abs(difference),
        reason: payload.reason || 'Manual inventory adjustment',
        userId,
      },
    });

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
