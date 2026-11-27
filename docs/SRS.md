**ACADEMIC COURSE SALES CRM**

**Software Requirements Specification (SRS)**

Claude-assisted, step-by-step development blueprint\
Version 1.0 \| 27 November 2026\
Business basis: supplied "Academic Course Sales CRM -- Complete Workflow
& Reporting" diagram

# Document Control

  -----------------------------------------------------------------------
  **Field**                           **Value**
  ----------------------------------- -----------------------------------
  Product name                        Academic Course Sales CRM

  Document type                       Software Requirements Specification
                                      and Claude implementation playbook

  Version                             1.0

  Status                              Baseline for stakeholder review;
                                      unresolved policy choices are
                                      marked TBD/configurable

  Primary business objective          Manage enquiry-to-admission
                                      lifecycle across multiple education
                                      brands, teams and channels

  Initial operating scale             40+ sales executives; architecture
                                      should scale beyond the initial
                                      team

  Source baseline                     User-provided workflow diagram in
                                      this conversation
  -----------------------------------------------------------------------

# How to use this document

Use this SRS as the single source of truth for Claude-assisted
development. Do not ask Claude to build the whole product in one prompt.
First ask it to inspect and plan; then implement one phase at a time,
run tests, review the result, and only then proceed.

-   If using Claude Code, open the project folder and start in Plan mode
    for architecture and multi-file work.

-   Keep the approved SRS, architecture decisions, API contract,
    database schema and test plan in the repository.

-   Maintain a concise CLAUDE.md with project conventions, commands,
    architecture rules and non-negotiable constraints.

-   Use Git commits or branches at every accepted milestone. Never allow
    an AI-generated migration or destructive command to run against
    production without review.

Claude Code supports Plan mode, project instructions through CLAUDE.md,
and iterative explore-plan-code-test workflows. Refer to the official
guidance listed in the references section.

# 1. Introduction

## 1.1 Purpose

This SRS defines the functional, technical, data, integration, security,
reporting and acceptance requirements for a multi-brand Academic Course
Sales CRM. It is intended for product owners, analysts, designers,
developers, QA engineers, administrators and Claude Code.

## 1.2 Product vision

Provide one operational platform that captures enquiries from marketing
channels, validates and classifies them, assigns them to suitable sales
staff, enforces response and follow-up discipline, progresses qualified
prospects through counselling and admission, recovers lost leads, and
provides auditable management intelligence.

## 1.3 Business outcomes

-   No valid lead should exist without an accountable owner or an
    explicitly defined unassigned/exception queue.

-   Every open lead must have a next action or a documented reason for
    being on hold.

-   First-response and follow-up SLA performance must be measurable and
    auditable.

-   Lead reassignment must preserve full ownership and activity history.

-   Marketing source and campaign attribution must survive reassignment,
    recovery and admission.

-   Admission and payment status must be supported by verifiable records
    rather than editable labels alone.

-   Management must compare brands, courses, campaigns, teams and
    executives using consistent definitions.

## 1.4 Scope

  -----------------------------------------------------------------------
  **In scope**                        **Out of scope unless separately
                                      approved**
  ----------------------------------- -----------------------------------
  Multi-brand and branch              Full learning management system
  configuration                       delivery

  Lead capture, imports, validation   Course content authoring and online
  and deduplication                   examinations

  Allocation, tasks, SLA, escalation  Payroll and statutory HR processing
  and reassignment                    

  Calls, WhatsApp, email and          Replacement of a full
  appointment activity records        accounting/ERP system

  Pipeline, counselling, lost-lead    Native iOS/Android apps in initial
  recovery                            release; responsive web first

  Course, batch, student, admission   Automated eligibility decisions
  and payment tracking                without human review

  Targets, incentives, dashboards,    Unapproved scraping or collection
  audit and integrations              from restricted platforms
  -----------------------------------------------------------------------

## 1.5 Definitions

  -----------------------------------------------------------------------
  **Term**                            **Definition**
  ----------------------------------- -----------------------------------
  Lead                                A prospective student enquiry
                                      record.

  Enquiry                             A specific interest expressed by a
                                      lead in a course, brand or intake.
                                      One person may have multiple
                                      enquiries.

  Contact attempt                     An outbound call/message/email
                                      attempt; not necessarily a
                                      successful conversation.

  Connected contact                   A two-way interaction with the
                                      prospect.

  SLA                                 A configured service-level deadline
                                      for a response or task.

  Reassignment                        Transfer of lead responsibility to
                                      another eligible user/team while
                                      retaining history.

  Recovery                            A controlled re-engagement workflow
                                      for a lead previously marked
                                      lost/not interested.

  Admission confirmed                 A state reached only when
                                      configured admission conditions are
                                      satisfied and verified.

  CPA                                 Acquisition cost divided by
                                      attributable confirmed admissions,
                                      using a documented attribution
                                      rule.
  -----------------------------------------------------------------------

# 2. Stakeholders, roles and permissions

  -----------------------------------------------------------------------
  **Role**                **Core                  **Typical access
                          responsibilities**      boundary**
  ----------------------- ----------------------- -----------------------
  Super Admin             Global configuration,   All authorized
                          tenant/organization     organizations
                          settings, security and  
                          integrations            

  Organization Admin      Manage brands,          Organization-wide
                          branches, users and     
                          policies                

  Brand Manager           Brand courses, teams,   Assigned brands
                          allocation and reports  

  Sales Manager           Team performance,       Assigned teams/brands
                          escalations, overrides  
                          and reassignment        

  Team Leader             Daily task monitoring   Assigned team
                          and team-level lead     
                          handling                

  Sales Executive         Work assigned leads,    Owned/assigned leads
                          log interactions and    
                          follow-ups              

  Counsellor              Counselling,            Assigned counselling
                          eligibility notes and   cases
                          course guidance         

  Admission Officer       Document verification,  Admission cases
                          admission workflow and  
                          batch handover          

  Accounts Officer        Payment verification,   Financial records as
                          refunds and outstanding permitted
                          balances                

  Marketing Manager       Campaign/source setup   Marketing data and
                          and ROI reports         permitted lead details

  Management Viewer       Read-only consolidated  Approved dashboards and
                          KPIs                    reports
  -----------------------------------------------------------------------

