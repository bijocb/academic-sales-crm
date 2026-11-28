export const CHANNEL_LABEL: Record<string, string> = {
  META_ADS: 'Meta Ads',
  GOOGLE_ADS: 'Google Ads',
  GOOGLE_SHEETS: 'Google Sheets',
  WEBSITE: 'Website',
  WHATSAPP: 'WhatsApp',
  CALL: 'Call / walk-in',
  REFERRAL: 'Referral',
  EVENT: 'Event',
  IMPORT: 'Import',
  MANUAL: 'Manual',
  OTHER: 'Other',
};

export const leadStatusTone = (s: string) =>
  (
    ({
      OPEN: 'blue',
      CONVERTED: 'green',
      LOST: 'amber',
      CLOSED_LOST: 'red',
      ON_HOLD: 'slate',
      IN_RECOVERY: 'amber',
      MERGED: 'slate',
    }) as const
  )[s as 'OPEN'] ?? 'slate';

export const fmtDateTime = (iso: string) => new Date(iso).toLocaleString();

export const REASON_LABEL: Record<string, string> = {
  SAME_EMAIL: 'Same email',
  SAME_PHONE: 'Same phone',
  PHONE_NEAR_MATCH: 'Phone differs by one digit',
  SAME_NAME: 'Same name',
  SAME_CITY: 'Same city',
  NAME_WORD_OVERLAP: 'Similar name',
};

/** Situations for one-click quick messages (template categories). */
export const CATEGORY_LABEL: Record<string, string> = {
  COURSE_DETAILS: 'Course details',
  COLLEGE_DETAILS: 'College details',
  FOLLOW_UP: 'Follow-up',
  FEE_DETAILS: 'Fee details',
  GENERAL: 'General',
};
export const MESSAGE_CHANNEL_LABEL: Record<string, string> = {
  WHATSAPP: 'WhatsApp',
  EMAIL: 'Email',
  SMS: 'SMS',
};
