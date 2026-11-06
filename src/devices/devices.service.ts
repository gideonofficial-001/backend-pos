import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { NotificationsService } from '../notifications/notifications.service';
import { DeviceStatus, UserRole } from '@prisma/client';
import * as nodemailer from 'nodemailer';
import * as bcrypt from 'bcrypt';

@Injectable()
export class DevicesService {
  private readonly logger = new Logger(DevicesService.name);

  constructor(
    private prisma: PrismaService,
    private auditLogsService: AuditLogsService,
    private notificationsService: NotificationsService,
  ) {}

  parseDeviceDetails(userAgent?: string): {
    deviceType: 'Desktop' | 'Mobile' | 'Tablet';
    deviceName: string;
  } {
    if (!userAgent) {
      return { deviceType: 'Desktop', deviceName: 'Unknown Device' };
    }

    const ua = userAgent;

    // 1. Determine Device Type
    let deviceType: 'Desktop' | 'Mobile' | 'Tablet' = 'Desktop';
    if (/iPad|Tablet|PlayBook|Silk/i.test(ua)) {
      deviceType = 'Tablet';
    } else if (/Mobi|Android|iPhone|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua)) {
      deviceType = 'Mobile';
    }

    // 2. Determine OS & Model
    let os = 'Unknown OS';
    let model = '';