Authorization must be role-based and scope-based. A user must have both
a permission and an applicable organization/brand/team scope. Do not
rely only on hiding buttons in the frontend; enforce access in backend
APIs and database queries.

## 2.1 Permission requirements

-   Create, view, edit, assign, reassign, export, merge, archive and
    delete permissions must be separate actions.

-   Financial fields, student documents, personal contact data and
    integration secrets require additional restricted permissions.

-   Sales executives may not permanently delete leads or erase activity
    history.

-   Manual assignment overrides must require a reason and be audited.

-   Cross-brand access must be denied unless explicitly granted.

-   Bulk export must be permission-controlled, logged and optionally
    limited by row count.

# 3. Core business entities and lifecycle

## 3.1 Person, lead and enquiry separation

Recommended model: keep a person/contact identity separate from each
enquiry. A person may enquire about more than one course, brand or
intake. A lead represents the sales work record for a particular enquiry
or enquiry grouping. This avoids losing history when the same person
returns for a different course.

## 3.2 Lead lifecycle

  -----------------------------------------------------------------------
  **Stage**               **Entry criteria**      **Required actions /
                                                  exit conditions**
  ----------------------- ----------------------- -----------------------
  New Enquiry             Valid enquiry captured  Validate, deduplicate,
                          or manually entered     classify and allocate

  Contacted               At least one contact    Record outcome and next
                          attempt logged;         action
                          distinguish connected   
                          from attempted          

  Qualified               Eligibility and         Record qualification,
                          requirements assessed   course fit and timeline

  Interested              Prospect expresses      Record interest level
                          interest                and counselling
                                                  requirement

  Counselling Completed   Counselling session     Record counsellor,
                          completed and logged    date, outcome and notes

  Course Selected         Specific course/intake  Confirm course, batch
                          selected                preference and fee
                                                  quotation

  Payment Pending         Payment obligation      Track amount due, due
                          created                 date, transaction and
                                                  reminders

  Admission Confirmed     Admission checklist and Generate admission ID
                          configured              and initiate student
                          payment/approval        handover
                          conditions met          

  Lost / Not Interested   Authorized user selects Start recovery or close
                          a loss reason           according to policy

  On Hold                 Approved reason and     Pause or adjust SLA
                          review date exist       according to policy
  -----------------------------------------------------------------------

The diagram shows eight primary sales pipeline stages and a separate
lost/recovery path. The additional On Hold state is a recommended
control state, not an explicit stage in the diagram.

# 4. Functional requirements

## FR-001 Organization and multi-brand management

-   Create and configure organization, brands, branches, regions and
    business hours.

-   Each brand has its own courses, campaigns, sales teams, targets,
    pipeline settings and reporting filters.

-   Support consolidated organization-level reporting without exposing
    restricted brand records.

-   Allow brand-specific logos, colors, email templates, WhatsApp
    templates and contact details.

-   Prevent accidental cross-brand assignment unless an explicit
    cross-brand rule permits it.

## FR-002 User, team and access management

-   Create, invite, activate, deactivate and suspend users.

-   Assign one or more roles and scope users to organization, brand,
    branch and team.

-   Maintain reporting manager and team hierarchy.

-   Track availability, working schedule, leave/unavailable status and
    maximum active-lead capacity.

-   Support secure password reset, MFA-ready architecture, session
    revocation and login audit.

## FR-003 Lead source and campaign management

-   Support Meta Ads, Google Ads, website/landing page forms, WhatsApp,
    calls, referrals, events, imports and manual entry.

-   Store immutable original source, medium, campaign, ad/adset where
    available, landing page, UTM values and external source IDs.

-   Allow source mapping rules and custom source categories.

-   Store consent status, consent timestamp, collection method and
    opt-out status where applicable.

-   Never claim a lead source that cannot be evidenced by captured
    metadata.

## FR-004 Lead capture and import

-   Expose authenticated APIs/webhooks for approved lead sources.

-   Provide CSV/XLSX import with field mapping, preview, validation,
    error report and duplicate policy.

-   Capture source payload metadata and integration receipt time.

-   Validate required fields, phone format/country code, email format
    and brand/course mapping.

-   Make ingestion idempotent using provider event IDs or a stable
    deduplication key.

-   Route invalid records to an exception queue; do not silently discard
    them.

## FR-005 Duplicate detection and merge

-   Check normalized phone, email and configured identity fields.

-   Use exact-match rules by default; fuzzy matching may suggest
    possible duplicates but must not auto-merge uncertain matches.

-   Support existing-person/new-enquiry, same-enquiry duplicate,
    returning lead and cross-channel duplicate classifications.

-   Merge only with authorized permission and a preview of
    fields/history to be retained.

-   Preserve original lead IDs, source attribution, activities,
    assignment history and audit record after merge.

-   Allow a lead to have multiple course enquiries without treating them
    as duplicates.

## FR-006 Lead classification and scoring

-   Assign brand, course, location, language, qualification, intake and
    campaign tags.

-   Support configurable High/Medium/Low rules and numeric score.

-   Show score factors and rule/model version for explainability.

-   AI score is advisory; users can override with reason and audit
    trail.

-   Do not infer protected or sensitive personal attributes for lead
    scoring.

## FR-007 Intelligent lead allocation

-   Support rule-based, round-robin, capacity-based,
    brand/course/region/language-based and optional performance-weighted
    allocation.

-   Check user active status, working hours, availability, skill tags,
    brand scope and maximum active workload.

-   Use deterministic tie-breaking and persist the allocation decision
    and rule version.

