import { describe, expect, it, vi } from 'vitest';
import type { Services } from '../src/core/contracts';
import { normalizeDevice } from '../src/admin/devices';
import { saveResource, serialize, validate } from '../src/v2/resources';

describe('device type API', () => {
  it('returns the stored type in device reads and the database default on creation', async () => {
    const stored = { id: 1, uuid: 'new-device', device_type: 'ios' };
    const insert = vi.fn(async () => stored);
    const services = { db: { insert } } as unknown as Services;
    const data = await validate(services, 'device', {});
    expect(data).not.toHaveProperty('device_type');
    const created = await saveResource(services, 'device', data);
    expect(insert).toHaveBeenCalledWith('device', {});
    expect(await serialize(services, 'device', created)).toMatchObject({ id: 1, device_type: 'ios' });
    expect(await serialize(services, 'device', { ...stored, device_type: 'rokid' }, { fields: 'id,device_type' }))
      .toEqual({ id: 1, device_type: 'rokid' });
  });

  it('persists an explicit type and preserves it when updating other fields', async () => {
    const current = { id: 1, device_type: 'ios', tag: 'original' };
    let stored = { ...current };
    const update = vi.fn(async (_table: string, _id: number, patch: Record<string, unknown>) => (stored = { ...stored, ...patch }));
    const services = { db: { update, one: vi.fn(async () => null) } } as unknown as Services;
    const data = await validate(services, 'device', { device_type: 'rokid' }, current);
    const changed = await saveResource(services, 'device', data, current);
    expect(update).toHaveBeenCalledWith('device', 1, { device_type: 'rokid' });
    expect(changed.device_type).toBe('rokid');
    const renamed = await saveResource(services, 'device', await validate(services, 'device', { tag: 'renamed' }, changed), changed);
    expect(renamed).toMatchObject({ tag: 'renamed', device_type: 'rokid' });
    const unchanged = await saveResource(services, 'device', await validate(services, 'device', {}, renamed), renamed);
    expect(unchanged.device_type).toBe('rokid');
    expect(update).toHaveBeenCalledTimes(2);
  });

  it.each([null, '', '   ', 1, [], {}, 'x'.repeat(33)])('rejects an invalid explicit device type: %j', async device_type => {
    await expect(validate({} as Services, 'device', { device_type }))
      .rejects.toMatchObject({ status: 422, responseBody: [{ field: 'device_type', message: expect.any(String) }] });
  });

  it('accepts other platforms and the 32-character boundary without fixing the list of types', async () => {
    for (const device_type of ['ios', 'rokid', 'android', 'x'.repeat(32)]) {
      expect(await validate({} as Services, 'device', { device_type })).toEqual({ device_type });
    }
  });

  it('exposes deviceType in administrator reads', () => {
    expect(normalizeDevice({ id: 1, device_type: 'rokid' }, null)).toMatchObject({ deviceType: 'rokid' });
    expect(normalizeDevice({ id: 2, device_type: 'ios' }, null)).toMatchObject({ deviceType: 'ios' });
  });
});