    if (/Windows NT 10\.0/i.test(ua)) os = 'Windows 10/11 PC';
    else if (/Windows NT/i.test(ua)) os = 'Windows PC';
    else if (/Macintosh|Mac OS X/i.test(ua) && !/iPhone|iPad/i.test(ua)) os = 'Mac';
    else if (/iPhone/i.test(ua)) os = 'iPhone';
    else if (/iPad/i.test(ua)) os = 'iPad';
    else if (/Android/i.test(ua)) {
      os = 'Android';
      const match = ua.match(/Android\s+[\d\.]+;\s*([^;)]+)/i);
      if (match && match[1]) {
        const candidate = match[1].replace(/Build\/[^\s;)]+/i, '').trim();
        if (candidate && candidate.length < 35 && !/khtml/i.test(candidate)) {
          model = candidate;
        }
      }
    } else if (/Linux/i.test(ua)) {
      os = 'Linux PC';
    }

    // 3. Determine Browser
    let browser = 'Browser';
    if (/Edg\//i.test(ua)) browser = 'Edge';
    else if (/Chrome\//i.test(ua) && !/Edg\//i.test(ua)) browser = 'Chrome';
    else if (/Safari\//i.test(ua) && !/Chrome\//i.test(ua)) browser = 'Safari';
    else if (/Firefox\//i.test(ua)) browser = 'Firefox';
    else if (/Opera|OPR\//i.test(ua)) browser = 'Opera';

    const deviceName = model ? `${os} (${model}) · ${browser}` : `${os} · ${browser}`;

    return { deviceType, deviceName };
  }

  private getMailTransporter() {
    return nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });
  }

  async validateDevice(userId: string, fingerprint: string) {
    const device = await this.prisma.device.findFirst({
      where: { userId, fingerprint },
    });

    if (!device) return { isAuthorized: false };

    if (device.status !== DeviceStatus.APPROVED) {
      return { isAuthorized: false, deviceRequestId: device.id };
    }

    return { isAuthorized: true };
  }

  async requestAuthorization(
    userId: string,
    fingerprint: string,
    deviceInfo: {
      ipAddress: string;
      userAgent: string;
      latitude?: number;
      longitude?: number;
      city?: string;
      region?: string;
      country?: string;
      isp?: string;
    },
  ) {
    const existingDevice = await this.prisma.device.findFirst({
      where: { userId, fingerprint },
    });

    if (existingDevice) {
      // 🚀 THE FIX: If it was revoked, delete the old record so they can start fresh!
      if (existingDevice.status === 'REVOKED') {
        await this.prisma.device.delete({
          where: { id: existingDevice.id },
        });
        this.logger.log(`[DevicesService] Deleted revoked device for user ${userId} to allow re-enrollment.`);
      } else {
        // If it is PENDING or APPROVED, return it normally
        return { requestId: existingDevice.id, status: existingDevice.status };
      }
    }

    // NOTE: The strict 1-device limit is removed so the PWA and new browsers
    // can successfully request access and go into the PENDING state for the Admin to review.

    const { deviceType, deviceName } = this.parseDeviceDetails(deviceInfo.userAgent);
    const friendlyName = `${deviceType}: ${deviceName}`;

    const device = await this.prisma.device.create({
      data: {
        userId,
        fingerprint,
        name: friendlyName,
        status: DeviceStatus.PENDING,
        loginIpAddress: deviceInfo.ipAddress ?? null,
        loginLatitude:  deviceInfo.latitude  ?? null,
        loginLongitude: deviceInfo.longitude ?? null,
        loginCity:      deviceInfo.city      ?? null,
        loginRegion:    deviceInfo.region    ?? null,
        loginCountry:   deviceInfo.country   ?? null,
        isp:            deviceInfo.isp       ?? null,
      },
    });

    await this.auditLogsService.create({
      userId,
      action: 'DEVICE_REGISTERED',
      description: `New device registered for user ${userId} (${friendlyName})`,
      entityType: 'Device',
      entityId: device.id,
      ipAddress: deviceInfo.ipAddress,
      userAgent: deviceInfo.userAgent,
    });

    // ── Notify all SUPER_ADMIN users immediately ──────────────────────────────
    const requestingUser = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        firstName: true,
        lastName: true,
        email: true,
        branch: { select: { name: true } },
      },
    });

    const userName   = requestingUser
      ? `${requestingUser.firstName} ${requestingUser.lastName}`
      : 'A user';
    const branchName = requestingUser?.branch?.name ?? 'unknown branch';
    const locationParts = [
      deviceInfo.city,
      deviceInfo.region,
      deviceInfo.country,
    ].filter(Boolean);
    const locationStr = locationParts.length > 0
      ? `from ${locationParts.join(', ')}`
      : deviceInfo.ipAddress ? `from IP ${deviceInfo.ipAddress}` : 'from unknown location';

    const notifMessage = `${userName} (${branchName}) is requesting authorization to log in ${locationStr} on a ${deviceType} (${deviceName}). Generate code in Device Management.`;

    const admins = await this.prisma.user.findMany({
      where: { role: UserRole.SUPER_ADMIN },
      select: { id: true },
    });

    if (admins.length === 0) {
      this.logger.warn(
        '[DevicesService] No SUPER_ADMIN users found — device auth notification not sent!',
      );
    } else {
      try {
        await Promise.all(
          admins.map((admin) =>
            this.notificationsService.create({
              type: 'DEVICE_AUTH',
              title: 'New Device Login Request',
              message: notifMessage,
              userId: admin.id,
              entityId: device.id,
              entityType: 'Device',
            }),
          ),
        );
      } catch (err: any) {
        this.logger.error(
          `[DevicesService] Failed to send device auth notifications: ${err.message}`,
          err.stack,
        );
      }
    }

    return { requestId: device.id, status: DeviceStatus.PENDING };
  }

  async generateAuthorizationCode(deviceId: string, approvedById: string) {
    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
      include: { user: true },
    });

    if (!device) throw new NotFoundException('Device not found');

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const hashedCode = await bcrypt.hash(code, 10);
    const expiry = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes

    // Device remains PENDING until the user successfully verifies the OTP!
    await this.prisma.device.update({
      where: { id: deviceId },
      data: {
        status: DeviceStatus.PENDING,
        approvedById,
        requestCode: hashedCode,
        requestCodeExpiry: expiry,
      },
    });

    let emailSent = false;
    let emailError: string | null = null;

    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
      emailError = 'EMAIL_USER / EMAIL_PASS not configured on the server — share the code directly with the user.';
      this.logger.warn('[DevicesService] Email credentials missing. Code was generated but not emailed.');
    } else {
      // 🚀 FIRE AND FORGET: We remove the "await" so the frontend UI gets the code instantly!
      emailSent = true; 
      try {
        const transporter = this.getMailTransporter();
        
        transporter.sendMail({
          from: `"Njugush POS" <${process.env.EMAIL_USER}>`,
          to: device.user.email,
          subject: 'Device Authorization Code - Njugush POS',
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <h2 style="color: #2563eb;">Device Authorization Code</h2>
              <p>An authorization code has been generated for your device. Enter this code to complete login:</p>
              <div style="background: #f3f4f6; padding: 20px; text-align: center; border-radius: 8px; margin: 20px 0;">
                <h1 style="letter-spacing: 12px; color: #2563eb; font-size: 36px; margin: 0;">${code}</h1>
              </div>
              <p>This code expires in <strong>30 minutes</strong>.</p>
              <p style="color: #ef4444;">If you did not request this, contact your administrator immediately.</p>
              <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 20px 0;" />
              <p style="font-size: 12px; color: #6b7280;">Njugush Enterprises POS System</p>
            </div>
          `,
        }).catch((err: any) => {
          this.logger.error(`[DevicesService] Background email delivery failed: ${err.message}`);
        });
      } catch (err: any) {
        emailSent = false;
        emailError = 'Failed to initiate email sending.';
        this.logger.error('[DevicesService] Failed to setup mailer:', err.message);
      }
    }

    try {
      await this.auditLogsService.create({
        userId: approvedById ?? undefined,
        action: 'DEVICE_CODE_GENERATED',
        description: `Authorization code generated for device ${deviceId} (user: ${device.user.email})`,
        entityType: 'Device',
        entityId: deviceId,
      });
    } catch (auditErr: any) {
      this.logger.warn(`[DevicesService] Audit log failed (non-blocking): ${auditErr.message}`);
    }

    return {
      message: emailSent
        ? 'Authorization code generated and emailed to user'
        : 'Authorization code generated — share the code with the user',
      code,
      emailSent,
      emailError,
      userEmail: device.user.email,
      userName: `${device.user.firstName} ${device.user.lastName}`,
    };
  }

  async verifyAuthorizationCode(requestId: string, code: string) {
    const device = await this.prisma.device.findUnique({
      where: { id: requestId },
    });

    if (!device) {
      return { valid: false, message: 'Device authorization request not found' };
    }

    if (!device.requestCode) {
      return {
        valid: false,
        message: 'No authorization code generated yet. Please ask your administrator to generate a code.',
      };
    }

    if (
      device.requestCodeExpiry &&
      device.requestCodeExpiry < new Date()
    ) {
      return {
        valid: false,
        message: 'Authorization code has expired. Please ask your administrator for a new code.',
      };
    }

    const isValid = await bcrypt.compare(code, device.requestCode);
    if (!isValid) {
      return { valid: false, message: 'Invalid authorization code. Please check and try again.' };
    }

    // Mark as APPROVED ONLY upon successful OTP verification!
    await this.prisma.device.update({
      where: { id: requestId },
      data: {
        status: DeviceStatus.APPROVED,
        requestCode: null,
        requestCodeExpiry: null,
      },
    });

    return { valid: true, userId: device.userId };
  }

  async updateLastUsed(userId: string, fingerprint: string) {
    const device = await this.prisma.device.findFirst({
      where: { userId, fingerprint },
    });
    if (device) {
      await this.prisma.device.update({
        where: { id: device.id },
        data: { lastUsedAt: new Date() },
      });
    }
  }

  async getPendingDevices() {
    return this.prisma.device.findMany({
      where: { status: DeviceStatus.PENDING },
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            role: true,
            branch: { select: { name: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getAllDevices() {
    return this.prisma.device.findMany({
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            role: true,
            branch: { select: { name: true } },
          },
        },
        approvedBy: { select: { firstName: true, lastName: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async revokeDevice(deviceId: string) {
    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
    });
    if (!device) throw new NotFoundException('Device not found');
    return this.prisma.device.update({
      where: { id: deviceId },
      data: { status: DeviceStatus.REVOKED },
    });
  }
}
