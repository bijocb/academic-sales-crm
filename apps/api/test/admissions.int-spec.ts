import { AdmissionsService } from '../src/admissions/admissions.service';
import { LmsRegistry, SandboxLmsProvider } from '../src/admissions/lms';
import { Db } from '../src/db/db.service';
import { WorkerService } from '../src/jobs/worker.service';
import {
  bearer,
  createOrgFixture,
  createTestContext,
  createUser,
  OrgFixture,
  TestContext,
} from './helpers';

const PDF = Buffer.from('%PDF-1.4\n% test document\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32, 1),
]);

/** Phase 11 exit gate: admission workflow and capacity checks. */
describe('Admissions and documents', () => {
  let ctx: TestContext;
  let a: OrgFixture;
  const t: Record<string, string> = {};
  const id: Record<string, string> = {};
  const docType: Record<string, string> = {};
  let intakeKey = '';
  let course = '';
  let smallBatch = '';
  let bigBatch = '';
  const MON_11 = new Date('2026-11-30T05:30:00Z');

  const post = (who: string, url: string, body: object = {}) =>
    ctx.http().post(`/api/v1${url}`).set('Authorization', t[who]).send(body);
  const put = (who: string, url: string, body: object) =>
    ctx.http().put(`/api/v1${url}`).set('Authorization', t[who]).send(body);
  const patch = (who: string, url: string, body: object) =>
    ctx.http().patch(`/api/v1${url}`).set('Authorization', t[who]).send(body);
  const get = (who: string, url: string) =>
    ctx.http().get(`/api/v1${url}`).set('Authorization', t[who]);
  const upload = (
    who: string,
    admissionId: string,
    code: string,
    buf: Buffer,
    name = 'doc.pdf',
    type = 'application/pdf',
  ) =>
    ctx
      .http()
      .post(`/api/v1/admissions/${admissionId}/documents/${docType[code]}`)
      .set('Authorization', t[who])
      .attach('file', buf, { filename: name, contentType: type });
  const confirm = (admissionId: string, source = 'PAYMENT_VERIFIED:test') =>
    ctx.app
      .get(Db)
      .tenant(a.orgId, (tx) =>
        ctx.app
          .get(AdmissionsService)
          .confirmInTx(tx, admissionId, { source, actorUserId: null, now: ctx.clock.now() }),
      );
  let n = 0;
  /** An open lead owned by e1 with an accepted quotation for `batch`. */
  const readyLead = async (batch = smallBatch) => {
    n++;
    const res = await ctx
      .http()
      .post('/api/v1/intake/leads')
      .set('Authorization', `Bearer ${intakeKey}`)
      .send({
        name: `Admit Student ${n}`,
        phone: `+91 91000 ${String(60000 + n).slice(-5)}`,
        email: `student${n}@example.com`,
      });
    const e = await ctx.owner.enquiry.findUniqueOrThrow({ where: { id: res.body.reference } });
    await post('bm1', `/leads/${e.leadId}/assign`, { userId: id.e1, reason: 'Test' });
    const q = await post('e1', `/leads/${e.leadId}/quotations`, {
      courseId: course,
      batchId: batch,
    });
    expect((await post('e1', `/quotations/${q.body.id}/accept`)).status).toBe(201);
    return e.leadId;
  };
  const admissionFor = async (leadId: string) => {
    const r = await post('e1', `/leads/${leadId}/admission`);
    expect(r.status).toBe(201);
    return r.body.id as string;
  };
  const docId = async (admissionId: string, code: string) =>
    (
      await ctx.owner.admissionDocument.findFirstOrThrow({
        where: { admissionId, documentTypeId: docType[code] },
      })
    ).id;
  const status = async (admissionId: string) =>
    (await ctx.owner.admission.findUniqueOrThrow({ where: { id: admissionId } })).status;
  /** Upload and verify every required document. */
  const completeDocs = async (admissionId: string) => {
    for (const code of ['PHOTO', 'ID_PROOF', 'QUALIFICATION']) {
      expect((await upload('e1', admissionId, code, PDF)).status).toBe(201);
      expect(
        (await post('ao1', `/admission-documents/${await docId(admissionId, code)}/verify`)).status,
      ).toBe(201);
    }
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    a = await createOrgFixture(ctx.owner, 'adm-a');
    id.admin = await createUser(ctx.owner, a, 'admin@adm.test', [
      { role: 'ORG_ADMIN', scope: 'ORGANIZATION' },
    ]);
    id.bm1 = await createUser(ctx.owner, a, 'bm1@adm.test', [
      { role: 'BRAND_MANAGER', scope: 'BRAND', brand: 'B1' },
    ]);
    id.ao1 = await createUser(ctx.owner, a, 'ao1@adm.test', [
      { role: 'ADMISSION_OFFICER', scope: 'BRAND', brand: 'B1' },
    ]);
    for (const e of ['e1', 'e2'])
      id[e] = await createUser(ctx.owner, a, `${e}@adm.test`, [
        { role: 'SALES_EXECUTIVE', scope: 'TEAM', brand: 'B1' },
      ]);
    for (const k of ['admin', 'bm1', 'ao1', 'e1', 'e2']) t[k] = await bearer(ctx, `${k}@adm.test`);
    const src = await ctx.owner.leadSource.findFirstOrThrow({
      where: { brandId: a.brands.B1, channel: 'WEBSITE' },
    });
    ctx.clock.set(MON_11);
    intakeKey = (await post('admin', '/intake-keys', { sourceId: src.id, name: 'web' })).body.key;
    course = (
      await ctx.owner.course.create({
        data: {
          organizationId: a.orgId,
          brandId: a.brands.B1,
          code: 'DA',
          name: 'Data Analytics',
          deliveryMode: 'HYBRID',
          currency: 'INR',
          listFeeMinor: 9_000_000n,
        },
      })
    ).id;
    const mkBatch = async (code: string, capacity: number) =>
      (
        await ctx.owner.batch.create({
          data: {
            organizationId: a.orgId,
            brandId: a.brands.B1,
            courseId: course,
            code,
            name: `Batch ${code}`,
            startDate: new Date('2027-01-11'),
            capacity,
            status: 'OPEN',
          },
        })
      ).id;
    smallBatch = await mkBatch('JAN-S', 1);
    bigBatch = await mkBatch('JAN-L', 10);
    for (const d of await ctx.owner.documentType.findMany({ where: { brandId: a.brands.B1 } }))
      docType[d.code] = d.id;
  });
  afterAll(() => ctx.close());

  it('starts from the accepted quotation: student profile linked, course checklist built, documents pending', async () => {
    // The course makes address proof required on top of the brand defaults.
    const req = await put('bm1', `/courses/${course}/document-requirements`, {
      requirements: [{ documentTypeId: docType.ADDRESS_PROOF, required: true }],
    });
    expect(req.body.find((r: { code: string }) => r.code === 'ADDRESS_PROOF')).toMatchObject({
      required: true,
      overridden: true,
    });
    const leadId = await readyLead();
    expect((await post('e2', `/leads/${leadId}/admission`)).status).toBe(404);
    const r = await post('e1', `/leads/${leadId}/admission`);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      status: 'DOCUMENTS_PENDING',
      courseId: course,
      batchId: smallBatch,
    });
    const view = await get('e1', `/admissions/${r.body.id}`);
    expect(view.body.student.legalName).toMatch(/^Admit Student/);
    expect(
      view.body.documents.map((d: { type: { code: string }; required: boolean }) => [
        d.type.code,
        d.required,
      ]),
    ).toEqual([
      ['PHOTO', true],
      ['ID_PROOF', true],
      ['QUALIFICATION', true],
      ['ADDRESS_PROOF', true],
      ['PASSPORT_VISA', false],
    ]);
    expect(view.body.can).toMatchObject({ work: true, manage: false, viewDocuments: false });
    expect((await post('e1', `/leads/${leadId}/admission`)).body.error.code).toBe(
      'ADMISSION_EXISTS',
    );
    const h = await ctx.owner.admissionStatusHistory.findMany({
      where: { admissionId: r.body.id },
      orderBy: { occurredAt: 'asc' },
    });
    expect(h.map((x) => x.toStatus)).toEqual(['DRAFT', 'DOCUMENTS_PENDING']);
    await put('bm1', `/courses/${course}/document-requirements`, { requirements: [] });
    await post('ao1', `/admissions/${r.body.id}/cancel`, { reason: 'Test reset' });
  });

  it('uploads are type-checked by content, size-limited and versioned; the document phase moves by itself', async () => {
    const adm = await admissionFor(await readyLead(bigBatch));
    const fake = await upload('e1', adm, 'PHOTO', Buffer.from('not really a pdf'), 'x.pdf');
    expect(fake.body.error.code).toBe('FILE_TYPE_NOT_ALLOWED');
    const big = await upload(
      'e1',
      adm,
      'PHOTO',
      Buffer.concat([PDF, Buffer.alloc(4 * 1024 * 1024)]),
    );
    expect([400, 413]).toContain(big.status);
    expect((await upload('e2', adm, 'PHOTO', PDF)).status).toBe(404);
    expect((await upload('e1', adm, 'PHOTO', PNG, 'me.png', 'image/png')).status).toBe(201);
    expect((await upload('e1', adm, 'PHOTO', PDF, 'me-again.pdf')).status).toBe(201);
    const files = await ctx.owner.documentFile.findMany({
      where: { admissionDocumentId: await docId(adm, 'PHOTO') },
    });
    expect(files.map((f) => f.contentType).sort()).toEqual(['application/pdf', 'image/png']);
    expect(await status(adm)).toBe('DOCUMENTS_PENDING');
    await upload('e1', adm, 'ID_PROOF', PDF);
    await upload('e1', adm, 'QUALIFICATION', PDF);
    expect(await status(adm)).toBe('UNDER_VERIFICATION'); // optional documents do not block
    await expect(
      ctx.owner.$executeRawUnsafe(`DELETE FROM document_files WHERE id = '${files[0].id}'`),
    ).rejects.toThrow();
  });

  it('verification: only admission officers verify; rejection needs a reason and sends the admission back', async () => {
    const adm = await admissionFor(await readyLead(bigBatch));
    for (const code of ['PHOTO', 'ID_PROOF', 'QUALIFICATION']) await upload('e1', adm, code, PDF);
    const idDoc = await docId(adm, 'ID_PROOF');
    expect((await post('e1', `/admission-documents/${idDoc}/verify`)).status).toBe(403);
    expect((await post('ao1', `/admission-documents/${idDoc}/reject`, {})).status).toBe(400);
    expect(
      (
        await post('ao1', `/admission-documents/${idDoc}/reject`, {
          reason: 'Photo of ID is blurred',
        })
      ).status,
    ).toBe(201);
    expect(await status(adm)).toBe('DOCUMENTS_PENDING');
    const early = await post('ao1', `/admissions/${adm}/approve`);
    expect(early.body.error.code).toBe('DOCUMENTS_INCOMPLETE');
    expect(early.body.error.details.missing).toEqual(['PHOTO', 'ID_PROOF', 'QUALIFICATION']);
    await upload('e1', adm, 'ID_PROOF', PNG, 'id.png', 'image/png');
    expect(await status(adm)).toBe('UNDER_VERIFICATION');
    for (const code of ['PHOTO', 'ID_PROOF', 'QUALIFICATION'])
      await post('ao1', `/admission-documents/${await docId(adm, code)}/verify`);
    const view = await get('ao1', `/admissions/${adm}`);
    expect(view.body.readyForApproval).toBe(true);
    const reviews = await ctx.owner.documentReview.findMany({
      where: { admissionDocumentId: idDoc },
      orderBy: { occurredAt: 'asc' },
    });
    expect(reviews.map((r) => [r.decision, r.reason])).toEqual([
      ['REJECTED', 'Photo of ID is blurred'],
      ['VERIFIED', null],
    ]);
    expect((await post('ao1', `/admissions/${adm}/approve`)).body.status).toBe('APPROVED');
  });

  it('capacity: approval holds a seat; a full batch is refused unless an authorised override is recorded', async () => {
    const first = await admissionFor(await readyLead(smallBatch));
    await completeDocs(first);
    expect((await post('ao1', `/admissions/${first}/approve`)).body).toMatchObject({
      status: 'APPROVED',
      holdsSeat: true,
    });
    const second = await admissionFor(await readyLead(smallBatch));
    await completeDocs(second);
    const full = await post('ao1', `/admissions/${second}/approve`);
    expect(full.status).toBe(409);
    expect(full.body.error.code).toBe('BATCH_FULL');
    expect(
      (
        await post('ao1', `/admissions/${second}/approve`, {
          overrideCapacityReason: 'Extra chair',
        })
      ).status,
    ).toBe(403); // no course.manage
    const ok = await post('admin', `/admissions/${second}/approve`, {
      overrideCapacityReason: 'Scholarship student, director approved',
    });
    expect(ok.body).toMatchObject({
      status: 'APPROVED',
      seatOverride: true,
      seatOverrideReason: 'Scholarship student, director approved',
    });
    expect((await get('ao1', `/batches/${smallBatch}/seats`)).body).toMatchObject({
      capacity: 1,
      used: 2,
      available: 0,
    });
    // Deferring releases the seat; resuming sends it back to verification (approval must be given again).
    expect(
      (await post('ao1', `/admissions/${second}/defer`, { reason: 'Moved to the March intake' }))
        .body,
    ).toMatchObject({ status: 'DEFERRED', holdsSeat: false });
    expect((await get('ao1', `/batches/${smallBatch}/seats`)).body.used).toBe(1);
    expect((await post('ao1', `/admissions/${second}/resume`)).body.status).toBe(
      'UNDER_VERIFICATION',
    );
    expect((await post('ao1', `/admissions/${second}/approve`)).body.error.code).toBe('BATCH_FULL');
    expect((await patch('ao1', `/admissions/${second}/batch`, { batchId: bigBatch })).status).toBe(
      200,
    );
    expect((await post('ao1', `/admissions/${second}/approve`)).body.status).toBe('APPROVED');
  });

  it('confirmation (D-006, called by payments) numbers the admission, converts the lead and hands over to the LMS', async () => {
    const lms = ctx.app.get(LmsRegistry).provider as SandboxLmsProvider;
    const leadId = await readyLead(bigBatch);
    const adm = await admissionFor(leadId);
    await completeDocs(adm);
    await post('ao1', `/admissions/${adm}/approve`);
    const done = await confirm(adm);
    expect(done).toMatchObject({
      status: 'CONFIRMED',
      confirmationSource: 'PAYMENT_VERIFIED:test',
    });
    expect(done.admissionNumber).toMatch(/^B1-2026-\d{5}$/);
    expect((await confirm(adm)).admissionNumber).toBe(done.admissionNumber); // idempotent
    const lead = await ctx.owner.lead.findUniqueOrThrow({ where: { id: leadId } });
    expect(lead).toMatchObject({ stage: 'ADMISSION_CONFIRMED', status: 'CONVERTED' });
    expect(
      await ctx.owner.leadStageHistory.count({ where: { leadId, toStage: 'ADMISSION_CONFIRMED' } }),
    ).toBe(1);
    const handover = await ctx.owner.lmsHandover.findUniqueOrThrow({ where: { admissionId: adm } });
    expect(handover).toMatchObject({ status: 'PENDING', provider: 'sandbox-lms' });
    await ctx.app.get(WorkerService).tick();
    expect(
      (await ctx.owner.lmsHandover.findUniqueOrThrow({ where: { admissionId: adm } })).status,
    ).toBe('SENT');
    expect(lms.received.at(-1)).toMatchObject({
      admissionNumber: done.admissionNumber,
      batch: { code: 'JAN-L' },
      course: { code: 'DA' },
    });
    expect((await post('ao1', `/lms-handovers/${handover.id}/mark-done`)).body.error.code).toBe(
      'ALREADY_HANDED_OVER',
    );
    expect(
      (await post('ao1', `/admissions/${adm}/cancel`, { reason: 'Changed mind' })).body.error.code,
    ).toBe('USE_REFUND_FLOW');
    // The next number follows on.
    const next = await admissionFor(await readyLead(bigBatch));
    const n2 = await confirm(next); // D-006: payment confirms even before documents are complete
    expect(Number(n2.admissionNumber!.slice(-5))).toBe(Number(done.admissionNumber!.slice(-5)) + 1);
    expect(n2.holdsSeat).toBe(true);
  });

  it('confirmation respects capacity and the brand option to require approval first', async () => {
    const full = await admissionFor(await readyLead(smallBatch)); // the small batch is already full
    await expect(confirm(full)).rejects.toMatchObject({ code: 'BATCH_FULL' });
    await put('bm1', `/admission-settings?brandId=${a.brands.B1}`, {
      numberFormat: 'ADM/{YY}/{SEQ:4}',
      requireApprovalToConfirm: true,
    });
    const strict = await admissionFor(await readyLead(bigBatch));
    await expect(confirm(strict)).rejects.toMatchObject({ code: 'NOT_APPROVED' });
    await completeDocs(strict);
    await post('ao1', `/admissions/${strict}/approve`);
    expect((await confirm(strict)).admissionNumber).toBe('ADM/26/0003');
    expect(
      (
        await put('e1', `/admission-settings?brandId=${a.brands.B1}`, {
          numberFormat: 'X{SEQ}',
          requireApprovalToConfirm: false,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await put('bm1', `/admission-settings?brandId=${a.brands.B1}`, {
          numberFormat: 'NO-SEQ',
          requireApprovalToConfirm: false,
        })
      ).status,
    ).toBe(400);
  });

  it('documents are downloaded only through short-lived signed links by document.view holders, and audited', async () => {
    const adm = await admissionFor(await readyLead(bigBatch));
    await upload('e1', adm, 'QUALIFICATION', PDF, 'marks.pdf');
    const view = await get('ao1', `/admissions/${adm}`);
    const fileId = view.body.documents.find(
      (d: { type: { code: string } }) => d.type.code === 'QUALIFICATION',
    ).files[0].id;
    expect((await get('e1', `/admissions/${adm}`)).body.documents[2].files).toEqual([]); // sales see status, not files
    expect((await post('e1', `/document-files/${fileId}/link`)).status).toBe(403);
    const link = await post('ao1', `/document-files/${fileId}/link`);
    expect(link.status).toBe(201);
    const dl = await ctx
      .http()
      .get(link.body.url)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(dl.status).toBe(200);
    expect(dl.headers['content-disposition']).toBe('attachment; filename="marks.pdf"');
    expect(dl.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.compare(dl.body as Buffer, PDF)).toBe(0);
    expect(
      await ctx.owner.auditLog.count({
        where: { action: 'document.downloaded', entityId: fileId, actorUserId: id.ao1 },
      }),
    ).toBe(1);
    const tampered = link.body.url.replace(
      /token=([^.]+)\./,
      (_m: string, b: string) => `token=${b}x.`,
    );
    expect((await ctx.http().get(tampered)).status).toBe(410);
    ctx.clock.advance(6 * 60_000);
    expect((await ctx.http().get(link.body.url)).status).toBe(410);
  });

  it('student profile edits log field names only; out-of-scope admissions are 404; history is append-only', async () => {
    const adm = await admissionFor(await readyLead(bigBatch));
    const r = await patch('e1', `/admissions/${adm}/student`, {
      dateOfBirth: '2004-05-17',
      guardianName: 'R. Kumar',
      idType: 'Aadhaar',
      idNumber: '123412341234',
    });
    expect(r.status).toBe(200);
    expect(r.body.student).toMatchObject({ guardianName: 'R. Kumar', idNumber: '123412341234' });
    const log = await ctx.owner.auditLog.findFirstOrThrow({
      where: { action: 'student.updated', entityId: r.body.studentId },
    });
    expect(JSON.stringify(log.after)).not.toContain('123412341234');
    expect((await get('e2', `/admissions/${adm}`)).status).toBe(404);
    expect((await get('e1', '/admissions')).status).toBe(403);
    expect((await get('ao1', '/admissions?status=CONFIRMED')).body.length).toBeGreaterThan(0);
    await expect(
      ctx.owner.$executeRawUnsafe(
        `UPDATE admission_status_history SET reason = 'x' WHERE admission_id = '${adm}'`,
      ),
    ).rejects.toThrow();
  });
});
