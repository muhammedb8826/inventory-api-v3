# Production readiness and rollout

This release changes both inventory-api-v3 and inventory-v3. Deploy the API migrations before the web release. Existing browser credentials are removed; users must sign in to create an HttpOnly session.

## Delivered controls

- Bank and credit rows are locked within transactions. Document headers serialize sale/purchase edits and voids, returns, production transitions and stocktake completion.
- Currency postings use decimal.js with 40 digits of precision and half-up rounding. Sales/purchase line totals are rounded before summation.
- Idempotency claims are committed before mutations. Same-key concurrent requests cannot both post. Payload fingerprints prevent key reuse for different requests. Successful responses and client errors are replayed.
- Browser mutations retain retry keys in sessionStorage after uncertain failures. Session cookies are HttpOnly, same-site strict and secure in production. The Next.js proxy checks the Origin for writes and never returns JWTs to browser JavaScript.
- Refresh rotation is serialized. Reuse revokes the user's sessions. Password changes increment a session version; inactive users and old session versions are rejected on every authenticated request.
- Location access fails closed. Assigned locations include child bins. Inventory and document list queries and totals are scoped; direct resource access and location changes are checked. Business-wide financial views require the explicit locations.all permission.
- Sales returns reduce unpaid customer credit first and refund the paid remainder, atomically with restocking. Returned sales cannot be financially edited or voided. Historical returns are not retroactively refunded: reconcile them before rollout.
- Stock movements retain every lot allocation. Transfers preserve lot numbers and expiry dates. Customer returns restore recorded allocations in original expiry order; the operator must verify the physical returned batch. Legacy movements cannot recover lot allocations that were never stored.
- Database audit triggers capture before/after snapshots without password/token hashes. Audit records reject updates/deletes. HTTP audit metadata records actors and request IDs. Access requires settings.read and business-wide location access.
- Metrics: /api/v1/health/metrics requires Authorization: Bearer METRICS_TOKEN. Health/live is liveness; health/ready checks PostgreSQL.
- Updated dependencies and security audit gates. Development-only advisories are reported separately; no claim of zero vulnerabilities is made.
- Shared modern page chrome, forms/surfaces, responsive scrollable tables, sorting on the current page, column visibility, compact density, selection and formula-safe CSV export.
- Confirmed bulk actions for supported records reuse server authorization and validation. Each record is a separate transaction. Successful rows are deselected; failed rows and their messages remain visible. Selection/export are explicitly current-page operations.

## Required configuration before deployment

API: NODE_ENV=production, distinct JWT_AT_SECRET and JWT_RT_SECRET (at least 32 random characters each), JWT_AT_EXPIRES_IN=15m, JWT_RT_EXPIRES_IN=7d, DB_* connection settings, DB_SYNCHRONIZE=false, DB_SEED=false, CORS_ORIGIN as an explicit allowlist if direct browser API access is needed, METRICS_TOKEN and BACKUP_DIR.

Web: API_URL points to the API /api/v1 on the server. NEXT_PUBLIC_API_URL remains the public API base for media URLs. Use HTTPS. Set both when hosts differ.

Remote import images require IMAGE_FETCH_ALLOWED_HOSTS (comma-separated trusted HTTPS image hosts). Redirects are rejected. Uploads remain public product/branding media; do not upload confidential documents there.

Before changing existing staff access, assign locations or grant locations.all to roles that intentionally require business-wide access. No-assignment no longer means unrestricted access.

## Encrypted release workflow

Legacy plain FTP workflows are disabled. Configure GitHub production environments in BOTH repositories:

- Secrets: SSH_PRIVATE_KEY, SSH_KNOWN_HOSTS (verified out of band), SSH_HOST, SSH_USER.
- Variables: DEPLOY_ROOT (absolute dedicated app directory), HEALTH_URL (public HTTPS health endpoint), API_URL for the web build.
- On the host create DEPLOY_ROOT/releases and DEPLOY_ROOT/shared; store production .env at shared/.env and move persistent uploads to shared/uploads. Configure Passenger/cPanel application root as DEPLOY_ROOT/current. Node 22, npm, PostgreSQL client tools, tar and curl must be installed.