-   If no eligible executive exists, place lead in a monitored
    unassigned queue and alert the responsible manager.

-   Allow authorized manual assignment and reassignment with mandatory
    reason.

-   Notify new owner and previous owner where appropriate.

-   Preserve assignment history; never overwrite prior assignment
    records.

-   Prevent repeated reassignment loops and define maximum
    attempts/escalation.

## FR-008 Tasks and follow-up control

-   Create a first-call task automatically for every allocated lead.

-   Support task types: first call, call back, WhatsApp, email,
    counselling, document collection, payment follow-up, admission
    confirmation and custom types.

-   Each task has owner, due date/time, priority, status, lead, channel,
    outcome and notes.

-   Every open lead must have a next action or an approved
    hold/exception reason.

-   Support task completion, rescheduling, cancellation with reason and
    overdue status.

-   Prevent a task from being marked complete without required outcome
    fields.

## FR-009 SLA, reminders and escalation

-   Configure first-response target; baseline diagram example is 15
    minutes.

-   Support reminder/escalation checkpoints; baseline diagram shows 5,
    15, 30 and 60 minutes.

-   Make all SLA intervals configurable by brand, source, priority,
    business hours and calendar.

-   Define whether SLA uses calendar time or working time; support
    holidays and time zones.

-   Distinguish no activity, no call attempt, call attempt/no answer,
    connected contact and completed follow-up.

-   Use background jobs/queues, not browser timers.

-   Make jobs idempotent and safe to retry; record every trigger,
    notification, failure and resolution.

-   Stop or recalculate SLA when lead is converted, closed, put on
    approved hold or manually overridden.

-   Escalate missed first response to team leader and repeated
    inactivity to manager/priority queue.

## FR-010 Sales engagement and activity history

-   Provide click-to-call integration point and manual call logging.

-   Record call direction, start/end time, duration where available,
    outcome and provider reference.

-   Integrate WhatsApp only through an approved official provider/API;
    support approved templates, delivery status and opt-out.

-   Support email sending/logging, templates, attachments and delivery
    status where available.

-   Schedule counselling appointments with date, time, counsellor, mode
    and outcome.

-   Store a chronological, append-only interaction timeline.

-   Do not store call recordings unless explicitly approved with
    consent, retention and access rules.

## FR-011 Sales pipeline and counselling

-   Provide configurable stage transitions with mandatory fields and
    transition permissions.

-   Show kanban and list views with filters, saved views and bulk
    actions.

-   Capture qualification, eligibility notes, student goals, preferred
    course, intake and objections.

-   Record counselling sessions, attendance, counsellor, summary,
    outcome and next action.

-   Allow alternative course/batch recommendations and quotations.

-   Prevent stage changes that bypass required data or approvals.

## FR-012 Lost lead recovery and closure

-   Require a loss reason and notes before marking a lead lost.

-   Support configurable recovery attempts, cooldowns, owners and
    scripts.

-   Allow re-engagement by a different executive and alternative
    course/batch offer.

-   Record each attempt, result and next recovery date.

-   Allow recovery conversion to reopen the sales process while
    preserving prior closed status history.

-   Support final closure after configured attempts or manager approval.

-   Respect opt-out/do-not-contact status; no recovery message may be
    sent after a valid opt-out.

## FR-013 Course and batch management

-   Maintain course catalogue, category, description, eligibility,
    duration, delivery mode, fee and active status.

-   Maintain intakes, batches, start/end dates, capacity, location,
    timetable and availability.

-   Support brand-specific course catalogues and fee rules.

-   Prevent batch allocation beyond capacity unless an authorized
    override is recorded.

-   Keep course/batch changes historically traceable for existing
    enquiries and admissions.

## FR-014 Student, document and admission management

-   Create or link a student profile when a lead reaches the configured
    admission process.

-   Generate unique admission number with configurable format.

-   Maintain admission checklist and document types, upload status,
    verifier, verification date and rejection reason.

-   Support admission statuses: draft, documents pending, under
    verification, approved, confirmed, cancelled and deferred as
    configured.

-   Define admission confirmation rules with the institution; do not
    assume payment alone is sufficient.

-   Create an auditable handover to batch/LMS systems.

## FR-015 Payments and instalments

-   Create fee quotation, discounts/approvals, payment schedule and
    instalments.

-   Integrate approved payment gateway using server-side verification
    and signed webhooks.

-   Track initiated, pending, successful, failed, partially paid,
    refunded and disputed transactions.

-   Never mark payment successful based only on a browser redirect.

-   Generate receipt references and reconcile gateway transaction IDs.

-   Restrict refunds, fee adjustments and manual payment verification to
    authorized roles.

-   Track outstanding amount, due date, reminders and collection notes.

## FR-016 Targets, incentives and commissions

-   Configure targets by organization, brand, team, executive, course
    and period.

-   Define target metrics: assigned leads, contacts, counselling,
    admissions, revenue or collections.

-   Configure incentive rules with effective dates, thresholds, caps,
    exclusions and approval workflow.

-   Calculate incentive previews and retain calculation inputs/rule
    version.

-   Do not silently recalculate approved historical payouts after rule
    changes.

## FR-017 Dashboards and reports

-   Executive dashboard: assigned, contacted, pending, overdue,
    reassigned, lost, recovered, admissions, revenue and SLA.

-   Team dashboard: workload, response compliance, conversion, ageing
    and executive comparison.

-   Management dashboard: brand/course/source/campaign performance,
    funnel, revenue, collections, CPA, ROI and recovery.

-   Support daily, weekly, monthly and custom date ranges; filters by
    brand, branch, course, campaign, team and executive.

-   Define every KPI formula, denominator, timezone, attribution rule
    and data refresh timing.

-   Support CSV/XLSX/PDF export with permission checks and export audit.

-   Provide drill-down from aggregate KPI to authorized underlying
    records.

## FR-018 Notifications

-   Support in-app notifications and configurable email/WhatsApp/SMS
    provider integrations.

