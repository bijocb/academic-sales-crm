import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { APP_CONFIG, AppConfig } from '../config';
import { AccountTokensService } from './account-tokens.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({ secret: config.JWT_ACCESS_SECRET }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, AccountTokensService],
  exports: [AuthService, AccountTokensService],
})
export class AuthModule {}
