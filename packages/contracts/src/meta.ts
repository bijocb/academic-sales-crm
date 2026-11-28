import { z } from 'zod';

const pageId = z
  .string()
  .trim()
  .regex(/^\d{5,30}$/, 'The Facebook page id is a number (Page → About → Page ID)');
const token = z.string().trim().min(10, 'Paste the page access token').max(1000);

/** Connects a Facebook page's Lead Ads to a brand's source (A-047). The token is write-only. */
export const MetaConnectionSchema = z.object({
  brandId: z.uuid(),
  sourceId: z.uuid(),
  pageId,
  pageName: z.string().trim().min(1).max(200),
  accessToken: token,
});
export const UpdateMetaConnectionSchema = z.object({
  status: z.enum(['ACTIVE', 'PAUSED']).optional(),
  pageName: z.string().trim().min(1).max(200).optional(),
  sourceId: z.uuid().optional(),
  accessToken: token.optional(),
});
