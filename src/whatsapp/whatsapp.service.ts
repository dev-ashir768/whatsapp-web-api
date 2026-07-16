import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import {
  makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  WASocket,
  ConnectionState,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { PrismaService } from '../prisma/prisma.service';
import { PrismaAuthState } from './prisma-auth-state';
import * as QRCode from 'qrcode';
import pino from 'pino';

interface SessionMeta {
  socket: WASocket;
  qr?: string;
  status: 'connecting' | 'connected' | 'disconnected' | 'qr_pending';
}

@Injectable()
export class WhatsAppService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WhatsAppService.name);
  private sessions = new Map<string, SessionMeta>();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * On server start, restore all sessions that have saved auth credentials.
   * This means previously connected tenants reconnect automatically without
   * needing to scan QR again.
   */
  async onModuleInit() {
    const sessions = await this.prisma.whatsAppSession.findMany({
      where: { authState: { isNot: null } },
      select: { tenantId: true },
    });

    if (sessions.length === 0) {
      this.logger.log('No saved sessions to restore.');
      return;
    }

    this.logger.log(`Restoring ${sessions.length} session(s) from database...`);

    for (const { tenantId } of sessions) {
      // Fire-and-forget — each socket reconnects independently
      this.createSocket(tenantId).catch((err) =>
        this.logger.error(`Failed to restore session for tenant ${tenantId}: ${err.message}`),
      );
    }
  }

  async onModuleDestroy() {
    for (const [tenantId, meta] of this.sessions) {
      this.logger.log(`Closing socket for tenant ${tenantId}`);
      meta.socket.end(undefined);
    }
  }

  async connectTenant(tenantId: string): Promise<string> {
    if (this.sessions.has(tenantId)) {
      const meta = this.sessions.get(tenantId)!;
      if (meta.status === 'connected') return 'Already connected';
      if (meta.status === 'qr_pending' && meta.qr) return meta.qr;
      // Still connecting (being restored on startup) — wait briefly then check
      if (meta.status === 'connecting') return 'connecting';
    }

    await this.prisma.whatsAppSession.upsert({
      where: { tenantId },
      create: { tenantId, status: 'CONNECTING' },
      update: { status: 'CONNECTING' },
    });

    return this.createSocket(tenantId);
  }

  private async createSocket(tenantId: string): Promise<string> {
    const { version } = await fetchLatestBaileysVersion();
    const prismaAuth = new PrismaAuthState(tenantId, this.prisma);
    const { state, saveCreds } = await prismaAuth.init();

    const socket = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
      markOnlineOnConnect: false,
      logger: pino({ level: 'silent' }),
    });

    const meta: SessionMeta = { socket, status: 'connecting' };
    this.sessions.set(tenantId, meta);

    return new Promise<string>((resolve) => {
      let resolved = false;

      const done = (value: string) => {
        if (!resolved) {
          resolved = true;
          resolve(value);
        }
      };

      socket.ev.on('creds.update', saveCreds);

      socket.ev.on('connection.update', async (update: Partial<ConnectionState>) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          const qrDataUrl = await QRCode.toDataURL(qr);
          meta.status = 'qr_pending';
          meta.qr = qrDataUrl;

          await this.prisma.whatsAppSession.update({
            where: { tenantId },
            data: { status: 'QR_PENDING' },
          });

          // Always update the stored QR so /auth/qr always returns the latest one
          this.logger.log(`New QR generated for tenant ${tenantId}`);
          done(qrDataUrl);
        }

        if (connection === 'open') {
          meta.status = 'connected';
          meta.qr = undefined;
          this.logger.log(`Tenant ${tenantId} connected`);

          await this.prisma.whatsAppSession.update({
            where: { tenantId },
            data: {
              status: 'CONNECTED',
              phoneNumber: socket.user?.id?.split(':')[0] ?? null,
            },
          });

          done('connected');
        }

        if (connection === 'close') {
          const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
          const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

          this.logger.warn(
            `Tenant ${tenantId} disconnected (code ${statusCode}), reconnect=${shouldReconnect}`,
          );

          meta.status = 'disconnected';

          await this.prisma.whatsAppSession.update({
            where: { tenantId },
            data: { status: 'DISCONNECTED' },
          });

          if (shouldReconnect) {
            setTimeout(() => this.createSocket(tenantId), 5_000);
          } else {
            // Logged out — remove saved credentials so QR is requested fresh next time
            await this.prisma.authState.deleteMany({
              where: { session: { tenantId } },
            });
            this.sessions.delete(tenantId);
          }

          done('disconnected');
        }
      });
    });
  }

  async disconnectTenant(tenantId: string, logout = false): Promise<void> {
    const meta = this.sessions.get(tenantId);

    if (!meta) {
      throw new Error(`No active session found for tenant ${tenantId}`);
    }

    if (logout) {
      // Full logout — clears WhatsApp session on the phone too, deletes saved credentials
      await meta.socket.logout();
      await this.prisma.authState.deleteMany({ where: { session: { tenantId } } });
      this.logger.log(`Tenant ${tenantId} logged out and credentials cleared`);
    } else {
      // Soft disconnect — keeps credentials in DB so next connectTenant() restores without QR
      meta.socket.end(undefined);
      this.logger.log(`Tenant ${tenantId} disconnected (credentials preserved)`);
    }

    meta.status = 'disconnected';
    this.sessions.delete(tenantId);

    await this.prisma.whatsAppSession.update({
      where: { tenantId },
      data: { status: 'DISCONNECTED' },
    });
  }

  async sendMessage(tenantId: string, to: string, text: string): Promise<void> {
    const meta = this.sessions.get(tenantId);

    if (!meta || meta.status !== 'connected') {
      throw new Error(
        `Tenant ${tenantId} is not connected (status: ${meta?.status ?? 'not_initialized'}). ` +
        `Call POST /auth/connect first and wait for status: connected.`,
      );
    }

    const jid = to.includes('@') ? to : `${this.normalizePhone(to)}@s.whatsapp.net`;

    // Verify the number is actually registered on WhatsApp before sending —
    // sending to a non-existent JID silently goes nowhere.
    const [result] = await meta.socket.onWhatsApp(jid);
    if (!result?.exists) {
      throw new Error(`Number ${to} (jid: ${jid}) is not registered on WhatsApp`);
    }

    await meta.socket.sendMessage(result.jid, { text });
    this.logger.log(`Message sent to ${result.jid}`);
  }

  /**
   * Converts a phone number to international format required by WhatsApp.
   * - Strips +, spaces, and dashes
   * - Replaces a leading 0 with DEFAULT_COUNTRY_CODE (e.g. 03161065268 → 923161065268)
   */
  private normalizePhone(phone: string): string {
    let digits = phone.replace(/[^\d]/g, '');
    const countryCode = process.env.DEFAULT_COUNTRY_CODE ?? '92';
    if (digits.startsWith('0')) {
      digits = countryCode + digits.slice(1);
    }
    return digits;
  }

  getStatus(tenantId: string) {
    const meta = this.sessions.get(tenantId);
    return meta ? meta.status : 'not_initialized';
  }

  getCurrentQr(tenantId: string): string {
    const meta = this.sessions.get(tenantId);
    if (!meta) return 'not_initialized';
    if (meta.status === 'connected') return 'connected';
    if (meta.status === 'qr_pending' && meta.qr) return meta.qr;
    return meta.status;
  }
}
