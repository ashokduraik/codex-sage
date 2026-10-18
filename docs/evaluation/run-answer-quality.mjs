/**
 * Operator answer-quality runner — asks gold questions against a knowledge-ready project
 * and scores citation accuracy + abstention. Application code does not read the report.
 *
 * Usage (from repo root):
 *   node docs/evaluation/run-answer-quality.mjs \
 *     --base-url http://127.0.0.1:3000/api/v1 \
 *     --project-id <id> \
 *     --token <accessJwt>
 *
 * Optional: --cases PATH --out-dir docs/evaluation --help
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  aggregateAnswerQualityScores,
  scoreAnswerQualityCase,
} from './answerQualityScore.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const defaultCasesPath = path.join(repoRoot, 'docs/evaluation/answer-quality/cases.json');
const defaultOutDir = path.join(repoRoot, 'docs/evaluation');

/**
 * Parses CLI argv into options.
 * @param {string[]} argv Process argv slice.
 * @returns {Record<string, string | boolean>}
 */
function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      out.help = true;
      continue;
    }
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out[key] = next;
        i += 1;
      } else {
        out[key] = true;
      }
    }
  }
  return out;
}

/**
 * Prints help text.
 */
function printHelp() {
  console.log(`Answer-quality evaluation (Phase 55)

Requires a running API, LLM host, and a knowledge-ready project.

  npm run eval:answer-quality -- \\
    --project-id <mongoProjectId> \\
    --token <accessJwt>

  # Express OSS gold (see docs/evaluation/answer-quality/express.pin.json)
  npm run eval:answer-quality -- \\
    --cases docs/evaluation/answer-quality/cases-express.json \\
    --project-id <expressProjectId> \\
    --token <accessJwt>

Options:
  --base-url URL   API base (default: http://127.0.0.1:3000/api/v1)
  --cases PATH     Gold cases JSON (default: docs/evaluation/answer-quality/cases.json)
  --out-dir PATH   Report directory (default: docs/evaluation)
  --help           Show this help
`);
}

/**
 * Creates a conversation via the API.
 * @param {string} baseUrl API base.
 * @param {string} projectId Project id.
 * @param {string} token Bearer token.
 * @returns {Promise<string>} Conversation id.
 */
async function createConversation(baseUrl, projectId, token) {
  const res = await fetch(`${baseUrl}/conversation/conversation/create/${encodeURIComponent(projectId)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': crypto.randomUUID(),
      Accept: 'application/json',
    },
    body: JSON.stringify({ title: 'answer-quality-eval' }),
  });
  if (!res.ok) {
    throw new Error(`create conversation failed: HTTP ${res.status}`);
  }
  const body = await res.json();
  return String(body.id);
}

/**
 * Runs one ask SSE and collects evidence + terminal status.
 * @param {string} baseUrl API base.
 * @param {string} projectId Project id.
 * @param {string} conversationId Conversation id.
 * @param {string} token Bearer token.
 * @param {string} question Question text.
 * @returns {Promise<{ messageStatus?: string, evidence: object[], supportLevel?: string, route?: string, error?: string }>}
 */
async function askOnce(baseUrl, projectId, conversationId, token, question) {
  const res = await fetch(
    `${baseUrl}/conversation/chatStream/streamMessage/${encodeURIComponent(projectId)}/${encodeURIComponent(conversationId)}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': crypto.randomUUID(),
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({ content: question }),
    },
  );

  if (res.status === 202) {
    return { messageStatus: 'queued', evidence: [], error: 'queued_not_scored' };
  }

  if (!res.ok) {
    let detail = '';
    try {
      detail = JSON.stringify(await res.json());
    } catch {
      detail = await res.text();
    }
    return { messageStatus: 'failed', evidence: [], error: `HTTP ${res.status}: ${detail}` };
  }

  /** @type {object[]} */
  const evidence = [];
  /** @type {string | undefined} */
  let messageStatus;
  /** @type {string | undefined} */
  let assistantMessageId;
  const text = await res.text();
  const blocks = text.split('\n\n');
  for (const block of blocks) {
    if (!block || block.startsWith(':')) {
      continue;
    }
    let eventName = 'message';
    /** @type {string[]} */
    const dataLines = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    if (dataLines.length === 0) {
      continue;
    }
    let data;
    try {
      data = JSON.parse(dataLines.join('\n'));
    } catch {
      continue;
    }
    if (eventName === 'evidence' && Array.isArray(data.items)) {
      for (const item of data.items) {
        evidence.push({
          path: item.path,
          startLine: item.startLine,
          endLine: item.endLine,
        });
      }
    }
    if (eventName === 'done' && typeof data.messageId === 'string') {
      assistantMessageId = data.messageId;
      messageStatus = 'completed';
    }
    if (eventName === 'error') {
      messageStatus = 'failed';
    }
    if (eventName === 'clarification') {
      messageStatus = 'awaiting_clarification';
    }
  }

  if (assistantMessageId) {
    const msgRes = await fetch(
      `${baseUrl}/conversation/conversation/listMessages/${encodeURIComponent(projectId)}/${encodeURIComponent(conversationId)}?limit=50`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
      },
    );
    if (msgRes.ok) {
      const page = await msgRes.json();
      const row = Array.isArray(page.items) ? page.items.find((m) => String(m.id) === assistantMessageId) : null;
      if (row) {
        messageStatus = row.messageStatus || messageStatus;
        if (Array.isArray(row.evidence) && row.evidence.length > 0 && evidence.length === 0) {
          for (const item of row.evidence) {
            evidence.push({
              path: item.path,
              startLine: item.startLine,
              endLine: item.endLine,
            });
          }
        }
      }
    }
  }

  return { messageStatus, evidence, supportLevel: undefined, route: undefined };
}

