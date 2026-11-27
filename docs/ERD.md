# Entity relationship diagram

Current as of Phase 3 (migrations `…_identity`, `…_catalog_and_settings`). Every table except `organizations` carries
`organization_id` and is protected by row-level security. Children reference parents with composite keys
`(organization_id, id)`, so a row can never point at another organization's record.

```mermaid
erDiagram
  organizations ||--o{ brands : has
  organizations ||--o{ users : employs
  organizations ||--o{ roles : defines
  brands ||--o{ branches : has
  brands ||--o{ teams : has
  branches |o--o{ teams : "optionally hosts"
  roles ||--o{ role_permissions : grants
  users ||--o{ role_assignments : holds
  roles ||--o{ role_assignments : "assigned as"
  brands |o--o{ role_assignments : "scope BRAND"
  branches |o--o{ role_assignments : "scope BRANCH"
  teams |o--o{ role_assignments : "scope TEAM"
  teams ||--o{ team_members : has
  users ||--o{ team_members : "member of"
  users |o--o{ teams : leads
  users |o--o{ users : manages
  users ||--o{ sessions : has
  users ||--o{ auth_tokens : has
  organizations ||--o{ audit_logs : records
```

| Table                       | Notes                                                                                                                                                                                                           |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `organizations`             | Tenant. `country` IN/AE, default `timezone` and `currency`. Status ACTIVE/SUSPENDED.                                                                                                                            |
| `brands`                    | Own country, time zone, currency. Code unique per organization. Archived, never deleted.                                                                                                                        |
| `branches`                  | Belong to a brand; time zone defaults from brand.                                                                                                                                                               |
| `users`                     | `organization_id` null only for platform admins (CHECK). Email lower-case, globally unique. Status INVITED → ACTIVE → SUSPENDED/DEACTIVATED. `max_active_leads`, `languages` reserved for allocation (Phase 6). |
| `roles`, `role_permissions` | 10 system roles per organization from `packages/contracts`; custom roles allowed. Permission keys validated against the catalog.                                                                                |
| `role_assignments`          | Scope ORGANIZATION / BRAND / BRANCH / TEAM (CHECK keeps columns consistent). Revoked, never deleted (`revoked_at`, `revoked_by_id`, `revoke_reason`).                                                           |
| `team_members`              | Leaving sets `left_at`; one active membership per user per team (partial unique index).                                                                                                                         |
| `sessions`                  | Refresh-token rotation families; hashed tokens only.                                                                                                                                                            |
| `auth_tokens`               | Invite (7 days) / password reset (30 minutes); hashed, single-use.                                                                                                                                              |
| `audit_logs`                | Append-only: UPDATE/DELETE/TRUNCATE blocked by trigger, and privileges revoked from `crm_app`.                                                                                                                  |

## Phase 3 tables

```mermaid
erDiagram
  brands ||--o{ course_categories : has
  brands ||--o{ courses : offers
  course_categories |o--o{ courses : groups
  courses ||--o{ batches : runs
  branches |o--o{ batches : hosts
  brands ||--o{ working_hours : "works in"
  brands ||--o{ holidays : closes
  brands ||--|| sla_policies : uses
  sla_policies ||--o{ sla_checkpoints : steps
  brands ||--o{ pipeline_stages : defines
```

| Table                             | Notes                                                                                                                                              |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `course_categories`, `courses`    | Per brand; code unique per brand; `list_fee_minor` BIGINT minor units + `currency` (= brand currency); duration value/unit both or neither (CHECK) |
| `batches`                         | Per course; optional branch (same brand); `start_date`/`end_date` DATE (end ≥ start CHECK); `capacity ≥ 0`                                         |
| `working_hours`                   | ISO weekday 1–7, minutes from local midnight, start < end (CHECK); multiple shifts per day                                                         |
| `holidays`                        | Local date per brand, unique                                                                                                                       |
| `sla_policies`, `sla_checkpoints` | One policy per brand; ordered checkpoints with action and WORKING/CALENDAR basis                                                                   |
| `pipeline_stages`                 | 8 fixed keys per brand; editable label and required fields                                                                                         |
