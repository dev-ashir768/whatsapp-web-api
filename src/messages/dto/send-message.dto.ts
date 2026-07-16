import {
  IsString,
  IsNotEmpty,
  IsArray,
  ArrayMinSize,
  ValidateNested,
  MaxLength,
  IsOptional,
} from 'class-validator';
import { Type } from 'class-transformer';

export class MessageRecipient {
  @IsString()
  @IsNotEmpty()
  phone: string;

  // Optional per-recipient template variable overrides
  @IsOptional()
  variables?: Record<string, string>;
}

export class SendMessageDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  tenantId: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => MessageRecipient)
  recipients: MessageRecipient[];

  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  message: string;
}
