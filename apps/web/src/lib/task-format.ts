export const TASK_TYPE_LABEL: Record<string, string> = {
  FIRST_CALL: 'First call',
  CALL_BACK: 'Call back',
  WHATSAPP: 'WhatsApp',
  EMAIL: 'Email',
  COUNSELLING: 'Counselling',
  DOCUMENT_COLLECTION: 'Document collection',
  PAYMENT_FOLLOW_UP: 'Payment follow-up',
  ADMISSION_CONFIRMATION: 'Admission confirmation',
  CUSTOM: 'Other',
};

export const OUTCOME_LABEL: Record<string, string> = {
  CONNECTED: 'Connected — spoke to them',
  NO_ANSWER: 'No answer',
  BUSY: 'Busy',
  SWITCHED_OFF: 'Switched off / unreachable',
  WRONG_NUMBER: 'Wrong number',
  CALL_BACK_REQUESTED: 'Asked to call back',
  MESSAGE_SENT: 'Message sent',
  DONE: 'Done',
};

export const SLA_LABEL: Record<string, string> = {
  PENDING: 'On track',
  AT_RISK: 'At risk',
  BREACHED: 'Breached',
  PAUSED: 'Paused (on hold)',
  RESOLVED: 'First response made',
  CANCELLED: 'Stopped',
};

export const slaTone = (s: string) =>
  (
    ({
      PENDING: 'blue',
      AT_RISK: 'amber',
      BREACHED: 'red',
      PAUSED: 'slate',
      RESOLVED: 'green',
      CANCELLED: 'slate',
    }) as const
  )[s as 'PENDING'] ?? 'slate';

export const fmtMinutes = (m: number | null | undefined) => {
  if (m === null || m === undefined) return '—';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
};

/** Value for <input type="datetime-local"> in the viewer's time zone. */
export const toLocalInput = (d: Date) => {
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
};

export const inHours = (h: number) => toLocalInput(new Date(Date.now() + h * 3_600_000));

export const localInputToIso = (v: string) => new Date(v).toISOString();
