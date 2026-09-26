import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertAllRoutesDeclareAccess,
  classifyRouteAccess,
  installRouteDeclarationCollector,
  normalizeRoutePath,
} from '../../../src/modules/access/permissions.js';

describe('routeDeclarationAudit', () => {
  /** @type {import('fastify').FastifyInstance | undefined} */
  let app;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('normalizes versioned paths for the allowlist', () => {
    expect(normalizeRoutePath('/api/v1/health')).toBe('/health');
    expect(normalizeRoutePath('/auth/login')).toBe('/auth/login');
  });

  it('classifies public allowlisted paths without explicit config', () => {
    expect(classifyRouteAccess({}, '/health')).toBe('public');
    expect(classifyRouteAccess({ routeAccess: 'authenticated' }, '/auth/me')).toBe('authenticated');
    expect(classifyRouteAccess({ requiredPermissions: ['org.view'] }, '/x')).toBe('permissions');
    expect(classifyRouteAccess({ file: 'index.html' }, '/')).toBe('public');
    expect(classifyRouteAccess({}, '/secret')).toBe('undeclared');
  });

  it('fails boot when a route has neither a declaration nor an allowlist entry', async () => {
    app = Fastify();
    installRouteDeclarationCollector(app);
    app.get('/unguarded', async () => ({ ok: true }));
    await app.ready();
    expect(() => assertAllRoutesDeclareAccess(app)).toThrow(/Route declaration audit failed/);
  });

  it('passes when every route declares access', async () => {
    app = Fastify();
    installRouteDeclarationCollector(app);
    app.get('/health', { config: { routeAccess: 'public' } }, async () => ({ ok: true }));
    app.get('/secure', { config: { requiredPermissions: ['org.view'] } }, async () => ({ ok: true }));
    await app.ready();
    expect(() => assertAllRoutesDeclareAccess(app)).not.toThrow();
  });
});
