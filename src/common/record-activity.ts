import { DataSource } from 'typeorm';

export function actionLabel(method: string, route: string): string {
  if (method === 'INSERT') return 'Created';
  if (method === 'UPDATE') return 'Updated';
  const normalized = route.replace(/^\/api(?:\/v\d+)?/, '');
  if (
    method === 'DELETE' &&
    /^\/(inquiries|stock-transfers)\/:id$/.test(normalized)
  )
    return 'Cancelled';
  if (method === 'DELETE' && /^\/(sales|purchases)\/:id$/.test(normalized))
    return 'Voided';
  if (normalized === '/inquiries/:id/confirm') return 'Quote confirmed';
  const action =
    route
      .split('/')
      .filter(Boolean)
      .filter((p) => !p.startsWith(':'))
      .at(-1) ?? '';
  const labels: Record<string, string> = {
    receive: 'Received',
    dispatch: 'Dispatched',
    ship: 'Dispatched',
    approve: 'Approved',
    complete: 'Completed',
    cancel: 'Cancelled',
    confirm: 'Confirmed',
    'confirm-quote': 'Quote confirmed',
    accept: 'Accepted',
    decline: 'Declined',
    claim: 'Claimed',
    post: 'Posted',
    start: 'Started',
    finish: 'Completed',
    release: 'Released',
    issue: 'Materials issued',
    scrap: 'Scrapped',
    unbuild: 'Unbuilt',
    void: 'Voided',
    counts: 'Counted',
    returns: 'Returned',
    payments: 'Payment recorded',
    adjustments: 'Stock adjusted',
    adjustment: 'Balance adjusted',
    pick: 'Picked',
    putaway: 'Put away',
    revise: 'Revision created',
    'set-default': 'Set as default',
    activate: 'Activated',
    deactivate: 'Deactivated',
    import: 'Imported',
    image: 'Image updated',
    attachments:
      method === 'DELETE' ? 'Attachment removed' : 'Attachment added',
  };
  return (
    labels[action] ??
    (method === 'DELETE'
      ? 'Deleted'
      : method === 'POST' && !route.includes('/:')
        ? 'Created'
        : 'Updated')
  );
}

/** Enrich only records already authorized by the resource's own controller. */
export async function addRecordActivity(
  db: DataSource,
  result: unknown,
  path: string,
) {
  if (!result || typeof result !== 'object') return;
  const payload = result as Record<string, unknown>;
  const rows = Array.isArray(result)
    ? result
    : Array.isArray(payload.data)
      ? payload.data
      : [result];
  const records = rows.filter(
    (r): r is Record<string, unknown> & { id: string } =>
      !!r && typeof r === 'object' && typeof r.id === 'string',
  );
  if (!records.length) return;
  const resource = path
    .replace(/^\/api(?:\/v\d+)?/, '')
    .split('/')
    .filter(Boolean)[0];
  if (
    !resource ||
    ['auth', 'audit-events', 'notifications', 'dashboard', 'reports'].includes(
      resource,
    )
  )
    return;
  const events: {
    resource_id: string;
    actor_id: string;
    full_name: string | null;
    method: string;
    route: string;
    created_at: Date;
  }[] = await db.query(
    `SELECT e.*, u.full_name FROM unnest($1::text[]) AS requested(resource_id)
     CROSS JOIN LATERAL (
       SELECT a.resource_id, a.actor_id, a.method, a.route, a.created_at
       FROM audit_events a WHERE a.resource_id = requested.resource_id AND a.actor_id IS NOT NULL
         AND a.status_code >= 200 AND a.status_code < 300
         AND (regexp_replace(a.route, '^/api(/v[0-9]+)?', '') = $2
           OR regexp_replace(a.route, '^/api(/v[0-9]+)?', '') LIKE $3)
       ORDER BY a.created_at DESC, a.id DESC LIMIT 100
     ) e LEFT JOIN users u ON u.id=e.actor_id`,
    [records.map((r) => r.id), `/${resource}`, `/${resource}/%`],
  );
  for (const record of records) {
    const activity = events
      .filter((e) => e.resource_id === record.id)
      .sort(
        (a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      )
      .map((e) => ({
        action: actionLabel(e.method, e.route),
        user: { id: e.actor_id, fullName: e.full_name ?? 'Former user' },
        at: e.created_at,
      }));
    if (!Array.isArray(result) && !Array.isArray(payload.data))
      record.activity = activity;
    const latest = activity[0];
    if (latest) record.updatedBy = latest.user;
    const creator = activity.find((a) => a.action === 'Created');
    if (!record.createdBy && creator) record.createdBy = creator.user;
    record.actionUsers = Object.fromEntries(
      [...activity].reverse().map((a) => [a.action, a.user]),
    );
  }
}
