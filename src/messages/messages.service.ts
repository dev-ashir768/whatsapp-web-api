import { Injectable, Logger, ConflictException, NotFoundException } from '@nestjs/common';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { SendMessageDto } from './dto/send-message.dto';
import { MESSAGE_QUEUE, MESSAGE_JOB } from './messages.constants';

export interface MessageJobPayload {
  tenantId: string;
  to: string;
  message: string;
  variables?: Record<string, string>;
  logId: string;
}

@Injectable()
export class MessagesService {
  private readonly logger = new Logger(MessagesService.name);

  constructor(
    @InjectQueue(MESSAGE_QUEUE) private readonly queue: Queue,
    private readonly prisma: PrismaService,
    private readonly whatsAppService: WhatsAppService,
  ) {}

  async enqueueBulk(dto: SendMessageDto): Promise<{ queued: number; jobIds: string[] }> {
    const session = await this.prisma.whatsAppSession.findUnique({
      where: { tenantId: dto.tenantId },
    });

    if (!session) {
      throw new NotFoundException(
        `No session found for tenant ${dto.tenantId}. Call POST /auth/connect and scan the QR code first.`,
      );
    }

    // Reject upfront if the socket is not connected — otherwise jobs are
    // accepted with 202 but silently fail/retry in the background.
    const status = this.whatsAppService.getStatus(dto.tenantId);
    if (status !== 'connected') {
      throw new ConflictException(
        `Tenant ${dto.tenantId} is not connected (status: ${status}). ` +
        `Call POST /auth/connect and wait for status "connected" before sending.`,
      );
    }

    const jobIds: string[] = [];

    for (const recipient of dto.recipients) {
      // Persist a log entry before enqueuing so we can track status
      const log = await this.prisma.messageLog.create({
        data: {
          sessionId: session.id,
          to: recipient.phone,
          message: dto.message,
          status: 'QUEUED',
        },
      });

      const job = await this.queue.add(
        MESSAGE_JOB.SEND,
        {
          tenantId: dto.tenantId,
          to: recipient.phone,
          message: dto.message,
          variables: recipient.variables,
          logId: log.id,
        } satisfies MessageJobPayload,
        {
          jobId: `msg-${log.id}`,
          // Stagger jobs: each gets a delay based on its position in the batch.
          // The actual per-message random delay is added by the worker itself.
          delay: dto.recipients.indexOf(recipient) * 1000,
        },
      );

      await this.prisma.messageLog.update({
        where: { id: log.id },
        data: { jobId: job.id },
      });

      jobIds.push(job.id!);
    }

    this.logger.log(`Enqueued ${dto.recipients.length} messages for tenant ${dto.tenantId}`);
    return { queued: dto.recipients.length, jobIds };
  }
}
