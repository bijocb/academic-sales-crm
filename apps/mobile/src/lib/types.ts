export interface LeadRow {
  id: string;
  leadNumber: string;
  stage: string;
  status: string;
  priority: { band: 'HIGH' | 'MEDIUM' | 'LOW'; score: number | null } | null;
  lastEnquiryAt: string;
  course: { id: string; name: string } | null;
  person: {
    fullName: string;
    phone: string | null;
    email: string | null;
    city: string | null;
    doNotContact: boolean;
    piiMasked: boolean;
  };
}
export interface LeadDetail extends LeadRow {
  canEdit: boolean;
  owner: { id: string; name: string } | null;
}
export interface Page<T> {
  items: T[];
  total: number;
}
export interface TimelineItem {
  id: string;
  type: string;
  at: string;
  actor: string | null;
  title: string;
  body: string | null;
}
export interface PersonalWhatsApp {
  ready: boolean;
  code?: string;
  reason?: string;
  url?: string;
  body?: string;
  recipient?: string;
}
