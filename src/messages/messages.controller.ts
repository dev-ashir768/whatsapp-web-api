import { Controller, Post, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { MessagesService } from './messages.service';
import { SendMessageDto } from './dto/send-message.dto';

@Controller('messages')
export class MessagesController {
  constructor(private readonly messagesService: MessagesService) {}

  /**
   * POST /api/v1/messages/send
   * Accepts a bulk message payload and pushes each recipient as a BullMQ job.
   */
  @Post('send')
  @HttpCode(HttpStatus.ACCEPTED)
  async send(@Body() dto: SendMessageDto) {
    const result = await this.messagesService.enqueueBulk(dto);
    return {
      success: true,
      ...result,
      message: `${result.queued} message(s) queued for delivery`,
    };
  }
}
