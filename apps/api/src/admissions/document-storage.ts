import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Tx } from '../db/db.service';

/**
 * Where document bytes live (A-042). The default keeps them in PostgreSQL (append-only
 * `document_blobs`, tenant-isolated by RLS); an S3-compatible adapter can replace it.
 */
export abstract class DocumentStorage {
  abstract put(tx: Tx, organizationId: string, content: Buffer): Promise<string>;
  abstract get(tx: Tx, key: string): Promise<Buffer | null>;
}

@Injectable()
export class DbDocumentStorage extends DocumentStorage {
  async put(tx: Tx, organizationId: string, content: Buffer): Promise<string> {
    const key = `db:${randomUUID()}`;
    await tx.documentBlob.create({
      data: { key, organizationId, content: new Uint8Array(content) },
    });
    return key;
  }
  async get(tx: Tx, key: string): Promise<Buffer | null> {
    const b = await tx.documentBlob.findUnique({ where: { key } });
    return b ? Buffer.from(b.content) : null;
  }
}

/** Checks the file really is what its type claims (first bytes), not just the declared type. */
export function sniffContentType(buf: Buffer): string | null {
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return 'image/png';
  if (
    buf.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buf.subarray(8, 12).toString('latin1') === 'WEBP'
  )
    return 'image/webp';
  return null;
}