Run CI and review its results, then dispatch SSH release at the tested commit. Releases are staged in a new directory; current is switched atomically. Failed health verification restores the previous code release. Migrations run before switching API code and must remain compatible with the preceding release; database rollback is never automatic. The first deployment needs a separately verified bootstrap because there is no prior release to restore.

## Backup and restore

npm run backup writes a custom pg_dump, uploads archive and SHA-256 manifest into a timestamped private directory. Protect backups using encrypted storage and copy them off-host; this repository does not configure your storage provider or scheduler.

Suggested initial targets to agree with the business: RPO 24 hours; RTO 4 hours. Schedule daily backups on the host, alert on failures, retain 7 daily/4 weekly/12 monthly copies according to business/privacy policy, and run a monthly restore drill.

Automated database restore check: set BACKUP_PATH and a new RESTORE_DB_NAME beginning inventory_restore_, then run npm run restore:check. It verifies checksums and creates a new database, preserving the source. Set DB_DATABASE to that restored name and run npm run reconcile for ledger checks.

Restore drill (never target the live database): verify the SHA-256 manifest; create a fresh staging database; run pg_restore --no-owner into it; restore uploads into a separate staging directory; point a staging API at the restored database with seeding and synchronization disabled; run health, sign-in, stock/ledger reconciliation and transaction smoke checks. Record elapsed time and the backup timestamp. Preserve the original backup.

## Monitoring and incident response

Configure an external monitor for API readiness and web login. Scrape metrics with the dedicated token over a private network or HTTPS. Aggregate structured logs centrally and restrict access to the audit trail.

Suggested initial service objective: 99.9% successful requests monthly. Alert on sustained 5xx >1%, readiness failure >2 minutes, backup failure, disk >85%, database connection exhaustion and pending idempotency claims older than 10 minutes. Set latency objectives from a measured load test with realistic data; this change does not establish production capacity.

For an uncertain idempotency request (status_code=0), do not delete the claim or submit a new key blindly. Correlate actor, route, timestamp and audit/ledger records. If committed, repair the stored response under a controlled maintenance procedure; if conclusively rolled back, document the reconciliation before clearing the claim. A pending claim deliberately favors avoiding duplicate financial postings over automatic retry availability.

## Verification and remaining operational evidence

Run npm run lint, npm run build, npm test -- --runInBand and migrated PostgreSQL npm run test:e2e -- --runInBand for API. Use an isolated DB: tests create business records. Web: npm run lint, npm run typecheck, npm run build and npm run test:e2e after npx playwright install chromium. Set PLAYWRIGHT_CHANNEL=chrome to use an installed Chrome locally.

The frontend browser suite uses a deterministic upstream fixture; backend database tests cover real postings. Together they are not a full production end-to-end acceptance test. Before go-live, exercise actual sales/purchase/credit/return/production flows through a staging deployment, measure representative load, verify off-site restore, configure alerts and commission/refund policy, and perform a security review using OWASP ASVS and accessibility review using WCAG 2.2.

Contract changes include return refundAmount/creditAmount/bankAccountId and report netTotal/returnedAmount. Original sales totals remain gross document totals. Returns are posted into their own accounting period. Do not treat grouped gross sales as net revenue. OpenAPI remains available at /api/docs-json; client/server contract smoke checks should run against staging before independently releasing either repository.

Specialized business extensions (serial tracking, multi-currency, UOM conversion, approval thresholds, full purchasing/receiving stages and accounting integration) require business rules and were not asserted to be missing mandatory features in the review. They remain separate product work.

## API contract generation

The backend Nest Swagger compiler plugin emits DTO metadata. After building the API, run npm run openapi:export against an isolated migrated database (seeding disabled). Copy docs/openapi.json to the frontend docs/openapi.json, then run npm run api:generate there. Commit both snapshots and lib/generated/api-schema.d.ts together. The return form uses the generated request type. Other legacy client types can be migrated incrementally; generated metadata does not prove every response shape at runtime.

Validation evidence: [VALIDATION.md](VALIDATION.md). A bounded read-only load harness is available as npm run load:smoke with API_URL and API_TOKEN set for staging.
