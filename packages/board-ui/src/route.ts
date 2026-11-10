export type Tab = 'events' | 'consumers' | 'dlq';

export type Route = { view: 'topics' } | { view: 'topic'; topic: string; tab: Tab };

const TABS: Tab[] = ['events', 'consumers', 'dlq'];

/** `#/` is the topics list, `#/topics/<name>/<tab>` a topic. */
export function parseRoute(hash: string): Route {
  const [, section, topic, tab] = hash.replace(/^#/, '').split('/');
  if (section === 'topics' && topic) {
    const found = TABS.find((t) => t === tab);
    return { view: 'topic', topic: decodeURIComponent(topic), tab: found ?? 'events' };
  }
  return { view: 'topics' };
}

export const topicHref = (topic: string, tab: Tab = 'events'): string =>
  `#/topics/${encodeURIComponent(topic)}/${tab}`;
