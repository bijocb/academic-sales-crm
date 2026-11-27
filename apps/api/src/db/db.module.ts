import { Global, Module } from '@nestjs/common';
import { Db } from './db.service';
import { PrismaService } from './prisma.service';

@Global()
@Module({ providers: [PrismaService, Db], exports: [Db, PrismaService] })
export class DbModule {}
