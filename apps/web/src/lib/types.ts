export interface Me {
  user: { id: string; email: string; name: string; isPlatformAdmin: boolean };
  organization: {
    id: string;
    name: string;
    slug: string;
    country: string;
    timezone: string;
    currency: string;
  } | null;
  permissions: Record<
    string,
    Array<{
      scopeType: string;
      brandId: string | null;
      branchId: string | null;
      teamId: string | null;
    }>
  >;
}
export interface Brand {
  id: string;
  name: string;
  code: string;
  country: 'IN' | 'AE';
  timezone: string;
  currency: 'INR' | 'AED';
  status: 'ACTIVE' | 'ARCHIVED';
  _count?: { branches: number; teams: number };
}
export interface Branch {
  id: string;
  brandId: string;
  name: string;
  code: string;
  city: string | null;
  country: string;
  timezone: string;
  status: string;
}
export interface Team {
  id: string;
  brandId: string;
  branchId: string | null;
  name: string;
  status: string;
  leader: { id: string; name: string; email: string } | null;
  _count?: { members: number };
  members?: Array<{
    id: string;
    user: { id: string; name: string; email: string; status: string };
  }>;
}
export interface User {
  id: string;
  email: string;
  name: string;
  phone: string | null;
  status: 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED';
  lastLoginAt: string | null;
  languages: string[];
  maxActiveLeads: number | null;
}
export interface Role {
  id: string;
  key: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  permissions: string[];
}
export interface Assignment {
  id: string;
  scopeType: 'ORGANIZATION' | 'BRAND' | 'BRANCH' | 'TEAM';
  brandId: string | null;
  branchId: string | null;
  teamId: string | null;
  grantedAt: string;
  revokedAt: string | null;
  role: { id: string; key: string; name: string };
}
export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
export interface CourseCategory {
  id: string;
  brandId: string;
  name: string;
  code: string;
  status: string;
  _count?: { courses: number };
}
export interface Course {
  id: string;
  brandId: string;
  categoryId: string | null;
  code: string;
  name: string;
  description: string | null;
  eligibility: string | null;
  deliveryMode: 'ONLINE' | 'OFFLINE' | 'HYBRID';
  durationValue: number | null;
  durationUnit: 'DAYS' | 'WEEKS' | 'MONTHS' | 'YEARS' | null;
  listFeeMinor: number | null;
  currency: 'INR' | 'AED';
  status: 'ACTIVE' | 'ARCHIVED';
  category?: { id: string; name: string } | null;
  _count?: { batches: number };
}
export interface Batch {
  id: string;
  courseId: string;
  branchId: string | null;
  code: string;
  name: string;
  startDate: string;
  endDate: string | null;
  capacity: number;
  schedule: string | null;
  status: 'PLANNED' | 'OPEN' | 'CLOSED' | 'CANCELLED';
  course?: { id: string; name: string; code: string };
  branch?: { id: string; name: string } | null;
}
export interface Shift {
  weekday: number;
  startMinute: number;
  endMinute: number;
}
export interface SlaPolicy {
  firstResponseMinutes: number;
  firstResponseBasis: 'WORKING' | 'CALENDAR';
  maxReassignAttempts: number;
  reassignCooldownMinutes: number;
  checkpoints: Array<{ action: string; afterMinutes: number; basis: 'WORKING' | 'CALENDAR' }>;
}
export interface PipelineStage {
  id: string;
  key: string;
  position: number;
  label: string;
  requiredFields: string[];
}
export interface Holiday {
  id: string;
  date: string;
  name: string;
}
export interface LeadPerson {
  id: string;
  fullName: string;
  phone: string | null;
  email: string | null;
  city: string | null;
  doNotContact: boolean;
  piiMasked: boolean;
}
export interface LeadRow {
  id: string;
  leadNumber: string;
  brandId: string;
  stage: string;
  status: string;
  enquiryCount: number;
  firstEnquiryAt: string;
  lastEnquiryAt: string;
  course: { id: string; name: string } | null;
  originalSource: { channel: string; source: string | null; utmCampaign: string | null } | null;
  person: LeadPerson;
}
export interface Enquiry {
  id: string;
  classification: string;
  channel: string;
  receivedAt: string;
  submittedName: string | null;
  submittedPhone: string | null;
  submittedEmail: string | null;
  courseText: string | null;
  message: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  landingPage: string | null;
  isPaid: boolean;
  source: { id: string; name: string } | null;
  campaign: { id: string; name: string } | null;
  course: { id: string; name: string } | null;
}
export interface LeadDetail extends Omit<LeadRow, 'originalSource'> {
  enquiries: Enquiry[];
  previousLeadId: string | null;
  mergedInto: { id: string; leadNumber: string } | null;
  mergedLeads: Array<{ id: string; leadNumber: string }>;
  openDuplicateSuggestions: number;
  canEdit: boolean;
  ownerId: string | null;
  owner: { id: string; name: string } | null;
  personId: string;
  course: { id: string; name: string; code?: string } | null;
  originalAttribution: {
    channel: string;
    source: { id: string; name: string } | null;
    campaign: { id: string; name: string } | null;
    utmSource: string | null;
    utmMedium: string | null;
    utmCampaign: string | null;
    landingPage: string | null;
    receivedAt: string;
    isPaid: boolean;
  } | null;
}
export interface TimelineItem {
  id: string;
  type: string;
  at: string;
  leadId: string;
  actor: string | null;
  title: string;
  body: string | null;
  data: Record<string, unknown> | null;
}
export interface DuplicatePerson {
  id: string;
  fullName: string;
  phone: string | null;
  email: string | null;
  city: string | null;
  createdAt: string;
  leads: Array<{
    id: string;
    leadNumber: string;
    brandId: string;
    status: string;
    stage: string;
    enquiryCount: number;
    createdAt: string;
  }>;
}
export interface DuplicateCandidateRow {
  id: string;
  score: number;
  reasons: string[];
  status: string;
  detectedAt: string;
  resolutionNote: string | null;
  personA: DuplicatePerson;
  personB: DuplicatePerson;
}
export interface LeadSource {
  id: string;
  brandId: string;
  name: string;
  channel: string;
  isPaid: boolean;
  status: string;
}
export interface Campaign {
  id: string;
  brandId: string;
  name: string;
  utmCampaign: string | null;
  externalId: string | null;
  status: string;
  source: { id: string; name: string } | null;
}
export interface IntakeKeyRow {
  id: string;
  brandId: string;
  name: string;
  keyPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  source: { name: string; channel: string };
}
export interface FieldIssue {
  field: string;
  message: string;
}
export interface IntakeExceptionRow {
  id: string;
  brandId: string;
  channel: string;
  importId: string | null;
  rowNumber: number | null;
  payload: Record<string, string>;
  errors: FieldIssue[];
  status: string;
  receivedAt: string;
}

