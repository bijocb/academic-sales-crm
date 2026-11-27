import { Inject, Injectable, Logger } from '@nestjs/common';
import nodemailer, { Transporter } from 'nodemailer';
import { APP_CONFIG, AppConfig } from '../config';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export abstract class MailService {
  abstract send(message: MailMessage): Promise<void>;
}

/** Sends through SMTP (Mailpit locally, real provider in production). */
@Injectable()
export class SmtpMailService extends MailService {
  private readonly transport: Transporter;
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    super();
    this.transport = nodemailer.createTransport(config.SMTP_URL);
  }
  async send(message: MailMessage): Promise<void> {
    await this.transport.sendMail({ from: this.config.MAIL_FROM, ...message });
  }
}

/**
 * DEVELOPMENT ONLY — writes emails to the log instead of sending them.
 * Used when SMTP_URL is empty outside production (config validation forbids it in production).
 */
@Injectable()
export class DevLogMailService extends MailService {
  private readonly logger = new Logger('DevLogMail');
  async send(message: MailMessage): Promise<void> {
    this.logger.warn(
      `[DEV MAIL — NOT SENT] to=${message.to} subject="${message.subject}"\n${message.text}`,
    );
  }
}