/**
 * Main entry.
 * @returns {Promise<number>} Process exit code.
 */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return 0;
  }

  const baseUrl = typeof args['base-url'] === 'string' ? args['base-url'].replace(/\/$/, '') : '';
  const projectId = typeof args['project-id'] === 'string' ? args['project-id'] : '';
  const token = typeof args.token === 'string' ? args.token : '';
  const casesPath = typeof args.cases === 'string' ? path.resolve(args.cases) : defaultCasesPath;
  const outDir = typeof args['out-dir'] === 'string' ? path.resolve(args['out-dir']) : defaultOutDir;

  if (!baseUrl || !projectId || !token) {
    printHelp();
    console.error('Missing required --base-url, --project-id, or --token.');
    return 2;
  }

  const cases = JSON.parse(await readFile(casesPath, 'utf8'));
  if (!Array.isArray(cases) || cases.length === 0) {
    console.error('No cases in', casesPath);
    return 2;
  }

  const conversationId = await createConversation(baseUrl, projectId, token);
  /** @type {object[]} */
  const results = [];

  for (const gold of cases) {
    const outcome = await askOnce(baseUrl, projectId, conversationId, token, gold.question);
    const scored = scoreAnswerQualityCase(gold, outcome);
    results.push({
      id: gold.id,
      expect: gold.expect,
      question: gold.question,
      outcome,
      ...scored,
    });
    console.log(
      `${gold.id}: ${scored.pass ? 'PASS' : 'FAIL'} expect=${gold.expect} status=${outcome.messageStatus ?? 'n/a'} recall=${scored.recall.toFixed(2)}`,
    );
  }

  const suite = aggregateAnswerQualityScores(results);
  const raw = {
    generatedAt: new Date().toISOString(),
    baseUrl,
    projectId,
    conversationId,
    casesPath,
    suite,
    results,
  };

  const rawPath = path.join(outDir, 'answer-quality.raw.json');
  const mdPath = path.join(outDir, 'answer-quality.md');
  await writeFile(rawPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');

  const md = `# Answer-quality evaluation

Generated: ${raw.generatedAt}

Project: \`${projectId}\` · Conversation: \`${conversationId}\`

## Suite metrics

| Metric | Value |
| --- | --- |
| mean precision | ${suite.meanPrecision.toFixed(3)} |
| mean recall | ${suite.meanRecall.toFixed(3)} |
| citation-pass rate | ${suite.citationPassRate.toFixed(3)} |
| abstain-pass rate | ${suite.abstainPassRate.toFixed(3)} |
| false-abstain rate | ${suite.falseAbstainRate.toFixed(3)} |
| false-answer rate | ${suite.falseAnswerRate.toFixed(3)} |
| suite pass (≥ 0.8) | ${suite.suitePass ? 'yes' : 'no'} |

## Cases

| id | expect | pass | recall | precision | status |
| --- | --- | --- | --- | --- | --- |
${results
  .map(
    (r) =>
      `| ${r.id} | ${r.expect} | ${r.pass ? 'yes' : 'no'} | ${r.recall.toFixed(2)} | ${r.precision.toFixed(2)} | ${r.outcome.messageStatus ?? r.outcome.error ?? ''} |`,
  )
  .join('\n')}

Re-run:

\`\`\`bash
node docs/evaluation/run-answer-quality.mjs --base-url ${baseUrl} --project-id ${projectId} --token <accessJwt>
\`\`\`
`;

  await writeFile(mdPath, md, 'utf8');
  console.log(`Wrote ${rawPath}`);
  console.log(`Wrote ${mdPath}`);
  console.log(`Suite pass: ${suite.suitePass}`);
  return suite.suitePass ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
