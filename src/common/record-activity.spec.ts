import { DataSource } from 'typeorm';
import { actionLabel, addRecordActivity } from './record-activity';

describe('record action attribution', () => {
  it('distinguishes receiving and workflow actions from ordinary updates', () => {
    expect(actionLabel('POST', '/api/v1/stock-transfers/:id/receive')).toBe(
      'Received',
    );
    expect(actionLabel('POST', '/production-orders/:id/issue')).toBe(
      'Materials issued',
    );
    expect(actionLabel('POST', '/inquiries')).toBe('Created');
    expect(actionLabel('PATCH', '/inquiries/:id')).toBe('Updated');
    expect(actionLabel('INSERT', 'sales')).toBe('Created');
  });
  it('only looks up authorized record IDs in the same resource and retains the recorded creator', async () => {
    const query = jest.fn().mockResolvedValue([
      {
        resource_id: 'transfer-1',
        actor_id: 'receiver',
        full_name: 'Receiver',
        method: 'POST',
        route: '/stock-transfers/:id/receive',
        created_at: new Date('2026-10-30'),
      },
      {
        resource_id: 'transfer-1',
        actor_id: 'creator',
        full_name: 'Creator',
        method: 'POST',
        route: '/stock-transfers',
        created_at: new Date('2026-10-29'),
      },
    ]);
    const row = {
      id: 'transfer-1',
      createdBy: { id: 'creator', fullName: 'Recorded creator' },
    } as Record<string, any>;
    await addRecordActivity(
      { query } as unknown as DataSource,
      { data: [row] },
      '/api/v1/stock-transfers',
    );
    expect(query.mock.calls[0][1]).toEqual([
      ['transfer-1'],
      '/stock-transfers',
      '/stock-transfers/%',
    ]);
    expect(row.createdBy.fullName).toBe('Recorded creator');
    expect(row.updatedBy.id).toBe('receiver');
    expect(row.actionUsers.Received.id).toBe('receiver');
    expect(row.activity).toBeUndefined();
    await addRecordActivity(
      { query } as unknown as DataSource,
      row,
      '/api/v1/stock-transfers/transfer-1',
    );
    expect(row.activity).toHaveLength(2);
  });
  it('does not infer a user for records without history', async () => {
    const row: Record<string, unknown> = { id: 'legacy' };
    await addRecordActivity(
      { query: jest.fn().mockResolvedValue([]) } as unknown as DataSource,
      row,
      '/api/v1/inquiries/legacy',
    );
    expect(row.updatedBy).toBeUndefined();
    expect(row.createdBy).toBeUndefined();
  });
});