-   Notify assignment, task due, overdue, SLA breach, reassignment,
    escalation, payment and admission events.

-   Allow user preferences for non-critical notifications while
    retaining mandatory operational alerts.

-   Track queued, sent, delivered, failed and retried states where
    provider supports them.

## FR-019 Audit and administration

-   Audit authentication, create/update, assignment, merge, stage
    change, export, payment, permission and configuration changes.

-   Store actor, timestamp, entity, action, before/after values where
    appropriate, reason and request/correlation ID.

-   Prevent ordinary users from editing or deleting audit records.

-   Provide configurable retention and secure administrative access.

## FR-020 API and integration management

-   Provide versioned REST APIs and documented webhooks.

-   Use per-integration credentials, rotation, least privilege and
    secret storage.

-   Provide webhook signature validation, replay protection, rate
    limiting and idempotency.

-   Expose integration health, last successful sync, failure queue and
    retry controls.

-   Support LMS integration for approved student/admission/batch
    handover.

## FR-021 AI assistance

-   Provide explainable lead-priority recommendations and
    next-best-action suggestions.

-   Use historical, lawful, relevant CRM outcomes to calibrate
    conversion predictions.

-   Display confidence, model version and factors; do not guarantee
    outcomes.

-   Require human approval for course recommendations, eligibility
    exceptions and sensitive decisions.

-   Provide AI feature toggle, audit and fallback when model/API is
    unavailable.

-   Do not send unnecessary personal data to external AI providers;
    document data minimization and retention.

# 5. Detailed SLA and reassignment rules

The supplied diagram gives illustrative checkpoints: assignment at 0
minutes, no activity reminder at 5 minutes, no first call alert at 15
minutes, no follow-up/reassignment at 30 minutes, another reassignment
at 60 minutes, then manager/priority-queue escalation. These are
baseline values, not hard-coded constants.

  -----------------------------------------------------------------------
  **Event**               **Default diagram       **Expected system
                          value**                 behavior**
  ----------------------- ----------------------- -----------------------
  Lead assigned           0 min                   Create first-call task;
                                                  start configured SLA
                                                  clock; notify owner.

  No activity             5 min                   Reminder to owner; log
                                                  reminder delivery
                                                  result.

  No first call           15 min                  Alert team leader; mark
                                                  first-response SLA at
                                                  risk/breached.

  No follow-up            30 min                  Apply reassignment rule
                                                  if still eligible;
                                                  increment attempt;
                                                  notify parties.

  Still no action         60 min                  Attempt next eligible
                                                  reassignment; prevent
                                                  assignment loop.

  Repeated failure        After configured        Escalate to sales
                          attempts                manager and priority
                                                  queue.
  -----------------------------------------------------------------------

## 5.1 SLA state machine

-   PENDING: SLA clock created and not yet resolved.

-   AT_RISK: warning threshold reached.

-   BREACHED: deadline passed without qualifying event.

-   PAUSED: approved hold or configured non-working period.

-   RESOLVED: qualifying response/task completed.

-   CANCELLED: lead closed, merged or invalidated under policy.

## 5.2 Reassignment algorithm requirements

-   Select only active users with correct brand/team/course/language
    permissions.

-   Exclude current owner, users at capacity, unavailable users and
    users in cooldown.

-   Use weighted round-robin or deterministic least-loaded selection;
    store selection reason.

-   If no eligible user exists, leave in an exception queue and
    escalate; never assign to an inactive user.

-   Apply a configurable maximum attempts and cooldown to prevent
    ping-pong.

-   Do not erase previous ownership or attribute all performance to the
    final owner.

-   Manager override requires reason and is recorded separately from
    automatic reassignment.

# 6. Data model -- recommended logical schema

The following is a logical baseline. Claude must convert it into a
reviewed ERD and normalized PostgreSQL schema, including indexes,
constraints, foreign keys, tenant/brand scoping and migration strategy.

  -----------------------------------------------------------------------
  **Domain**                          **Core tables / entities**
  ----------------------------------- -----------------------------------
  Organization                        organizations, brands, branches,
                                      business_hours, holidays

  Identity                            users, roles, permissions,
                                      user_roles, user_scopes, teams,
                                      team_members

  Academic catalogue                  course_categories, courses,
                                      course_eligibility, batches,
                                      batch_capacity

  Marketing                           lead_sources, campaigns,
                                      campaign_assets, tracking_events,
                                      consent_records

  Prospect                            persons, leads, enquiries,
                                      lead_tags, lead_scores,
                                      duplicate_candidates

  Assignment                          lead_assignments, allocation_rules,
                                      allocation_runs,
                                      reassignment_attempts

  Work management                     tasks, task_comments,
                                      task_reminders, sla_rules,
                                      sla_instances, escalation_events

  Engagement                          activities, calls, messages,
                                      emails, appointments, templates

  Pipeline                            lead_stage_history,
                                      counselling_sessions, quotations,
                                      lost_reasons

  Recovery                            recovery_cases, recovery_attempts,
                                      recovery_outcomes

  Admission                           students, admissions,
                                      admission_documents,
                                      document_verifications,
                                      batch_enrolments

  Finance                             fee_structures, invoices,
                                      payment_plans, instalments,
                                      payments, refunds, receipts

  Performance                         targets, target_assignments,
                                      incentive_rules,
                                      incentive_calculations

  Platform                            notifications,
                                      integration_accounts,
                                      webhook_events, job_runs,
                                      audit_logs, files
  -----------------------------------------------------------------------

## 6.1 Data integrity rules

-   Use UUID or another non-guessable primary key for externally exposed
    records.

-   Store timestamps in UTC and render them in configured
    user/organization timezone.

-   Normalize phone numbers with country code while preserving the
    originally submitted value.

-   Use database transactions for multi-record operations such as merge,
    admission confirmation and payment reconciliation.

-   Use unique constraints for provider event IDs and admission numbers
    within the appropriate scope.

