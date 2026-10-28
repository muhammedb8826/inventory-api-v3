# Monitoring setup

Load alerts.yml into your Prometheus rule_files. Scrape /api/v1/health/metrics over HTTPS using a dedicated bearer-token file containing METRICS_TOKEN. Configure your Alertmanager receiver and contact routing separately. These files do not deploy or connect a monitoring service.

Scraping metrics verifies reachability, not PostgreSQL readiness. Configure an external HTTP monitor for /api/v1/health/ready and the web login page. Also monitor host disk, database connections, daily backup completion and pending idempotency claims older than ten minutes. Configure alert delivery and test it in staging before go-live.
