import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config';
import { DevLogMailService, MailService, SmtpMailService } from './mail.service';

@Global()
@Module({
  providers: [
    {
      provide: MailService,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        config.SMTP_URL ? new SmtpMailService(config) : new DevLogMailService(),
    },
  ],
  exports: [MailService],
})
export class MailModule {}
