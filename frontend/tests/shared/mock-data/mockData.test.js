import { describe, expect, it } from 'vitest';
import { mockAnswerFor, seed, uid } from '@/shared/mock-data/mockData';
describe('mockAnswerFor', () => {
    it('returns an auth answer for authentication questions', () => {
        const answer = mockAnswerFor('How does authentication work?');
        expect(answer.abstain).toBe(false);
        if (answer.abstain)
            return;
        expect(answer.content).toMatch(/JWT/i);
        expect(answer.evidence.length).toBeGreaterThan(0);
    });
    it('returns a checkout answer for cart questions', () => {
        expect(mockAnswerFor('Explain the checkout flow').content).toMatch(/checkout/i);
    });
    it('returns a payment answer for stripe questions', () => {
        expect(mockAnswerFor('Where is payment implemented?').content).toMatch(/Stripe/i);
    });
    it('returns a changes answer for recent update questions', () => {
        expect(mockAnswerFor('What changed recently?').content).toMatch(/changed/i);
    });
    it('abstains when no topic matches', () => {
        const answer = mockAnswerFor('What is the meaning of life?');
        expect(answer.abstain).toBe(true);
        if (!answer.abstain)
            return;
        expect(answer.missing.length).toBeGreaterThan(0);
    });
});
describe('uid', () => {
    it('generates unique prefixed ids', () => {
        expect(uid('x')).not.toEqual(uid('x'));
        expect(uid('prj')).toMatch(/^prj_/);
    });
});
describe('seed', () => {
    it('includes projects, conversations, jobs, users, audit, and notifications', () => {
        expect(seed.projects.length).toBeGreaterThan(0);
        expect(seed.conversations.length).toBeGreaterThan(0);
        expect(seed.jobs.length).toBeGreaterThan(0);
        expect(seed.users.length).toBeGreaterThan(0);
        expect(seed.audit.length).toBeGreaterThan(0);
        expect(seed.notifications.length).toBeGreaterThan(0);
    });
});
