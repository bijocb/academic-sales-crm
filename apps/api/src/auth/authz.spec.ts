import { Authz, Grant } from './authz';

const g = (scopeType: Grant['scopeType'], perms: string[], ids: Partial<Grant> = {}): Grant => ({
  scopeType,
  brandId: null,
  branchId: null,
  teamId: null,
  permissions: new Set(perms),
  ...ids,
});

describe('Authz', () => {
  const orgAdmin = new Authz([g('ORGANIZATION', ['brand.manage', 'role.assign', 'user.manage'])]);
  const brandMgr = new Authz([
    g('BRAND', ['brand.manage', 'role.assign', 'user.manage', 'lead.read'], { brandId: 'b1' }),
  ]);
  const branchMgr = new Authz([g('BRANCH', ['team.manage'], { brandId: 'b1', branchId: 'br1' })]);
  const teamLead = new Authz([
    g('TEAM', ['team.read', 'lead.read'], { brandId: 'b1', branchId: 'br1', teamId: 't1' }),
  ]);

  it('organization grants cover everything', () => {
    expect(orgAdmin.can('brand.manage')).toBe(true);
    expect(orgAdmin.can('brand.manage', { brandId: 'b9' })).toBe(true);
  });

  it('brand grants cover only their brand, never the organization level', () => {
    expect(brandMgr.can('brand.manage', { brandId: 'b1' })).toBe(true);
    expect(brandMgr.can('brand.manage', { brandId: 'b2' })).toBe(false);
    expect(brandMgr.can('brand.manage')).toBe(false);
    expect(brandMgr.can('brand.manage', { brandId: 'b1', branchId: 'br1', teamId: 't1' })).toBe(
      true,
    );
  });

  it('branch grants cover teams in the branch but not the brand', () => {
    expect(branchMgr.can('team.manage', { brandId: 'b1', branchId: 'br1', teamId: 't1' })).toBe(
      true,
    );
    expect(branchMgr.can('team.manage', { brandId: 'b1' })).toBe(false);
    expect(branchMgr.can('team.manage', { brandId: 'b1', branchId: 'br2' })).toBe(false);
  });

  it('team grants cover only that team', () => {
    expect(teamLead.can('team.read', { brandId: 'b1', branchId: 'br1', teamId: 't1' })).toBe(true);
    expect(teamLead.can('team.read', { brandId: 'b1', branchId: 'br1', teamId: 't2' })).toBe(false);
  });

  it('permission must match as well as scope', () => {
    expect(teamLead.can('team.manage', { teamId: 't1' })).toBe(false);
    expect(Authz.empty().has('brand.read')).toBe(false);
  });

  it('scope() returns filter sets', () => {
    expect(brandMgr.scope('lead.read')).toEqual({
      all: false,
      brandIds: ['b1'],
      branchIds: [],
      teamIds: [],
    });
    expect(orgAdmin.scope('brand.manage').all).toBe(true);
    expect(teamLead.visibleBrandIds('team.read')).toEqual({ all: false, brandIds: ['b1'] });
  });

  describe('canGrant (anti-escalation)', () => {
    it('allows granting held permissions within own scope', () => {
      expect(brandMgr.canGrant(['lead.read'], { brandId: 'b1' })).toBe(true);
    });
    it('rejects permissions the granter lacks', () => {
      expect(brandMgr.canGrant(['lead.read', 'refund.approve'], { brandId: 'b1' })).toBe(false);
    });
    it('rejects targets outside the granter scope', () => {
      expect(brandMgr.canGrant(['lead.read'], { brandId: 'b2' })).toBe(false);
      expect(brandMgr.canGrant(['lead.read'], {})).toBe(false);
    });
    it('requires role.assign itself', () => {
      expect(branchMgr.canGrant(['team.manage'], { brandId: 'b1', branchId: 'br1' })).toBe(false);
    });
  });
});