-   Use soft-delete/archive for business records where retention policy
    requires it; never cascade-delete audit/financial evidence.

-   Keep source attribution immutable; record attribution corrections as
    audited events.

# 7. API requirements

All APIs must be versioned, authenticated, authorized server-side,
validated, rate-limited and documented in OpenAPI. Use consistent error
formats and correlation IDs.

  -----------------------------------------------------------------------
  **API group**                       **Representative endpoints
                                      (illustrative)**
  ----------------------------------- -----------------------------------
  Authentication                      POST /api/v1/auth/login; POST
                                      /auth/logout; POST /auth/refresh

  Leads                               GET/POST /api/v1/leads; GET/PATCH
                                      /leads/{id}; POST /leads/{id}/merge

  Assignments                         POST /leads/{id}/assign; POST
                                      /leads/{id}/reassign; GET
                                      /leads/{id}/assignments

  Tasks                               GET/POST /tasks; PATCH /tasks/{id};
                                      POST /tasks/{id}/complete

  Pipeline                            POST /leads/{id}/stage-transitions

  Activities                          POST /leads/{id}/activities; GET
                                      /leads/{id}/timeline

  Recovery                            POST /leads/{id}/recovery; POST
                                      /recovery/{id}/attempts

  Courses/batches                     GET/POST /courses; GET/POST
                                      /batches

  Admissions                          POST /leads/{id}/admission; POST
                                      /admissions/{id}/confirm

  Payments                            POST /admissions/{id}/payments;
                                      POST /webhooks/payments/{provider}

  Reports                             GET /reports/executive; GET
                                      /reports/funnel; GET
                                      /reports/campaign-roi

  Integrations                        POST /webhooks/{provider}; GET
                                      /integrations/health
  -----------------------------------------------------------------------

These routes are examples only. Claude must produce the final API
contract after reviewing the domain model and avoid creating duplicate
endpoints for the same operation.

# 8. Non-functional requirements

  -----------------------------------------------------------------------
  **Category**                        **Requirement / target to
                                      validate**
  ----------------------------------- -----------------------------------
  Performance                         Common list/detail actions should
                                      target p95 under 2 seconds under
                                      agreed test load; dashboard/report
                                      targets to be separately
                                      benchmarked.

  Scale                               Support initial 40+ executives and
                                      growth to hundreds; load-test lead
                                      ingestion, concurrent users and job
                                      queues.

  Availability                        Define service availability
                                      objective and maintenance windows
                                      before production.

  Security                            TLS, secure password hashing, least
                                      privilege, server-side
                                      authorization, secret
                                      vault/environment secrets, rate
                                      limiting and secure headers.

  Privacy                             Collect only necessary personal
                                      data; document purpose, consent,
                                      retention, access, correction and
                                      deletion workflows under applicable
                                      law.

  Auditability                        Critical changes and financial
                                      actions must be traceable and
                                      tamper-resistant.

  Reliability                         Background jobs idempotent,
                                      retryable and observable;
                                      dead-letter queue for exhausted
                                      failures.

  Backup                              Automated encrypted backups and
                                      tested restore procedure with
                                      agreed RPO/RTO.

  Accessibility                       Responsive UI and
                                      keyboard-accessible forms; target
                                      WCAG 2.1 AA where practical.

  Compatibility                       Current supported Chrome, Edge,
                                      Firefox and Safari; mobile
                                      responsive.

  Maintainability                     Modular architecture, linting,
                                      formatting, type checking, tests,
                                      code review and documented
                                      runbooks.

  Localization                        Configurable currency, date/time
                                      format, timezone and language-ready
                                      labels.
  -----------------------------------------------------------------------

## 8.1 Security and privacy baseline

-   Use OWASP-aligned secure development practices.

-   Encrypt traffic; encrypt sensitive data at rest where appropriate.

-   Never commit API keys, database passwords or provider tokens to Git.

-   Use signed webhooks and verify payment provider signatures
    server-side.

-   Implement session expiration, revocation and protection against
    brute-force login.

-   Restrict student document access and use expiring signed download
    links.

-   Define retention periods and deletion/anonymization rules with the
    organization's legal/compliance adviser.

-   Do not send personal/student data to AI services unless the purpose,
    provider terms and safeguards are approved.

# 9. UI and screen inventory

  -----------------------------------------------------------------------
  **Area**                            **Required screens**
  ----------------------------------- -----------------------------------
  Authentication                      Login, forgot password, reset
                                      password, MFA setup if enabled

  Admin                               Organization settings, brands,
                                      branches, users, roles, teams,
                                      business hours, integrations

  Lead operations                     Lead inbox, lead detail/timeline,
                                      duplicate review, import wizard,
                                      unassigned queue

  Allocation                          Allocation rules, capacity monitor,
                                      assignment history, reassignment
                                      queue

  Tasks/SLA                           My tasks, team task board, overdue
                                      queue, SLA dashboard, escalation
                                      queue

  Sales workspace                     Pipeline board, lead list,
                                      counselling calendar,
                                      call/WhatsApp/email composer

  Recovery                            Lost leads queue, recovery
                                      campaign/attempts, recovery
                                      outcomes

  Academic operations                 Courses, batches, student profile,
                                      documents, admission checklist

  Finance                             Fee plans, payment ledger,
                                      instalments, refunds, receipts,
                                      reconciliation

  Performance                         Executive dashboard, team
                                      dashboard, targets, incentive
                                      preview

  Management                          Brand/course funnel, campaign ROI,
                                      CPA, revenue, collection and audit
                                      reports
  -----------------------------------------------------------------------

## 9.1 Lead detail page -- minimum layout

-   Header: lead/person name, Lead ID, brand, course, stage, priority
    and owner.

-   Contact: normalized phone, email, preferred language, location and
    consent/opt-out status.

-   Attribution: original source, campaign, ad, landing page and UTM
    metadata.

