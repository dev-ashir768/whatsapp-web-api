import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';

@Module({
  imports: [WhatsAppModule],
  controllers: [AuthController],
})
export class AuthModule {}
