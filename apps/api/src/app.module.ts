import './common/bigint-json';
import { DynamicModule, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { APP_CONFIG, AppConfig } from './config';
import { Clock, SystemClock } from './common/clock';
import { HttpErrorFilter } from './common/http-exception.filter';
import { DbModule } from './db/db.module';
import { RedisModule } from './redis.module';
import { AuditModule } from './audit/audit.module';
import { MailModule } from './mail/mail.module';
import { AuthModule } from './auth/auth.module';
import { AuthGuard } from './auth/auth.guard';
import { CsrfMiddleware } from './auth/csrf.middleware';
import { HealthController } from './health/health.controller';
import { OrganizationsAdminController } from './platform/organizations.controller';
import { OrganizationsAdminService } from './platform/organizations.service';
import { OrganizationController } from './organization/organization.controller';
import { BrandsController } from './brands/brands.controller';
import { BrandsService } from './brands/brands.service';
import { TeamsController } from './teams/teams.controller';
import { TeamsService } from './teams/teams.service';
import { UsersController } from './users/users.controller';
import { UsersService } from './users/users.service';
import { RolesController } from './roles/roles.controller';
import { RolesService } from './roles/roles.service';
import { CatalogController } from './catalog/catalog.controller';
import { CatalogService } from './catalog/catalog.service';
import { SettingsController } from './settings/settings.controller';
import { SettingsService } from './settings/settings.service';
import { IntakeController } from './leads/intake.controller';
import { LeadsController } from './leads/leads.controller';
import { IntakeService } from './leads/intake.service';
import { IntakeKeyResolver } from './leads/intake-keys';
import { LeadsService } from './leads/leads.service';
import { LeadConfigService } from './leads/lead-config.service';
import { IntakeAdminService } from './leads/intake-admin.service';

@Module({})
export class AppModule implements NestModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        CoreModule.forRoot(config),
        LoggerModule.forRoot({
          pinoHttp: {
            level: config.NODE_ENV === 'test' ? 'silent' : 'info',
            genReqId: (req: IncomingMessage) =>
              (req.headers['x-request-id'] as string) || randomUUID(),
            redact: [
              'req.headers.authorization',
              'req.headers.cookie',
              'res.headers["set-cookie"]',
            ],
            transport:
              config.NODE_ENV === 'development'
                ? { target: 'pino-pretty', options: { singleLine: true } }
                : undefined,
          },
        }),
        ThrottlerModule.forRoot({
          throttlers: [{ name: 'default', ttl: 60_000, limit: 300 }],
          // Tests exercise many logins; they opt into throttling explicitly with this header.
          skipIf: (ctx) =>
            config.NODE_ENV === 'test' &&
            !ctx.switchToHttp().getRequest().headers['x-test-rate-limit'],
        }),
        DbModule,
        RedisModule,
        AuditModule,
        MailModule,
        AuthModule,
      ],
      controllers: [
        HealthController,
        OrganizationsAdminController,
        OrganizationController,
        BrandsController,
        TeamsController,
        UsersController,
        RolesController,
        CatalogController,
        SettingsController,
        IntakeController,
        LeadsController,
      ],
      providers: [
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: HttpErrorFilter },
        OrganizationsAdminService,
        BrandsService,
        TeamsService,
        UsersService,
        RolesService,
        CatalogService,
        SettingsService,
        IntakeService,
        IntakeKeyResolver,
        LeadsService,
        LeadConfigService,
        IntakeAdminService,
      ],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CsrfMiddleware).forRoutes('*');
  }
}

@Module({})
class CoreModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: CoreModule,
      global: true,
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: Clock, useClass: SystemClock },
      ],
      exports: [APP_CONFIG, Clock],
    };
  }
}
