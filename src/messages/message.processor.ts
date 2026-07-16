import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { PrismaService } from '../prisma/prisma.service';
import { MESSAGE_QUEUE, MESSAGE_JOB } from './messages.constants';
import { MessageJobPayload } from './messages.service';

@Processor(MESSAGE_QUEUE, {
  concurrency: 1,
  lockDuration: 60_000,  // 60s lock — covers max delay + send time
  lockRenewTime: 20_000, // Renew every 20s so lock never expires mid-job
})
export class MessageProcessor extends WorkerHost {
  private readonly logger = new Logger(MessageProcessor.name);
  private readonly delayMin: number;
  private readonly delayMax: number;

  constructor(
    private readonly whatsAppService: WhatsAppService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    super();
    this.delayMin = parseInt(config.get('MSG_DELAY_MIN', '2000'), 10);
    this.delayMax = parseInt(config.get('MSG_DELAY_MAX', '6000'), 10);
  }

  async process(job: Job<MessageJobPayload>): Promise<void> {
    const { tenantId, to, message, variables, logId } = job.data;

    this.logger.log(`Processing job ${job.id} → ${to} (attempt ${job.attemptsMade + 1})`);

    await this.prisma.messageLog.update({
      where: { id: logId },
      data: { status: 'PROCESSING' },
    });

    const delay = this.randomDelay();
    this.logger.debug(`Waiting ${delay}ms before sending to ${to}`);
    await this.sleep(delay);

    const finalMessage = this.interpolate(message, variables);

    await this.whatsAppService.sendMessage(tenantId, to, finalMessage);

    await this.prisma.messageLog.update({
      where: { id: logId },
      data: { status: 'SENT', sentAt: new Date() },
    });

    this.logger.log(`Job ${job.id} delivered to ${to}`);
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<MessageJobPayload>, error: Error) {
    this.logger.error(`Job ${job.id} failed: ${error.message}`);

    const isFinalAttempt = job.attemptsMade >= (job.opts.attempts ?? 3);

    if (isFinalAttempt) {
      await this.prisma.messageLog.update({
        where: { id: job.data.logId },
        data: { status: 'FAILED', error: error.message },
      });
    }
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job) {
    this.logger.debug(`Job ${job.id} completed`);
  }

  private interpolate(template: string, variables?: Record<string, string>): string {
    if (!variables || Object.keys(variables).length === 0) return template;
    return template.replace(/\{\{(\w+)\}\}/g, (_, key) => variables[key] ?? `{{${key}}}`);
  }

  private randomDelay(): number {
    return Math.floor(Math.random() * (this.delayMax - this.delayMin + 1)) + this.delayMin;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
