import { IsString, IsNotEmpty, MaxLength } from 'class-validator';

export class ConnectDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  tenantId: string;
}
