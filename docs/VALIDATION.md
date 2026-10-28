# Validation ? 28 October 2026

Both repositories were checked locally. No production database, hosting settings or deployment was changed.

- API production build with Swagger compiler plugin: passed.
- API unit tests: 14 passed.
- PostgreSQL integration/smoke tests: 15 passed. Includes concurrent bank updates, overpayment prevention, concurrent first stock receipts, idempotency, cash and credit refunds, excess return prevention, lot transfers/returns, location isolation, refresh reuse and audit immutability.
- Fresh empty database migrations: passed on an isolated PostgreSQL 17 cluster, port 55439. Existing local business data was not used.
- Frontend production build and TypeScript: passed.
- Browser tests: 3 passed using installed Chrome, with a deterministic upstream fixture. Verified HttpOnly sessions, no localStorage credentials, row selection/export, confirmed bulk updates and partial failure reporting, CSRF rejection, mobile overflow and WCAG 2 A/AA + 2.1 AA automated checks on the customer workspace.
- Desktop and mobile screenshots were inspected. Other screens inherit the shared shell/table design; this is not a visual or accessibility certification of every page.
- Production dependency audit: zero reported vulnerabilities in both apps at validation time. Development dependencies retain low-severity advisories; automatic breaking downgrades were not applied.
- Backend lint: no errors. Frontend lint: no errors; existing React Compiler migration diagnostics are warnings because React Compiler is not enabled.
- Backup/restore drill: isolated database dump and upload archive checksums verified; restored to a separate inventory_restore_* database. Bank balances, stock movement sums, customer/supplier credit balances and reservations reconciled with zero mismatches. Restored API readiness and login passed.
- Local read-load smoke against the restored database: 50 inventory list requests at concurrency 5, zero failures; p50 54.6 ms, p95 169.4 ms, p99 197.1 ms. This small dataset/local-machine result does not establish production capacity.

Production acceptance still requires host configuration, SSH environment secrets, off-site encrypted backup storage/scheduling, alert delivery, a real staging end-to-end exercise, representative load testing and review of business approval/commission/refund policies. Historical stock/financial discrepancies and old returns cannot be repaired automatically from information that was never recorded.
