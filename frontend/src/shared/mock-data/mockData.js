/** Knowledge readiness labels used across badges and filters. */
export const KNOWLEDGE_STATES = ['Ready', 'Updating', 'Needs attention', 'Outdated', 'Partially available'];
let nextIdCounter = 0;

const ANSWERS = {
  auth: {
    content: `## How authentication works
This project uses a **JWT-based session** with refresh-token rotation, plus Google OAuth as a social provider.
### Flow
1. The user submits credentials (email + password) or initiates Google OAuth.
2. On success, the server issues an **access token** (short-lived, 15m) and a **refresh token** (httpOnly cookie, 7d).
3. A middleware validates the access token on protected routes.
4. When the access token expires, the client silently refreshes it using the refresh cookie; the refresh token is **rotated** on each use.
### Key files
- \`src/auth/login.ts\` — credential + OAuth login handlers
- \`src/auth/session.ts\` — token signing, verification, refresh rotation
- \`src/auth/rbac.ts\` — role-based access control (\`admin\`, \`user\`)
- \`src/auth/reset.ts\` — password reset via emailed OTP
> Roles are checked in \`requireRole('admin')\` middleware. Passwords are hashed with bcrypt (cost 12).`,
    evidence: [
      {
        file: 'src/auth/session.ts',
        location: 'L24–58',
        snippet:
          "export function issueTokens(user) {\n  const access = sign({ sub: user.id, role: user.role }, SECRET, { expiresIn: '15m' });\n  const refresh = randomToken();\n  storeRefresh(user.id, hash(refresh));\n  return { access, refresh };\n}",
      },
      {
        file: 'src/auth/rbac.ts',
        location: 'L11–19',
        snippet:
          'export const requireRole = (role) => (req, res, next) => {\n  if (req.user?.role !== role) return res.status(403).end();\n  next();\n};',
      },
    ],
  },
  checkout: {
    content: `## The checkout flow
Checkout moves the user from **cart → payment → confirmation** in three stages.
### Stages
1. **Cart review** — \`src/checkout/cart.ts\` renders the active cart and computes totals (subtotal, tax, shipping).
2. **Payment intent** — \`src/payments/stripe.ts\` creates a Stripe PaymentIntent for the cart total and returns the client secret.
3. **Confirmation** — on successful payment webhook, \`src/checkout/confirm.ts\` creates an \`Order\`, decrements inventory, and enqueues a receipt email.
### Notable detail
The Stripe webhook (\`src/webhooks/stripe.ts\`) is the source of truth for payment status — the client confirmation only updates the UI; the order is finalized server-side on \`payment_intent.succeeded\`.`,
    evidence: [
      {
        file: 'src/payments/stripe.ts',
        location: 'L40–67',
        snippet:
          "export async function createPaymentIntent(cart) {\n  const total = computeTotal(cart);\n  const intent = await stripe.paymentIntents.create({ amount: total, currency: 'usd' });\n  return { clientSecret: intent.client_secret };\n}",
      },
      {
        file: 'src/checkout/confirm.ts',
        location: 'L18–44',
        snippet:
          'export async function confirmOrder(userId, cart, paymentId) {\n  const order = await db.order.create({ data: { userId, items: cart.items, paymentId } });\n  await decrementInventory(cart);\n  await enqueueReceipt(order);\n  return order;\n}',
      },
    ],
  },
  payment: {
    content: `## Where payment is implemented
Payments are handled by the **Stripe integration** in \`src/payments/\`.
- \`src/payments/stripe.ts\` — creates PaymentIntents and confirms them.
- \`src/payments/refund.ts\` — issues full and partial refunds.
- \`src/webhooks/stripe.ts\` — receives \`payment_intent.succeeded\` / \`payment_intent.payment_failed\` and finalizes the order.
The client never finalizes the order directly; it only collects the payment method. Order creation happens on the webhook to stay idempotent against Stripe retries.`,
    evidence: [
      {
        file: 'src/payments/stripe.ts',
        location: 'L40–67',
        snippet:
          "export async function createPaymentIntent(cart) {\n  const total = computeTotal(cart);\n  const intent = await stripe.paymentIntents.create({ amount: total, currency: 'usd' });\n  return { clientSecret: intent.client_secret };\n}",
      },
      {
        file: 'src/webhooks/stripe.ts',
        location: 'L12–33',
        snippet: "case 'payment_intent.succeeded':\n  await confirmOrder(intent.metadata.userId, intent.metadata.cartId, intent.id);\n  break;",
      },
    ],
  },
  changes: {
    content: `## What changed recently
The most recent knowledge update (v3) captured changes from the last repository sync.
### Functional impact
- **Added:** \`src/payments/refund.ts\` — new partial-refund support.
- **Modified:** \`src/checkout/confirm.ts\` — now enqueues the receipt via the new email queue instead of sending inline.
- **Removed:** \`src/legacy/manual-invoicing.ts\` — deprecated manual invoicing path.
### APIs / workflows affected
- New endpoint \`POST /api/refunds\` exposed in \`src/server/routes.ts\`.
- The checkout confirmation workflow now depends on the email queue service.
> Open the **Changes** tab to inspect each item with file-level evidence.`,
    evidence: [
      {
        file: 'src/payments/refund.ts',
        location: 'L1–30',
        snippet:
          'export async function issueRefund(paymentId, amount?) {\n  const refund = await stripe.refunds.create({ payment_intent: paymentId, amount });\n  await db.refund.create({ data: { paymentId, amount: refund.amount } });\n  return refund;\n}',
      },
    ],
  },
};
const DEFAULT_ABSTAIN = {
  abstain: true,
  content: 'The project does not currently contain enough information to answer this question confidently.',
  missing: [
    'A matching capability, workflow, or service was not found in the current knowledge map.',
    "The question may refer to code paths excluded from this project's source (e.g. generated files, or files over the size limit).",
  ],
};