-   Sales qualification: education/eligibility, course interest, intake,
    budget/fee readiness and timeline.

-   Next action: task type, owner, due date/time and SLA status.

-   Timeline: all calls, messages, emails, tasks, stage changes,
    assignments and notes.

-   Actions: log call, WhatsApp, email, schedule, create task, change
    stage, mark lost, request reassignment.

-   Related records: enquiries, quotations, documents, payment and
    admission, subject to permission.

# 10. Reporting definitions and formulas

  -----------------------------------------------------------------------
  **Metric**                          **Definition**
  ----------------------------------- -----------------------------------
  Assigned leads                      Count of distinct leads assigned to
                                      an executive/team during selected
                                      period; specify whether current
                                      owner or assignment events are
                                      counted.

  Contact rate                        Distinct leads with qualifying
                                      connected contact / distinct leads
                                      assigned in cohort × 100.

  First-response SLA compliance       Leads receiving qualifying first
                                      response within applicable SLA /
                                      leads subject to SLA × 100.

  Follow-up completion                Due follow-up tasks completed
                                      within due time / follow-up tasks
                                      due in period × 100.

  Overdue tasks                       Open tasks whose due timestamp has
                                      passed, excluding approved paused
                                      tasks.

  Stage conversion                    Distinct leads entering next stage
                                      / distinct leads eligible to move
                                      from prior stage × 100.

  Admission conversion                Confirmed admissions from defined
                                      lead cohort / eligible leads in
                                      same cohort × 100.

  Recovery conversion                 Recovered leads converted / leads
                                      entering recovery cohort × 100.

  Revenue collected                   Verified successful payment
                                      transactions net of refunds for
                                      selected period.

  Outstanding                         Approved amount due minus verified
                                      collections and approved
                                      credits/refunds, as defined by
                                      finance.

  CPL                                 Attributable marketing spend /
                                      valid leads attributed to that
                                      campaign.

  CPA                                 Attributable marketing spend /
                                      confirmed admissions attributed
                                      under selected attribution model.
  -----------------------------------------------------------------------

Every report must disclose date basis (created date, assignment date,
admission date or payment date), timezone, attribution model,
duplicate/merged lead treatment and cohort definition. Do not compare
numbers calculated with different denominators.

# 11. Acceptance criteria and test scenarios

  -----------------------------------------------------------------------
  **Test area**                       **Pass condition**
  ----------------------------------- -----------------------------------
  Lead ingestion                      A valid webhook event creates one
                                      lead/enquiry; replaying the same
                                      event does not create a duplicate.

  Invalid lead                        Missing required data routes the
                                      record to an exception queue with
                                      actionable validation errors.

  Duplicate candidate                 Exact duplicate is detected;
                                      uncertain fuzzy match is suggested
                                      for human review, not silently
                                      merged.

  Allocation                          Lead is assigned only to an active,
                                      eligible, in-capacity user;
                                      assignment reason and rule version
                                      are stored.

  No eligible user                    Lead remains in an unassigned
                                      exception queue and alerts the
                                      responsible manager.

  First task                          Every allocated lead receives
                                      exactly one initial task, even if
                                      the allocation job retries.

  SLA                                 Configured reminder/escalation
                                      triggers at correct business-time
                                      boundaries and is not dependent on
                                      browser activity.

  Reassignment                        Reassignment excludes
                                      previous/current ineligible owners,
                                      avoids loops and preserves
                                      assignment history.

  Connected vs attempted              No-answer call attempt does not
                                      count as connected contact or first
                                      successful response unless the
                                      business policy explicitly defines
                                      otherwise.

  Next action                         An open lead cannot be left without
                                      a next task or approved hold
                                      reason.

  Lost recovery                       Lost lead enters recovery only with
                                      reason and valid contact
                                      permission; opt-out blocks outbound
                                      recovery messages.

  Stage transition                    Pipeline transition fails when
                                      required fields or approvals are
                                      missing.

  Payment                             Payment is marked successful only
                                      after verified provider webhook/API
                                      reconciliation or authorized
                                      finance verification.

  Admission                           Admission confirmation requires
                                      configured checklist and approvals;
                                      admission ID is unique.

  Permissions                         Executive cannot view another
                                      brand's restricted lead by changing
                                      URL/API ID.

  Audit                               Assignment, merge, export, payment
                                      and permission changes create
                                      immutable audit events.

  Reporting                           KPI totals reconcile to the
                                      underlying filtered records and
                                      documented formulas.
  -----------------------------------------------------------------------

# 12. Implementation plan -- Claude step by step

The following sequence is the recommended build order. Claude must not
skip acceptance criteria or move to the next phase while critical tests
fail.

## Phase 0 -- Project discovery and scope lock

Claude task: Inspect the repository (or confirm it is empty), ask for
missing business decisions, produce a risk list, architecture options
and implementation plan. Do not code.

Exit gate: Approved scope, assumptions register, architecture decision
record and milestone plan.

## Phase 1 -- Repository and engineering foundation

Claude task: Create app structure, lint/typecheck/test scripts,
environment templates, Docker development setup, CI workflow, logging
and CLAUDE.md. No business features yet.

Exit gate: App boots locally; CI passes; secrets are not committed;
setup instructions work.

## Phase 2 -- Database and identity foundation

Claude task: Implement organization/brand/branch, users, roles,
permissions, teams and scopes. Add migrations, seed data and backend
authorization tests.

Exit gate: Cross-brand isolation and role tests pass.

## Phase 3 -- Course catalogue and configuration

Claude task: Implement courses, categories, batches, capacity, business
hours, holidays and configurable pipeline/SLA settings.

Exit gate: Admin can configure academic catalogue and operational rules.

## Phase 4 -- Lead capture and import

Claude task: Implement lead/person/enquiry model, source attribution,
APIs/webhooks, CSV import, validation and exception queue.

Exit gate: Idempotency, validation and import tests pass.

