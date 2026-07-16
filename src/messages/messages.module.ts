import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { MessagesController } from './messages.controller';
import { MessagesService } from './messages.service';
import { MessageProcessor } from './message.processor';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { MESSAGE_QUEUE } from './messages.constants';

@Module({
  imports: [
    BullModule.registerQueue({ name: MESSAGE_QUEUE }),
    WhatsAppModule,
  ],
  controllers: [MessagesController],
  providers: [MessagesService, MessageProcessor],
})
export class MessagesModule {}