/**
 * Generate a unique mock identifier with an optional prefix.
 * @param prefix - Leading token for the id (default `id`).
 * @returns A unique string id.
 */
export function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${(nextIdCounter++).toString(36)}`;
}

/**
 * Return a mock grounded answer (or abstain) for a user question.
 * @param question - Natural-language question about a project.
 * @returns Grounded answer with evidence, or an abstain payload.
 */
export function mockAnswerFor(question) {
  const answer = pickAnswer(question);
  if (!answer) return { ...DEFAULT_ABSTAIN };
  return { ...answer, abstain: false, knowledgeVersion: 'v3' };

  /**
   * Pick a canned answer topic from free-text question keywords.
   * @param text - User question text.
   * @returns Matching canned answer or null when none match.
   */
  function pickAnswer(text) {
    const normalized = text.toLowerCase();
    if (/(auth|login|session|token|password|rbac|role)/.test(normalized)) return ANSWERS.auth;
    if (/(checkout|cart)/.test(normalized)) return ANSWERS.checkout;
    if (/(payment|stripe|pay|refund)/.test(normalized)) return ANSWERS.payment;
    if (/(change|recent|update|new|diff)/.test(normalized)) return ANSWERS.changes;
    return null;
  }
}

/**
 * Build the Atlas Commerce knowledge tree used by seed data.
 * @returns Root knowledge nodes for Atlas.
 */
function knowledgeTreeAtlas() {
  const auth = {
    label: 'Authentication & Authorization',
    type: 'Capability',
    children: [
      { label: 'Login flow (email + OAuth Google)', type: 'Workflow', evidence: 'src/auth/login.ts' },
      { label: 'Session management (JWT, refresh rotation)', type: 'Workflow', evidence: 'src/auth/session.ts' },
      { label: 'Role-based access control', type: 'Workflow', evidence: 'src/auth/rbac.ts' },
      { label: 'Password reset (OTP via email)', type: 'Workflow', evidence: 'src/auth/reset.ts' },
    ],
  };
  const checkout = {
    label: 'Checkout & Payments',
    type: 'Capability',
    children: [
      { label: 'Cart to checkout transition', type: 'Workflow', evidence: 'src/checkout/cart.ts' },
      { label: 'Stripe payment intent', type: 'Service', evidence: 'src/payments/stripe.ts' },
      { label: 'Order confirmation + receipt email', type: 'Workflow', evidence: 'src/checkout/confirm.ts' },
      { label: 'Refund handling', type: 'Workflow', evidence: 'src/payments/refund.ts' },
    ],
  };
  const catalog = {
    label: 'Product Catalog',
    type: 'Capability',
    children: [
      { label: 'Product search & filtering', type: 'Service', evidence: 'src/catalog/search.ts' },
      { label: 'Inventory sync', type: 'Workflow', evidence: 'src/catalog/inventory.ts' },
    ],
  };
  const services = {
    label: 'Services & APIs',
    type: 'Capability',
    children: [
      { label: 'REST API (Express)', type: 'API', evidence: 'src/server/routes.ts' },
      { label: 'GraphQL gateway', type: 'API', evidence: 'src/gateway/schema.ts' },
      { label: 'Webhooks (Stripe, GitHub)', type: 'API', evidence: 'src/webhooks/index.ts' },
    ],
  };
  const data = {
    label: 'Data Concepts',
    type: 'Capability',
    children: [
      { label: 'User', type: 'Data', evidence: 'prisma/schema.prisma' },
      { label: 'Order', type: 'Data', evidence: 'prisma/schema.prisma' },
      { label: 'Product', type: 'Data', evidence: 'prisma/schema.prisma' },
      { label: 'Subscription', type: 'Data', evidence: 'prisma/schema.prisma' },
    ],
  };
  const integrations = {
    label: 'Integrations',
    type: 'Capability',
    children: [
      { label: 'Stripe (payments)', type: 'Integration', evidence: 'src/payments/stripe.ts' },
      { label: 'SendGrid (email)', type: 'Integration', evidence: 'src/email/sendgrid.ts' },
      { label: 'Sentry (errors)', type: 'Integration', evidence: 'src/observability/sentry.ts' },
    ],
  };
  return [auth, checkout, catalog, services, data, integrations];
}

const seedProjects = [
  {
    id: 'prj_atlas',
    name: 'Atlas Commerce',
    description: 'Headless e-commerce platform — catalog, checkout, payments, and order management.',
    status: 'Knowledge ready',
    knowledgeStatus: 'Ready',
    source: {
      type: 'repo',
      provider: 'github',
      repoUrl: 'https://github.com/acme/atlas-commerce',
      fullName: 'acme/atlas-commerce',
      branch: 'main',
      defaultBranch: 'main',
      branches: ['main', 'develop', 'release/2.4'],
      lastSync: '2026-09-10T14:22:00Z',
      origin: 'GitHub',
    },
    createdAt: '2026-08-21T09:10:00Z',
    createdBy: 'you',
    fileCount: 4812,
    excludedCount: 9,
    partial: false,
    knowledgeTree: knowledgeTreeAtlas(),
  },
  {
    id: 'prj_orion',
    name: 'Orion Analytics',
    description: 'Real-time analytics ingestion and dashboarding service.',
    status: 'Partially available',
    knowledgeStatus: 'Partially available',
    source: {
      type: 'upload',
      uploads: [
        {
          name: 'orion-services.zip',
          size: '38.2 MB',
          files: 1240,
          uploadedAt: '2026-09-05T11:00:00Z',
          status: 'completed',
        },
      ],
      origin: 'Upload',
      lastSync: '2026-09-05T11:14:00Z',
    },
    createdAt: '2026-09-04T16:40:00Z',
    createdBy: 'you',
    fileCount: 1240,
    excludedCount: 12,
    partial: true,
    partialNote: '9 files exceeded the size limit and were excluded from the knowledge map.',
    knowledgeTree: [
      {
        label: 'Ingestion pipeline',
        type: 'Capability',
        children: [
          { label: 'Kafka consumer', type: 'Service', evidence: 'src/ingest/kafka.ts' },
          { label: 'Event validation', type: 'Workflow', evidence: 'src/ingest/validate.ts' },
        ],
      },
      {
        label: 'Dashboards',
        type: 'Capability',
        children: [{ label: 'Widget rendering', type: 'Component', evidence: 'src/dash/widgets.tsx' }],
      },
    ],
  },
  {
    id: 'prj_helios',
    name: 'Helios Gateway',
    description: 'API gateway and routing layer with auth and rate limiting.',
    status: 'Updating',
    knowledgeStatus: 'Updating',
    source: {
      type: 'repo',
      provider: 'gitlab',
      repoUrl: 'https://gitlab.acme.io/platform/helios-gateway',
      fullName: 'platform/helios-gateway',
      baseUrl: 'https://gitlab.acme.io',
      branch: 'main',
      defaultBranch: 'main',
      branches: ['main', 'feat/rate-limit'],
      lastSync: '2026-09-11T08:00:00Z',
      origin: 'GitLab (self-hosted)',
    },
    createdAt: '2026-07-30T10:05:00Z',
    createdBy: 'lena.park',
    fileCount: 980,
    excludedCount: 0,
    partial: false,
    knowledgeTree: [],
  },
];
const seedConversations = [
  {
    id: 'conv_1',
    projectId: 'prj_atlas',
    title: 'How does authentication work?',
    archived: false,
    createdAt: '2026-09-09T13:00:00Z',
    messages: [
      {
        id: 'm1',
        role: 'user',
        content: 'How does authentication work in this project?',
        status: 'Completed',
        createdAt: '2026-09-09T13:00:00Z',
      },
      {
        id: 'm2',
        role: 'assistant',
        content: ANSWERS.auth.content,
        evidence: [...ANSWERS.auth.evidence],
        status: 'Completed',
        knowledgeVersion: 'v3',
        createdAt: '2026-09-09T13:00:05Z',
      },
    ],
  },
  {
    id: 'conv_2',
    projectId: 'prj_atlas',
    title: 'Where is payment implemented?',
    archived: false,
    createdAt: '2026-09-10T10:20:00Z',
    messages: [
      {
        id: 'm3',
        role: 'user',
        content: 'Where is payment implemented?',
        status: 'Completed',
        createdAt: '2026-09-10T10:20:00Z',
      },
      {
        id: 'm4',
        role: 'assistant',
        content: ANSWERS.payment.content,
        evidence: [...ANSWERS.payment.evidence],
        status: 'Completed',
        knowledgeVersion: 'v3',
        createdAt: '2026-09-10T10:20:06Z',
      },
    ],
  },
  {
    id: 'conv_3',
    projectId: 'prj_atlas',
    title: 'Checkout flow walkthrough',
    archived: true,
    createdAt: '2026-09-01T09:00:00Z',
    messages: [
      {
        id: 'm5',
        role: 'user',
        content: 'Explain the checkout flow',
        status: 'Completed',
        createdAt: '2026-09-01T09:00:00Z',
      },
      {
        id: 'm6',
        role: 'assistant',
        content: ANSWERS.checkout.content,
        evidence: [...ANSWERS.checkout.evidence],
        status: 'Completed',
        knowledgeVersion: 'v2',
        createdAt: '2026-09-01T09:00:07Z',
      },
    ],
  },
];
const seedJobs = [
  {
    id: 'job_1',
    projectId: 'prj_helios',
    op: 'Knowledge update',
    status: 'in_progress',
    progress: 68,
    startedAt: '2026-09-11T08:00:00Z',
    stages: [
      { label: 'Source received', state: 'done' },
      { label: 'Project files identified', state: 'done' },
      { label: 'Understanding application functionality', state: 'active' },
      { label: 'Finalizing', state: 'pending' },
    ],
    activity: [
      { ts: '2026-09-11T08:00:00Z', message: 'Repository sync started from main @ a1b2c3d' },
      { ts: '2026-09-11T08:00:40Z', message: 'Source received — 980 files' },
      { ts: '2026-09-11T08:01:10Z', message: 'Project files identified — 980 files, 0 excluded' },
      { ts: '2026-09-11T08:02:00Z', message: 'Understanding application functionality…' },
    ],
    warnings: [],
    errors: [],
  },
  {
    id: 'job_2',
    projectId: 'prj_orion',
    op: 'Initial processing',
    status: 'partial',
    progress: 100,
    startedAt: '2026-09-05T11:14:00Z',
    completedAt: '2026-09-05T11:31:00Z',
    stages: [
      { label: 'Source received', state: 'done' },
      { label: 'Project files identified', state: 'done' },
      { label: 'Understanding application functionality', state: 'done' },
      { label: 'Finalizing', state: 'done' },
    ],
    activity: [
      { ts: '2026-09-05T11:14:00Z', message: 'Upload received — orion-services.zip (1,240 files)' },
      { ts: '2026-09-05T11:25:00Z', message: '9 files exceeded the size limit and were excluded' },
      { ts: '2026-09-05T11:31:00Z', message: 'Processing completed with partial knowledge' },
    ],
    warnings: ['9 files exceeded the size limit and were excluded from the knowledge map.'],
    errors: [],
    ref: 'REQ-ORION-0042',
  },
  {
    id: 'job_3',
    projectId: 'prj_atlas',
    op: 'Initial processing',
    status: 'completed',
    progress: 100,
    startedAt: '2026-08-21T09:12:00Z',
    completedAt: '2026-08-21T09:34:00Z',
    stages: [
      { label: 'Source received', state: 'done' },
      { label: 'Project files identified', state: 'done' },
      { label: 'Understanding application functionality', state: 'done' },
      { label: 'Finalizing', state: 'done' },
    ],
    activity: [
      { ts: '2026-08-21T09:12:00Z', message: 'Repository connected — acme/atlas-commerce @ main' },
      { ts: '2026-08-21T09:34:00Z', message: 'Knowledge ready — 4,812 files mapped' },
    ],
    warnings: [],
    errors: [],
  },
];
const seedUsers = [
  {
    id: 'u1',
    name: 'You',
    email: 'you@acme.io',
    role: 'Admin',
    status: 'Active',
    projects: ['Atlas Commerce', 'Orion Analytics', 'Helios Gateway'],
    lastActivity: '2026-09-11T07:55:00Z',
  },
  {
    id: 'u2',
    name: 'Lena Park',
    email: 'lena.park@acme.io',
    role: 'Editor',
    status: 'Active',
    projects: ['Helios Gateway'],
    lastActivity: '2026-09-10T18:20:00Z',
  },
  {
    id: 'u3',
    name: 'Marcus Reyes',
    email: 'marcus.r@acme.io',
    role: 'Viewer',
    status: 'Active',
    projects: ['Atlas Commerce'],
    lastActivity: '2026-09-09T12:10:00Z',
  },
  {
    id: 'u4',
    name: 'Priya Nair',
    email: 'priya.nair@acme.io',
    role: 'Editor',
    status: 'Inactive',
    projects: [],
    lastActivity: '2026-08-15T09:00:00Z',
  },
];
const seedAudit = [
  {
    id: 'a1',
    actor: 'You',
    action: 'Connected repository',
    target: 'acme/atlas-commerce',
    timestamp: '2026-08-21T09:11:00Z',
    result: 'Success',
  },
  {
    id: 'a2',
    actor: 'You',
    action: 'Triggered knowledge update',
    target: 'Atlas Commerce',
    timestamp: '2026-09-10T14:22:00Z',
    result: 'Success',
  },
  {
    id: 'a3',
    actor: 'Lena Park',
    action: 'Connected repository',
    target: 'platform/helios-gateway',
    timestamp: '2026-09-11T08:00:00Z',
    result: 'Success',
  },
  {
    id: 'a4',
    actor: 'System',
    action: 'Processing failed',
    target: 'Orion Analytics',
    timestamp: '2026-09-05T11:30:00Z',
    result: 'Partial',
    ref: 'REQ-ORION-0042',
  },
  {
    id: 'a5',
    actor: 'You',
    action: 'Archived conversation',
    target: 'Checkout flow walkthrough',
    timestamp: '2026-09-02T10:00:00Z',
    result: 'Success',
  },
];
const seedNotifications = [
  {
    id: 'n1',
    title: 'Knowledge update in progress',
    body: 'Helios Gateway — 68% complete',
    kind: 'processing',
    read: false,
    ts: '2026-09-11T08:02:00Z',
  },
  {
    id: 'n2',
    title: 'Repository update detected',
    body: 'Atlas Commerce has new commits on main',
    kind: 'repo',
    read: false,
    ts: '2026-09-10T14:22:00Z',
  },
  {
    id: 'n3',
    title: 'Processing needs attention',
    body: 'Orion Analytics completed with partial knowledge',
    kind: 'warning',
    read: true,
    ts: '2026-09-05T11:31:00Z',
  },
];
/** Human-readable permission labels shown in Roles & Permissions. */
export const PERMISSION_LABELS = [
  'View organization',
  'Manage users',
  'Create projects',
  'Upload sources',
  'Connect repositories',
  'Trigger knowledge updates',
  'Ask questions',
  'View and archive conversations',
  'Search',
  'Manage settings',
  'View usage',
  'View audit log',
];
/** In-memory seed dataset consumed by AppDataContext. */
export const seed = {
  projects: seedProjects,
  conversations: seedConversations,
  jobs: seedJobs,
  users: seedUsers,
  audit: seedAudit,
  notifications: seedNotifications,
};
/** Suggested starter questions shown on Home and Chat empty states. */
export const SUGGESTED_QUESTIONS = [
  'Explain this project',
  'How does authentication work?',
  'Explain the checkout flow',
  'Where is payment implemented?',
  'What changed recently?',
];
