import {
  Injectable, Logger, InternalServerErrorException,
  BadRequestException, NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import {
  ProductType,
  LpgSaleVariant,
  MovementType,
  SaleStatus,
  PaymentProvider,
  AuditAction,
} from '@prisma/client';
import axios from 'axios';

@Injectable()
export class MpesaService {
  private readonly logger = new Logger(MpesaService.name);
  private readonly environment:     string;
  private readonly consumerKey:     string;
  private readonly consumerSecret:  string;
  private readonly passKey:         string;
  private readonly shortcode:       string;
  private readonly callbackUrl:     string;
  private readonly transactionType: string;
  private readonly baseUrl:         string;

  constructor(
    private prisma:        PrismaService,
    private configService: ConfigService,
  ) {
    this.environment     = this.configService.get('MPESA_ENVIRONMENT')      || 'sandbox';
    this.consumerKey     = this.configService.get('MPESA_CONSUMER_KEY')     || '';
    this.consumerSecret  = this.configService.get('MPESA_CONSUMER_SECRET')  || '';
    this.passKey         = this.configService.get('MPESA_PASSKEY')          || '';
    this.shortcode       = this.configService.get('MPESA_SHORTCODE')        || '';
    this.callbackUrl     = this.configService.get('MPESA_CALLBACK_URL')     || '';
    // ✅ Fix 5: configuration-driven so PayBill vs Till never needs a code change
    this.transactionType = this.configService.get('MPESA_TRANSACTION_TYPE') || 'CustomerPayBillOnline';
    this.baseUrl = this.environment === 'production'
      ? 'https://api.safaricom.co.ke'
      : 'https://sandbox.safaricom.co.ke';
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  private async getAccessToken(): Promise<string> {
    const credentials = Buffer.from(`${this.consumerKey}:${this.consumerSecret}`).toString('base64');
    try {
      const response = await axios.get(
        `${this.baseUrl}/oauth/v1/generate?grant_type=client_credentials`,
        { headers: { Authorization: `Basic ${credentials}` } },
      );
      return response.data.access_token;
    } catch (error) {
      this.logger.error('Failed to get M-Pesa access token', error);
      throw new InternalServerErrorException('Payment gateway authentication failed');
    }
  }

  // ✅ Fix 4: explicit Nairobi timezone — Render servers run UTC
  private generateTimestamp(): string {
    const parts = new Intl.DateTimeFormat('en-KE', {
      timeZone: 'Africa/Nairobi',
      year:   'numeric', month:  '2-digit', day:    '2-digit',
      hour:   '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    }).formatToParts(new Date());

    const get = (type: string) => parts.find(p => p.type === type)?.value ?? '00';
    return `${get('year')}${get('month')}${get('day')}${get('hour')}${get('minute')}${get('second')}`;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // STK Push
  // ─────────────────────────────────────────────────────────────────────────

  async initiateStkPush(
    phoneNumber: string,
    amount:      number,
    saleId?:     string,
    invoiceId?:  string,
  ) {
    // Normalize phone
    let formattedPhone = phoneNumber.replace(/\s+/g, '');
    if (formattedPhone.startsWith('0'))  formattedPhone = '254' + formattedPhone.slice(1);
    else if (formattedPhone.startsWith('+')) formattedPhone = formattedPhone.slice(1);

    if (!/^2547\d{8}$|^2541\d{8}$/.test(formattedPhone)) {
      throw new BadRequestException('Invalid Kenyan phone number. Use 07xx or 254xx format.');
    }

    const roundedAmount = Math.ceil(amount);

    // ✅ Fix 1: create the DB record FIRST before calling Safaricom.
    // We use a temp UUID so checkoutRequestId stays non-nullable in the schema.
    // It gets replaced with the real Safaricom ID immediately after the call.
    const { randomUUID } = await import('crypto');
    const pendingTx = await this.prisma.mpesaTransaction.create({
      data: {
        checkoutRequestId: `PENDING_${randomUUID()}`,
        merchantRequestId: null,
        phoneNumber: formattedPhone,
        amount: roundedAmount,
        status: 'PENDING',
        saleId:    saleId    || null,
        invoiceId: invoiceId || null,
      },
    });

    const token     = await this.getAccessToken();
    const timestamp = this.generateTimestamp();
    const password  = Buffer.from(`${this.shortcode}${this.passKey}${timestamp}`).toString('base64');

    try {
      const response = await axios.post(
        `${this.baseUrl}/mpesa/stkpush/v1/processrequest`,
        {
          BusinessShortCode: this.shortcode,
          Password:          password,
          Timestamp:         timestamp,
          TransactionType:   this.transactionType,
          Amount:            roundedAmount,
          PartyA:            formattedPhone,
          PartyB:            this.shortcode,
          PhoneNumber:       formattedPhone,
          CallBackURL:       this.callbackUrl,
          AccountReference:  saleId ? `Sale-${saleId.slice(0, 6)}` : 'NjugushPOS',
          TransactionDesc:   'POS Payment',
        },
        { headers: { Authorization: `Bearer ${token}` } },
      );

      const checkoutRequestId  = response.data.CheckoutRequestID;
      const merchantRequestId  = response.data.MerchantRequestID;

      // Update record with the checkout ID now that we have it
      await this.prisma.mpesaTransaction.update({
        where: { id: pendingTx.id },
        data:  { checkoutRequestId, merchantRequestId },
      });

      return { success: true, checkoutRequestId, message: 'STK Push sent to customer' };

    } catch (error: any) {
      // Mark the pre-created record as failed so we have an audit trail
      await this.prisma.mpesaTransaction.update({
        where: { id: pendingTx.id },
        data:  { status: 'FAILED', resultDesc: 'STK Push request failed' },
      });

      this.logger.error('STK Push failed', error.response?.data || error.message);
      throw new InternalServerErrorException('Failed to initiate M-Pesa payment');
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Proactive Safaricom STK Push query (for instant failure / cancellation detection)
  // ─────────────────────────────────────────────────────────────────────────

  async querySafaricomStkStatus(checkoutRequestId: string): Promise<any> {
    if (!this.consumerKey || !this.shortcode || !this.passKey) {
      return null;
    }
    if (checkoutRequestId.startsWith('PENDING_') || checkoutRequestId.startsWith('MANUAL_')) {
      return null;
    }
    try {
      const token = await this.getAccessToken();
      const timestamp = this.generateTimestamp();
      const password = Buffer.from(`${this.shortcode}${this.passKey}${timestamp}`).toString('base64');
      const response = await axios.post(
        `${this.baseUrl}/mpesa/stkpushquery/v1/query`,
        {
          BusinessShortCode: this.shortcode,
          Password: password,
          Timestamp: timestamp,
          CheckoutRequestID: checkoutRequestId,
        },
        { headers: { Authorization: `Bearer ${token}` }, timeout: 4500 },
      );
      return response.data;
    } catch (error: any) {
      const data = error.response?.data;
      if (data && (data.ResultCode !== undefined || data.errorCode || data.ResponseCode)) {
        return data;
      }
      return null;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Status polling (used by frontend)
  // ─────────────────────────────────────────────────────────────────────────

  async getTransactionStatus(checkoutRequestId: string) {
    let transaction = await this.prisma.mpesaTransaction.findUnique({
      where: { checkoutRequestId },
    });
    if (!transaction) throw new NotFoundException('Transaction not found');

    // If still pending, query Safaricom live STK query to catch immediate cancellation or insufficient funds
    if (transaction.status === 'PENDING') {
      try {
        const queryRes = await this.querySafaricomStkStatus(checkoutRequestId);
        if (queryRes && queryRes.ResultCode !== undefined) {
          const resultCodeStr = String(queryRes.ResultCode);
          if (resultCodeStr !== '0') {
            const resultDesc = queryRes.ResultDesc || (
              resultCodeStr === '1032' ? 'Request cancelled by user' :
              resultCodeStr === '1' ? 'The balance is insufficient for the transaction' :
              resultCodeStr === '1037' ? 'DS timeout user cannot be reached' :
              'Payment failed or was cancelled'
            );

            await this.prisma.$transaction(async (tx) => {
              await tx.mpesaTransaction.update({
                where: { id: transaction.id },
                data: { status: 'FAILED', resultDesc },
              });

              if (transaction.saleId) {
                await tx.sale.update({
                  where: { id: transaction.saleId },
                  data: {
                    status: SaleStatus.CANCELLED,
                    notes: `M-Pesa STK failed: ${resultDesc}`,
                  },
                });
              }
            });

            transaction.status = 'FAILED';
            transaction.resultDesc = resultDesc;
          }
        }
      } catch (err: any) {
        this.logger.debug(`Live STK query check skipped: ${err?.message}`);
      }
    }

    let sale: any = null;
    if (transaction.saleId) {
      sale = await this.prisma.sale.findUnique({
        where: { id: transaction.saleId },
        include: {
          saleItems: { include: { product: true } },
          payments: true,
          branch: true,
          user: { select: { id: true, firstName: true, lastName: true } },
          customer: true,
        },
      });
    }

    return {
      status:        transaction.status,
      receiptNumber: transaction.receiptNumber,
      customerName:  transaction.customerName  ?? null,
      resultDesc:    transaction.resultDesc    ?? null,
      amount:        transaction.amount,
      phoneNumber:   transaction.phoneNumber,
      sale,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Manual receipt verification
  // ─────────────────────────────────────────────────────────────────────────

  async verifyManualReceipt(receiptNumber: string, amount: number) {
    const clean = receiptNumber.trim().toUpperCase();

    // Check if this receipt came in via a real Safaricom callback
    const existing = await this.prisma.mpesaTransaction.findFirst({
      where: { receiptNumber: clean, status: 'COMPLETED' },
    });

    if (existing) {
      // Receipt is genuine — warn if it's already linked to another sale
      const alreadyUsed = !!existing.saleId;
      return {
        verified:    true,
        alreadyUsed,
        message: alreadyUsed
          ? 'This receipt is already linked to another sale'
          : 'Receipt verified — found in system',
      };
    }

    // Not in DB — create an unverified record so the manager can reconcile it
    this.logger.warn(`Unverified manual receipt: ${clean} | KES ${amount}`);
    const { randomUUID } = await import('crypto');
    await this.prisma.mpesaTransaction.create({
      data: {
        checkoutRequestId: `MANUAL_${clean}_${randomUUID()}`,
        phoneNumber:       'MANUAL',
        amount,
        status:            'MANUAL_UNVERIFIED',
        receiptNumber:     clean,
        resultDesc:        'Manually entered by cashier — pending manager reconciliation',
      },
    });

    return {
      verified:    false,
      alreadyUsed: false,
      message:     'Receipt not found in system — logged for manager reconciliation',
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Safaricom callback webhook
  // ─────────────────────────────────────────────────────────────────────────

  async handleCallback(callbackData: any) {
    const stkCallback = callbackData?.Body?.stkCallback;
    if (!stkCallback) {
      this.logger.warn('Received invalid callback payload');
      return { message: 'Invalid payload structure' };
    }

    const { ResultCode, CheckoutRequestID, ResultDesc } = stkCallback;

    const transaction = await this.prisma.mpesaTransaction.findUnique({
      where: { checkoutRequestId: CheckoutRequestID },
    });

    if (!transaction) {
      this.logger.warn(`Callback for unknown CheckoutRequestID: ${CheckoutRequestID}`);
      return { message: 'Transaction not found' };
    }

    // ✅ Fix 2: idempotency guard — never process the same callback twice
    if (transaction.status === 'COMPLETED' || transaction.status === 'FAILED') {
      this.logger.log(`Duplicate callback ignored for ${CheckoutRequestID} (status: ${transaction.status})`);
      return { message: 'Already processed' };
    }

    // ── Payment failed or cancelled by user ───────────────────────────────
    if (ResultCode !== 0) {
      await this.prisma.$transaction(async (tx) => {
        await tx.mpesaTransaction.update({
          where: { id: transaction.id },
          data:  { status: 'FAILED', resultDesc: ResultDesc },
        });

        if (transaction.saleId) {
          await tx.sale.update({
            where: { id: transaction.saleId },
            data: {
              status: SaleStatus.CANCELLED,
              notes: ResultDesc ? `M-Pesa STK failed: ${ResultDesc}` : 'M-Pesa STK failed or cancelled',
            },
          });
        }
      });
      this.logger.log(`Transaction ${CheckoutRequestID} failed: ${ResultDesc}`);
      return { message: 'Failed transaction recorded' };
    }

    // ── Payment successful ────────────────────────────────────────────────
    const meta         = stkCallback.CallbackMetadata?.Item || [];
    const receiptNumber = meta.find((i: any) => i.Name === 'MpesaReceiptNumber')?.Value;
    const amountPaid    = meta.find((i: any) => i.Name === 'Amount')?.Value;

    if (!receiptNumber) {
      this.logger.error(`Successful callback missing receipt number: ${CheckoutRequestID}`);
      return { message: 'Missing receipt number in callback' };
    }

    // Extract customer name (present in production, absent in sandbox)
    const firstName   = meta.find((i: any) => i.Name === 'FirstName')?.Value  || '';
    const middleName  = meta.find((i: any) => i.Name === 'MiddleName')?.Value || '';
    const lastName    = meta.find((i: any) => i.Name === 'LastName')?.Value   || '';
    const customerName = [firstName, middleName, lastName].filter(Boolean).join(' ').trim() || null;

    // ✅ All DB updates inside a single Prisma interactive transaction
    // Guarantees: payment completed + stock deducted + sale completed + movements created atomically
    await this.prisma.$transaction(async (tx) => {
      // 1. Mark M-Pesa transaction as completed
      await tx.mpesaTransaction.update({
        where: { id: transaction.id },
        data: {
          status:        'COMPLETED',
          receiptNumber,
          resultDesc:    'Payment successful',
          customerName,
        },
      });

      // 2. Finalize linked sale atomically
      if (transaction.saleId) {
        const sale = await tx.sale.findUnique({
          where: { id: transaction.saleId },
          include: {
            saleItems: { include: { product: true } },
            payments: true,
          },
        });

        if (sale && sale.status === SaleStatus.PENDING) {
          // A. Atomic Stock Deduction for each item
          for (const item of sale.saleItems) {
            const product = item.product;
            const variant = item.lpgVariant;
            let quantityDelta = -item.quantity;

            if (product.type === ProductType.LPG_REFILL) {
              if (variant === LpgSaleVariant.REFILL) {
                const res = await tx.inventory.updateMany({
                  where: {
                    branchId: sale.branchId,
                    productId: item.productId,
                    fullCylinders: { gte: item.quantity },
                  },
                  data: {
                    fullCylinders: { decrement: item.quantity },
                    totalSold: { increment: item.quantity },
                  },
                });
                if (res.count !== 1) {
                  throw new BadRequestException(`Insufficient full cylinders for ${product.name}`);
                }
                quantityDelta = 0;
              } else if (variant === LpgSaleVariant.EMPTY_SHELL) {
                const res = await tx.inventory.updateMany({
                  where: {
                    branchId: sale.branchId,
                    productId: item.productId,
                    quantity: { gte: item.quantity },
                  },
                  data: {
                    quantity: { decrement: item.quantity },
                    totalSold: { increment: item.quantity },
                  },
                });
                if (res.count !== 1) {
                  throw new BadRequestException(`Insufficient empty shells for ${product.name}`);
                }
              } else if (variant === LpgSaleVariant.COMPLETE_SET) {
                const res = await tx.inventory.updateMany({
                  where: {
                    branchId: sale.branchId,
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
                  throw new BadRequestException(`Insufficient complete sets for ${product.name}`);
                }
              }
            } else if (product.type === ProductType.LPG_CYLINDER) {
              const res = await tx.inventory.updateMany({
                where: {
                  branchId: sale.branchId,
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
                throw new BadRequestException(`Insufficient stock for ${product.name}`);
              }
            } else {
              const res = await tx.inventory.updateMany({
                where: {
                  branchId: sale.branchId,
                  productId: item.productId,
                  quantity: { gte: item.quantity },
                },
                data: {
                  quantity: { decrement: item.quantity },
                  totalSold: { increment: item.quantity },
                },
              });
              if (res.count !== 1) {
                throw new BadRequestException(`Insufficient stock for ${product.name}`);
              }
            }

            // Optional Serialized Cylinder status transition
            if (item.cylinderId) {
              await tx.cylinder.updateMany({
                where: { id: item.cylinderId, branchId: sale.branchId },
                data: { status: 'EMPTY' },
              });
            }

            const inv = await tx.inventory.findUnique({
              where: { branchId_productId: { branchId: sale.branchId, productId: item.productId } },
            });

            if (inv) {
              await tx.stockMovement.create({
                data: {
                  inventoryId: inv.id,
                  type: MovementType.SALE,
                  quantity: quantityDelta,
                  referenceId: sale.id,
                  referenceType: 'Sale',
                  performedById: sale.userId,
                  notes: `Sale ${sale.saleCode}${variant ? ` (${variant})` : ''} via M-Pesa`,
                },
              });
            }
          }

          // B. Create M-Pesa SalePayment
          await tx.salePayment.create({
            data: {
              saleId: sale.id,
              method: PaymentProvider.MPESA,
              amount: transaction.amount,
              mpesaRef: receiptNumber,
            },
          });

          // C. If there was a split payment with CASH in the intent, record it
          if (Number(sale.total) > Number(transaction.amount)) {
            const cashPart = Math.round((Number(sale.total) - Number(transaction.amount)) * 100) / 100;
            await tx.salePayment.create({
              data: {
                saleId: sale.id,
                method: PaymentProvider.CASH,
                amount: cashPart,
              },
            });
          }

          // D. Customer total purchases increment
          if (sale.customerId) {
            await tx.customer.update({
              where: { id: sale.customerId },
              data: { totalPurchases: { increment: sale.total } },
            });
          }

          // E. Mark Sale COMPLETED
          await tx.sale.update({
            where: { id: sale.id },
            data: {
              status: SaleStatus.COMPLETED,
              mpesaRef: receiptNumber,
              paymentProvider: PaymentProvider.MPESA,
            },
          });

          // F. Audit log & activity feed
          await tx.auditLog.create({
            data: {
              userId: sale.userId,
              action: AuditAction.SALE_COMPLETED,
              description: `M-Pesa payment completed for sale ${sale.saleCode} (${receiptNumber}) - KES ${transaction.amount}`,
              entityType: 'Sale',
              entityId: sale.id,
              newValues: { receiptNumber, amount: transaction.amount, customerName },
            },
          });

          await tx.activityFeed.create({
            data: {
              type: 'SALE_COMPLETED',
              branchId: sale.branchId,
              title: 'Sale Completed (M-Pesa)',
              message: `Sale ${sale.saleCode} completed via M-Pesa ${receiptNumber} for KES ${sale.total}`,
              entityId: sale.id,
              entityType: 'Sale',
              visibleToBranch: true,
            },
          });

          this.logger.log(`Sale ${sale.id} (${sale.saleCode}) atomically finalized via M-Pesa (${receiptNumber})`);
        }
      }

      // 3. Update linked invoice if present
      if (transaction.invoiceId) {
        const invoice = await tx.invoice.findUnique({ where: { id: transaction.invoiceId } });
        if (invoice) {
          const newPaid    = Number(invoice.amountPaid) + Number(amountPaid || transaction.amount);
          const newBalance = Math.max(0, Number(invoice.total) - newPaid);
          await tx.invoice.update({
            where: { id: transaction.invoiceId },
            data: {
              amountPaid: newPaid,
              balance:    newBalance,
              status:     newBalance <= 0 ? 'PAID' : 'PENDING',
              paidAt:     newBalance <= 0 ? new Date() : null,
            },
          });

          if (invoice.customerId) {
            await tx.customer.update({
              where: { id: invoice.customerId },
              data: { creditUsed: { decrement: Number(amountPaid || transaction.amount) } },
            });
          }

          if (invoice.saleId) {
            await tx.salePayment.create({
              data: {
                saleId: invoice.saleId,
                method: PaymentProvider.MPESA,
                amount: amountPaid || transaction.amount,
                mpesaRef: receiptNumber,
              },
            });
          }
        }
      }
    });

    this.logger.log(`Callback fully processed: ${CheckoutRequestID} → ${receiptNumber}`);
    return { message: 'Callback processed successfully' };
  }
}