## Phase 5 -- Duplicate detection and lead workspace

Claude task: Implement exact duplicate detection, review queue, safe
merge, lead list/detail and immutable timeline foundation.

Exit gate: Duplicate and multi-enquiry scenarios pass.

## Phase 6 -- Allocation engine

Claude task: Implement rule engine, round-robin/capacity, availability,
queue fallback, notifications and assignment history.

Exit gate: Deterministic allocation and no-eligible-user tests pass.

## Phase 7 -- Tasks and SLA engine

Claude task: Implement tasks, next-action enforcement, business-time
calculations, queue workers, reminders, escalations and
retry/dead-letter handling.

Exit gate: Time-bound tests pass using a controllable test clock.

## Phase 8 -- Sales engagement

Claude task: Implement activity logging, call integration interface,
approved WhatsApp provider adapter, email and appointment scheduling.

Exit gate: Activity history and provider failure tests pass.

## Phase 9 -- Pipeline and counselling

Claude task: Implement stage rules, kanban/list views, qualification,
counselling records, course selection and quotation.

Exit gate: Invalid stage transitions are blocked; valid transitions
audited.

## Phase 10 -- Lost lead recovery

Claude task: Implement loss reasons, recovery queues, attempts,
cooldown, alternate owner and opt-out protection.

Exit gate: Recovery and closure scenarios pass.

## Phase 11 -- Student/admission and documents

Claude task: Implement student profile, document checklist,
verification, admission number, batch handover and LMS integration
contract.

Exit gate: Admission workflow and capacity checks pass.

## Phase 12 -- Payments and finance

Claude task: Implement fee plan, instalments, payment gateway adapter,
signed webhook verification, reconciliation, receipts and refund
controls.

Exit gate: Payment status cannot be forged by frontend; reconciliation
tests pass.

## Phase 13 -- Targets, incentives and reports

Claude task: Implement target configuration, incentive calculation,
dashboards, filters, exports and KPI dictionary.

Exit gate: Report values reconcile to fixtures and underlying records.

## Phase 14 -- AI assistance

Claude task: Add explainable scoring/next-action recommendations behind
feature flags, privacy controls and human override.

Exit gate: AI outage fallback, audit and bias/safety review pass.

## Phase 15 -- Hardening and production release

Claude task: Run security review, load tests, accessibility checks,
backup/restore test, monitoring, UAT, migration rehearsal and deployment
checklist.

Exit gate: Signed UAT, rollback plan, verified backups and production
readiness approval.

# 13. Claude operating instructions and master prompt

Recommended workflow: use Claude Code for repository-level
implementation. Start with Plan mode for multi-file work; use CLAUDE.md
for stable project conventions; ask for a plan naming files, migration
changes and tests before authorizing implementation. Review diffs and
test results after each phase.

## 13.1 Master project prompt -- paste first

> You are the lead software architect and senior full-stack engineering
> team for this Academic Course Sales CRM. Treat the attached/committed
> SRS as the authoritative business specification.\
> \
> NON-NEGOTIABLE RULES\
> 1. Do not build the entire CRM in one response or one unreviewed
> batch.\
> 2. Work only on the phase I explicitly authorize.\
> 3. Before coding, inspect the repository and produce a concise plan
> naming files, data changes, API changes, risks and tests.\
> 4. Do not invent business rules where the SRS marks TBD. Ask focused
> questions or propose configurable alternatives and record the
> decision.\
> 5. Never overwrite history for lead assignments, activities, stage
> transitions, payments or audit records.\
> 6. Enforce permissions in backend services, not only in the UI.\
> 7. Use database migrations; never alter production data directly.\
> 8. All background jobs must be idempotent, retryable, observable and
> safe against duplicate execution.\
> 9. Add unit, integration and end-to-end tests for every
> business-critical workflow.\
> 10. Run lint, typecheck, tests and build after each phase; report
> exact results and unresolved failures.\
> 11. Do not use fake integrations in production paths. Provide adapters
> and clearly labelled sandbox/mock implementations for local
> development.\
> 12. Keep documentation current: architecture, ERD, API contract,
> environment variables, setup, test instructions and decisions.\
> 13. Never commit secrets. Use environment variables and documented
> secret management.\
> 14. Stop at the phase boundary and wait for approval.\
> \
> First response: inspect the project and this SRS. Do not write
> application code. Return (a) repository assessment, (b)
> questions/assumptions register, (c) proposed architecture, (d) phase
> plan, (e) risks, (f) recommended first milestone.

## 13.2 Phase execution prompt -- reuse for each phase

> Implement ONLY Phase \[NUMBER -- NAME\] from the approved SRS and
> phase plan.\
> \
> First, restate the phase scope and acceptance criteria. Inspect
> relevant files and propose the smallest safe implementation plan.
> Identify schema migrations, API contracts, UI screens, background
> jobs, permissions, tests and documentation affected. Wait for approval
> before making changes.\
> \
> After approval:\
> - Implement the phase completely within its approved scope.\
> - Add migrations and seed/test fixtures where required.\
> - Add tests for normal, boundary, unauthorized, duplicate/retry and
> failure cases.\
> - Run formatter, lint, typecheck, relevant tests and production
> build.\
> - Fix failures caused by this change.\
> - Update docs and CLAUDE.md only with stable project rules.\
> - Provide a completion report: files changed, migrations, APIs, tests
> and exact pass/fail results, known limitations, security
> considerations and manual verification steps.\
> Do not start the next phase.

## 13.3 Debugging prompt

> Investigate this defect without guessing. Reproduce it, identify the
> root cause, inspect related tests and data flow, then propose a
> minimal fix. Do not weaken validation, authorization or tests to make
> the failure disappear. Add a regression test. Run the relevant test
> suite, lint, typecheck and build. Report root cause, changed files,
> test evidence and any remaining risk.

## 13.4 Code review prompt

