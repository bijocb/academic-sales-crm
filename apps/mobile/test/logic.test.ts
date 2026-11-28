/// <reference types="node" />
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  callDuration,
  callPlan,
  callTaskFor,
  defaultFollowUp,
  followUpAt,
  groupToday,
  notificationTarget,
  relative,
  telUrl,
  type TaskRow,
} from '../src/lib/logic.ts';

const LEAD = '11111111-1111-4111-8111-111111111111';
const task = (over: Partial<TaskRow>): TaskRow => ({
  id: 't1',
  leadId: LEAD,
  type: 'FIRST_CALL',
  title: 'First call',
  priority: 'NORMAL',
  status: 'OPEN',
  dueAt: '2026-11-30T05:00:00.000Z',
  overdue: false,
  allowedOutcomes: [
    'CONNECTED',
    'NO_ANSWER',
    'BUSY',
    'SWITCHED_OFF',
    'WRONG_NUMBER',
    'CALL_BACK_REQUESTED',
  ],
  lead: null,
  ...over,
});
const now = new Date('2026-11-30T06:00:00.000Z');

describe("today's work", () => {
  it('splits overdue from due today, earliest first, urgent first on a tie', () => {
    const g = groupToday([
      task({ id: 'a', dueAt: '2026-11-30T09:00:00Z' }),
      task({ id: 'b', dueAt: '2026-11-30T04:00:00Z', overdue: true }),
      task({ id: 'c', dueAt: '2026-11-30T09:00:00Z', priority: 'URGENT' }),
      task({ id: 'd', status: 'COMPLETED' }),
    ]);
    assert.deepEqual(
      g.overdue.map((t) => t.id),
      ['b'],
    );
    assert.deepEqual(
      g.today.map((t) => t.id),
      ['c', 'a'],
    );
  });
});

describe('call and log', () => {
  it('dials only full numbers', () => {
    assert.equal(telUrl('+91 98123 45678', false), 'tel:+919812345678');
    assert.equal(telUrl('+91 98•••••678', false), null);
    assert.equal(telUrl('+919812345678', true), null);
    assert.equal(telUrl(null, false), null);
  });

  it('measures the time away in the phone app', () => {
    assert.equal(callDuration(now, new Date(now.getTime() + 95_400)), 95);
    assert.equal(callDuration(now, new Date(now.getTime() - 1000)), null);
  });

  it('completes the open call task (with the follow-up as its next task)', () => {
    const p = callPlan({
      leadId: LEAD,
      tasks: [
        task({ id: 'later', dueAt: '2026-12-01T05:00:00Z' }),
        task({ id: 'first' }),
        task({ id: 'x', type: 'EMAIL' }),
      ],
      outcome: 'NO_ANSWER',
      notes: '  ',
      startedAt: now,
      durationSec: 12,
      followUp: 'IN_2_HOURS',
      now,
    });
    assert.equal(p.kind, 'complete');
    if (p.kind !== 'complete') return;
    assert.equal(p.taskId, 'first');
    assert.deepEqual(p.body, {
      outcome: 'NO_ANSWER',
      notes: undefined,
      nextTask: { type: 'CALL_BACK', dueAt: '2026-11-30T08:00:00.000Z', priority: 'NORMAL' },
    });
  });

  it('logs a standalone call when there is no open call task', () => {
    const p = callPlan({
      leadId: LEAD,
      tasks: [task({ leadId: 'other' })],
      outcome: 'CONNECTED',
      notes: 'Wants the fee plan',
      startedAt: now,
      durationSec: 300,
      followUp: 'NONE',
      now,
    });
    assert.equal(p.kind, 'log');
    if (p.kind !== 'log') return;
    assert.deepEqual(p.body, {
      direction: 'OUTBOUND',
      startedAt: now.toISOString(),
      durationSec: 300,
      outcome: 'CONNECTED',
      notes: 'Wants the fee plan',
    });
    assert.equal(p.nextTask, null);
    assert.equal(callTaskFor([task({ status: 'COMPLETED' })], LEAD), undefined);
  });

  it('suggests a follow-up from the outcome; tomorrow is 10:00 local time', () => {
    assert.equal(defaultFollowUp('NO_ANSWER'), 'IN_2_HOURS');
    assert.equal(defaultFollowUp('CONNECTED'), 'TOMORROW');
    assert.equal(defaultFollowUp('WRONG_NUMBER'), 'NONE');
    const d = new Date(followUpAt('TOMORROW', now)!);
    assert.equal(d.getHours(), 10);
    assert.equal(d.getMinutes(), 0);
    assert.ok(d.getTime() > now.getTime());
    assert.equal(followUpAt('NONE', now), null);
  });
});

describe('notifications and formatting', () => {
  it('a tapped notification opens its lead', () => {
    assert.equal(
      notificationTarget({ type: 'LEAD_ASSIGNED', link: `/leads/${LEAD}` }),
      `/lead/${LEAD}`,
    );
    assert.equal(notificationTarget({ type: 'TASK_DUE', link: '/tasks' }), '/');
    assert.equal(notificationTarget({ type: 'X' }), null);
    assert.equal(notificationTarget(null), null);
  });

  it('relative times', () => {
    assert.equal(relative('2026-11-30T06:30:00Z', now), 'in 30 min');
    assert.equal(relative('2026-11-30T03:00:00Z', now), '3 h ago');
    assert.equal(relative('2026-12-04T06:00:00Z', now), 'in 4 d');
  });
});
