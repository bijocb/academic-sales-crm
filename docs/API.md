# API

Base path `/api/v1`. Interactive OpenAPI docs: `http://localhost:4000/api/docs` (disabled in production unless `ENABLE_API_DOCS=true`).

Authentication: httpOnly cookies set by `POST /auth/login` (browser), or `Authorization: Bearer <accessToken>` (API clients).
Cookie-authenticated writes must send header `x-crm-client: web` (CSRF protection).

Errors: `{ "error": { "code", "message", "details?", "correlationId" } }`. Out-of-scope IDs return **404**; missing permission returns **403**.

| Method & path                                                                                     | Permission                                                 | Notes                                                                       |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------- |
| `GET /health`                                                                                     | public                                                     | DB + Redis status                                                           |
| `POST /auth/login`                                                                                | public                                                     | 10/min per IP; lockout after 5 failures                                     |
| `POST /auth/refresh`                                                                              | refresh cookie                                             | rotates; reuse of an old token revokes the session family                   |
| `POST /auth/logout`, `/auth/logout-all`                                                           | signed in                                                  | immediate revocation                                                        |
| `GET /auth/me`                                                                                    | signed in                                                  | user, organization, permissions by scope                                    |
| `POST /auth/password/forgot`                                                                      | public                                                     | always 202                                                                  |
| `POST /auth/password/reset`                                                                       | public                                                     | completes reset **and** invite acceptance                                   |
| `POST /auth/password/change`                                                                      | signed in                                                  | revokes other sessions                                                      |
| `GET/POST /platform/organizations`, `POST /platform/organizations/:id/suspend\|activate`          | platform admin                                             | create seeds 10 system roles + invites first admin                          |
| `GET /organization`                                                                               | org user                                                   | `PATCH` needs `organization.manage` (org scope)                             |
| `GET /brands`, `GET /brands/:id`                                                                  | `brand.read`                                               | filtered to visible brands                                                  |
| `POST /brands`                                                                                    | `brand.manage` at org scope                                |                                                                             |
| `PATCH /brands/:id`                                                                               | `brand.manage` on the brand                                |                                                                             |
| `GET /branches?brandId=`                                                                          | `brand.read`                                               |                                                                             |
| `POST /branches`, `PATCH /branches/:id`                                                           | `branch.manage` on the brand/branch                        |                                                                             |
| `GET /teams`, `GET /teams/:id`                                                                    | `team.read`                                                |                                                                             |
| `POST /teams`, `PATCH /teams/:id`, `POST /teams/:id/members`, `DELETE /teams/:id/members/:userId` | `team.manage`                                              | membership history kept                                                     |
| `GET /users?q=&status=&page=&pageSize=`, `GET /users/:id`                                         | `user.read`                                                |                                                                             |
| `POST /users`                                                                                     | `user.manage`                                              | sends invite; non-org managers must include `assignment` inside their scope |
| `PATCH /users/:id`, `POST /users/:id/status`, `POST /users/:id/resend-invite`                     | `user.manage` over all of the user's grants                | status change requires `reason`                                             |
| `GET /users/:id/role-assignments?includeRevoked=true`                                             | `user.read`                                                |                                                                             |
| `POST /users/:id/role-assignments`                                                                | `role.assign` + every permission of the role at that scope |                                                                             |
| `POST /role-assignments/:id/revoke`                                                               | `role.assign` at that scope                                | requires `reason`; last org admin protected                                 |
| `GET /roles`, `GET /permissions`                                                                  | `role.read` or `role.assign` / signed in                   |                                                                             |
| `POST /roles`, `PATCH /roles/:id`                                                                 | `role.manage` (org scope)                                  | system roles read-only                                                      |
| `GET /audit-logs`                                                                                 | `audit.read`                                               | brand-scoped for brand-level holders                                        |
