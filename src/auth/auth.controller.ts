import { Controller, Post, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { ConnectDto } from './dto/connect.dto';
import { DisconnectDto } from './dto/disconnect.dto';

const QR_TTL_SECONDS = 20;

@Controller('auth')
export class AuthController {
  constructor(private readonly whatsAppService: WhatsAppService) {}

  /**
   * POST /api/v1/auth/connect
   * Initiates a WhatsApp socket for the tenant and returns a QR code.
   * QR codes expire in ~20 seconds — poll /auth/qr for a fresh one.
   */
  @Post('connect')
  @HttpCode(HttpStatus.OK)
  async connect(@Body() dto: ConnectDto) {
    const result = await this.whatsAppService.connectTenant(dto.tenantId);
    return this.buildConnectResponse(dto.tenantId, result);
  }

  /**
   * POST /api/v1/auth/qr
   * Returns the latest QR code stored in memory.
   * Poll this every 15-18 seconds while status is qr_pending.
   * Baileys automatically generates a new QR when the previous one expires.
   */
  @Post('qr')
  @HttpCode(HttpStatus.OK)
  async getQr(@Body() dto: ConnectDto) {
    const result = this.whatsAppService.getCurrentQr(dto.tenantId);
    return this.buildConnectResponse(dto.tenantId, result);
  }

  /**
   * POST /api/v1/auth/disconnect
   * logout: false (default) — closes the socket but keeps credentials in DB.
   *         Next connectTenant() call restores the session without a QR scan.
   * logout: true — fully logs out from WhatsApp, deletes saved credentials.
   *         Next connectTenant() will require a fresh QR scan.
   */
  @Post('disconnect')
  @HttpCode(HttpStatus.OK)
  async disconnect(@Body() dto: DisconnectDto) {
    await this.whatsAppService.disconnectTenant(dto.tenantId, dto.logout ?? false);
    return {
      tenantId: dto.tenantId,
      status: 'disconnected',
      credentialsCleared: dto.logout ?? false,
      message: dto.logout
        ? 'Logged out from WhatsApp. Credentials deleted — a new QR scan will be required.'
        : 'Disconnected. Credentials preserved — call /auth/connect to reconnect without QR.',
    };
  }

  /**
   * POST /api/v1/auth/status
   * Returns the current connection status for a tenant's socket.
   */
  @Post('status')
  @HttpCode(HttpStatus.OK)
  async status(@Body() dto: ConnectDto) {
    return {
      tenantId: dto.tenantId,
      status: this.whatsAppService.getStatus(dto.tenantId),
    };
  }

  private buildConnectResponse(tenantId: string, result: string) {
    const isQr = result.startsWith('data:image');
    const expiresAt = isQr ? new Date(Date.now() + QR_TTL_SECONDS * 1000) : null;

    return {
      tenantId,
      status: isQr ? 'qr_pending' : result,
      qrCode: isQr ? result : null,
      ...(isQr && {
        expiresAt: expiresAt!.toISOString(),
        expiresInSeconds: QR_TTL_SECONDS,
        message: `Scan the QR code within ${QR_TTL_SECONDS} seconds. Call POST /auth/qr for a fresh code if it expires.`,
      }),
      ...(!isQr && {
        message: result === 'connected' || result === 'Already connected'
          ? 'Session already active'
          : result,
      }),
    };
  }
}