export interface LeadAssignmentRow {
  id: string;
  attemptNo: number;
  type: string;
  overCapacity: boolean;
  reason: string | null;
  assignedAt: string;
  toUserId: string;
  toName?: string;
  fromName: string | null;
  byName: string | null;
}

export interface TaskRow {
  id: string;
  leadId: string;
  brandId: string;
  ownerId: string;
  ownerName: string | null;
  type: string;
  title: string;
  priority: string;
  status: 'OPEN' | 'COMPLETED' | 'CANCELLED';
  dueAt: string;
  isInitial: boolean;
  outcome: string | null;
  notes: string | null;
  cancelReason: string | null;
  rescheduleCount: number;
  completedAt: string | null;
  overdue: boolean;
  allowedOutcomes: string[];
  lead: { id: string; leadNumber: string; status: string; person: { fullName: string } } | null;
}

export interface SlaEventRow {
  id: string;
  type: string;
  position: number | null;
  data: Record<string, unknown> | null;
  occurredAt: string;
}

export interface LeadSla {
  id: string;
  state: 'PENDING' | 'AT_RISK' | 'BREACHED' | 'PAUSED' | 'RESOLVED' | 'CANCELLED';
  targetMinutes: number;
  basis: 'WORKING' | 'CALENDAR';
  startedAt: string;
  dueAt: string | null;
  breachedAt: string | null;
  escalatedAt: string | null;
  resolvedAt: string | null;
  resolution: string | null;
  elapsed: { calendar: number | null; working: number | null };
  events: SlaEventRow[];
}

export interface SlaWatchRow {
  id: string;
  leadId: string;
  leadNumber?: string;
  leadName?: string;
  ownerName: string | null;
  state: string;
  dueAt: string | null;
  escalatedAt: string | null;
  breachedAt: string | null;
  elapsed: { calendar: number; working: number };
}

export interface SlaOverview {
  active: Record<string, number>;
  last30Days: {
    resolved: number;
    withinTarget: number;
    connected: number;
    avgWorkingMinutes: number | null;
    avgCalendarMinutes: number | null;
  };
  priorityQueue: SlaWatchRow[];
  watchList: SlaWatchRow[];
}
