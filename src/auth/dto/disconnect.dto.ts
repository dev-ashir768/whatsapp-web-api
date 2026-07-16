import { IsString, IsNotEmpty, IsBoolean, IsOptional } from 'class-validator';

export class DisconnectDto {
  @IsString()
  @IsNotEmpty()
  tenantId: string;

  @IsBoolean()
  @IsOptional()
  logout?: boolean;
}
