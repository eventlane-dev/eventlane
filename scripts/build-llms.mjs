// Generates docs/public/llms.txt (an index) and docs/public/llms-full.txt (all pages in one file)
// for AI agents, from the Markdown pages in docs/. Runs before every docs build.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const docs = join(root, 'docs');
const site = 'https://eventlane-dev.github.io/eventlane';
const raw = 'https://raw.githubusercontent.com/eventlane-dev/eventlane/main/docs';

// the order and the grouping of the sidebar
const sections = [
  ['Start here', ['for-agents', 'core/quick-start', 'core/getting-started', 'core/concepts']],
  [
    'Core library',
    [
      'core/api',
      'core/reliability',
      'core/operations',
      'core/recipes',
      'core/patterns',
      'core/production-checklist',
      'core/troubleshooting',
      'core/configuration',
      'core/redis-data-model',
    ],
  ],
  ['NestJS', ['nestjs/getting-started', 'nestjs/guide', 'nestjs/configuration']],
  ['Dashboard', ['dashboard/overview', 'dashboard/getting-started', 'dashboard/api']],
  ['Project', ['comparison', 'changelog']],
];

const summaries = {
  'core/api': 'Creating a bus, emitting, listening, subscription options and inspection methods.',
  'core/reliability':
    'At-least-once delivery, retries and backoff, dead letters, crash recovery, deduplication, ordering and what happens when Redis is unavailable.',
  'core/operations':
    'Redis setup, retention, peeking at events, replay, stats and lag, retrying and removing things, performance.',
  'core/configuration': 'Every option of the bus, of topics and of subscriptions.',
  'nestjs/configuration': 'Options of EventLaneModule.forRoot, forFeature and @OnLaneEvent.',
};

function page(path) {
  const text = readFileSync(join(docs, `${path}.md`), 'utf8');
  const title = /^#\s+(.+)$/m.exec(text)?.[1] ?? path;
  const body = text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^>.*$/gm, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`/g, '')
    .split('\n');
  const summary =
    body
      .find(
        (line, i) =>
          i > 0 &&
          line.trim() &&
          !/^(#|\||```|-|\*|\d+\.)/.test(line.trim()) &&
          !line.trim().endsWith(':'),
      )
      ?.trim() ?? '';
  const final = summaries[path] ?? summary;
  return {
    path,
    title,
    text,
    summary: final.length > 180 ? `${final.slice(0, 177)}...` : final,
  };
}

const groups = sections.map(([name, paths]) => [name, paths.map(page)]);
const index = [
  '# EventLane',
  '',
  '> A persistent event bus on Redis Streams for Node.js and NestJS: topics, independent consumers, retries, dead letters, replay and a dashboard. Packages: @eventlane/core, @eventlane/nestjs, @eventlane/board-*.',
  '',
  `The whole documentation in one file: ${site}/llms-full.txt`,
  '',
  ...groups.flatMap(([name, pages]) => [
    `## ${name}`,
    '',
    ...pages.map((p) => `- [${p.title}](${raw}/${p.path}.md): ${p.summary}`),
    '',
  ]),
].join('\n');

const full = [
  '# EventLane documentation',
  '',
  `Source: ${site}/`,
  '',
  ...groups.flatMap(([, pages]) =>
    pages.flatMap((p) => ['---', '', `<!-- ${raw}/${p.path}.md -->`, '', p.text.trim(), '', '']),
  ),
].join('\n');

mkdirSync(join(docs, 'public'), { recursive: true });
writeFileSync(join(docs, 'public/llms.txt'), `${index}\n`);
writeFileSync(join(docs, 'public/llms-full.txt'), `${full}\n`);
console.log(
  `llms.txt (${groups.flatMap(([, p]) => p).length} pages), llms-full.txt (${Math.round(full.length / 1024)} KB)`,
);