> Review the current changes against the SRS. Do not edit files yet.
> Look for missing requirements, security/authorization gaps, data
> leakage across brands, race conditions, duplicate job execution,
> timezone/SLA defects, data integrity problems, payment verification
> weaknesses, audit gaps, performance problems and inadequate tests.
> Rank findings as Critical/High/Medium/Low and cite file/line
> references. Then propose a remediation plan.

## 13.5 Release readiness prompt

> Perform a production-readiness review against the SRS. Do not deploy.
> Verify migrations, secrets, authorization, tenant/brand isolation,
> webhook signatures, background job retries, dead-letter handling,
> observability, backup/restore, rate limits, audit retention, load
> tests, accessibility, error handling, rollback plan and UAT evidence.
> Produce a go/no-go checklist with evidence and unresolved blockers.

# 14. Decisions required from the business owner before production

  -----------------------------------------------------------------------
  **Decision**            **Recommended starting  **Must be confirmed
                          point**                 by**
  ----------------------- ----------------------- -----------------------
  Organization model      Single organization     Business owner /
                          with multiple brands;   architect
                          design tenant boundary  
                          for future expansion    

  Brand access            Explicit brand scope    Business owner
                          per user                

  SLA calendar            Configurable per brand; Sales management
                          define working hours,   
                          holidays and time zone  

  First response          A logged human call     Sales management
  definition              attempt or successful   
                          two-way contact? Define 
                          separately              

  Reassignment limit      Configurable maximum;   Sales management
                          escalate instead of     
                          infinite reassignment   

  Lead duplicate key      Normalized phone as     Business owner
                          primary exact match     
                          plus email; human       
                          review for fuzzy        
                          matches                 

  Multiple course         One person can have     Academic operations
  enquiries               multiple enquiries      

  Lost recovery           Recovery attempts,      Sales management /
                          cooldown, expiry and    compliance
                          opt-out rules           

  Admission confirmation  Checklist, approval and Academic operations /
                          payment conditions      finance

  Payment gateway         Select provider(s),     Finance
                          currencies, refund and  
                          reconciliation policy   

  WhatsApp/calling        Select official         Business owner
                          providers and account   
                          ownership               

  LMS integration         Define                  Academic operations /
                          student/course/batch    IT
                          data contract           

  Data retention          Set retention by record Compliance adviser
                          type and legal          
                          requirements            

  Hosting and recovery    Choose cloud, region,   Technical owner
                          RPO/RTO and backup      
                          retention               

  Languages and           Choose launch           Business owner
  currencies              languages, timezone and 
                          currencies              
  -----------------------------------------------------------------------

# 15. Deliverables expected from Claude

-   Working source code in a version-controlled repository.

-   Architecture overview and architecture decision records.

-   ER diagram and PostgreSQL migrations.

-   OpenAPI/Swagger API specification.

-   Responsive web interface for each role.

-   Lead capture connectors and import templates.

-   Allocation, SLA, task and recovery background workers.

-   Integration adapters and sandbox test configurations.

-   Automated unit, integration and end-to-end tests.

-   KPI dictionary and report definitions.

-   Security and permission matrix.

-   Environment setup and deployment documentation.

-   Backup, restore, monitoring and incident runbooks.

-   UAT test cases and production go-live checklist.

# 16. Official Claude development references

Use these official resources for Claude Code workflow and project
guidance. Product interfaces and commands may change; confirm the
current instructions in the installed Claude Code version.

-   Claude Code -- Your first day:
    https://support.claude.com/en/articles/14552382-your-first-day-in-claude-code

-   Claude Code -- Cheatsheet:
    https://support.claude.com/en/articles/14553413-claude-code-cheatsheet

-   Anthropic -- Claude Code best practices:
    https://www.anthropic.com/research/claude-code-best-practices

-   Claude Code -- Power user tips:
    https://support.claude.com/en/articles/14554000-claude-code-power-user-tips

The recommended approach in these materials is to understand the
repository, plan before multi-file changes, use project instructions
such as CLAUDE.md, and verify changes with tests and review.

# Appendix A -- Suggested project folder structure

academic-sales-crm/\
├── apps/\
│ ├── web/ \# Next.js user interface\
│ └── api/ \# NestJS API\
├── packages/\
│ ├── database/ \# Prisma schema and migrations\
│ ├── contracts/ \# Shared API/types\
│ ├── ui/ \# Shared UI components\
│ └── config/ \# Shared configuration\
├── workers/\
│ ├── sla-worker/\
│ ├── allocation-worker/\
│ └── notification-worker/\
├── docs/\
│ ├── SRS.md\
│ ├── architecture.md\
│ ├── ERD.md\
│ ├── API.md\
│ ├── KPI-DICTIONARY.md\
│ ├── decisions/\
│ └── runbooks/\
├── tests/\
│ ├── integration/\
│ └── e2e/\
├── infra/\
│ ├── docker/\
│ └── deployment/\
├── .env.example\
├── CLAUDE.md\
└── README.md

# Appendix B -- Initial user acceptance test checklist

-   An enquiry from each enabled source is captured with original source
    metadata.

-   A replayed webhook does not create a second enquiry.

-   A returning person can create a new course enquiry without losing
    the earlier record.

-   A lead is assigned to an eligible executive based on the configured
    rules.

-   An unavailable or over-capacity executive is not selected.

-   Every assigned lead gets one first-call task.

-   5/15/30/60-minute SLA rules behave correctly under working-hour and
    holiday settings.

-   A reassignment preserves old owner, new owner, reason, timestamp and
    attempt number.

-   A lead cannot remain open without a next task or approved hold
    reason.

-   An opt-out prevents prohibited outbound recovery messages.

-   Course/batch capacity and admission rules are enforced.

-   A frontend payment success screen cannot mark a transaction as paid
    without server verification.

-   Brand-scoped users cannot retrieve another brand's restricted data.

-   Management report totals reconcile with underlying records.

-   Backup restore and deployment rollback are tested before go-live.
