import { defineConfig } from 'vitepress';

// On GitHub Pages the site lives under /<repository>/; the workflow sets DOCS_BASE accordingly.
const base = process.env.DOCS_BASE ?? '/';
const site = 'https://eventlane-dev.github.io/eventlane';

export default defineConfig({
  title: 'EventLane',
  description: 'A persistent event bus on Redis Streams for Node.js and NestJS',
  base,
  head: [['link', { rel: 'icon', type: 'image/svg+xml', href: `${base}favicon.svg` }]],
  cleanUrls: true,
  sitemap: { hostname: `${site}/` },
  // canonical link and the tags that give a link preview (Slack, Discord, social networks)
  transformHead({ pageData }) {
    const path = pageData.relativePath.replace(/(^|\/)index\.md$/, '$1').replace(/\.md$/, '');
    const url = `${site}/${path}`;
    const title = pageData.title ? `${pageData.title} | EventLane` : 'EventLane';
    const description =
      pageData.description || 'A persistent event bus on Redis Streams for Node.js and NestJS';
    return [
      ['link', { rel: 'canonical', href: url }],
      ['meta', { property: 'og:type', content: 'website' }],
      ['meta', { property: 'og:site_name', content: 'EventLane' }],
      ['meta', { property: 'og:title', content: title }],
      ['meta', { property: 'og:description', content: description }],
      ['meta', { property: 'og:url', content: url }],
      ['meta', { name: 'twitter:card', content: 'summary' }],
    ];
  },
  themeConfig: {
    logo: { light: '/logo.svg', dark: '/logo-dark.svg', alt: 'EventLane' },
    nav: [
      { text: 'Core', link: '/core/getting-started', activeMatch: '/core/' },
      { text: 'NestJS', link: '/nestjs/getting-started', activeMatch: '/nestjs/' },
      { text: 'Dashboard', link: '/dashboard/overview', activeMatch: '/dashboard/' },
      { text: 'Comparison', link: '/comparison' },
    ],
    sidebar: {
      '/core/': [
        {
          text: 'Core',
          items: [
            { text: 'Quick start', link: '/core/quick-start' },
            { text: 'Getting started', link: '/core/getting-started' },
            { text: 'Concepts and naming', link: '/core/concepts' },
            { text: 'Core API', link: '/core/api' },
            { text: 'Reliability', link: '/core/reliability' },
            { text: 'Operations', link: '/core/operations' },
            { text: 'Recipes', link: '/core/recipes' },
            { text: 'Patterns', link: '/core/patterns' },
            { text: 'Production checklist', link: '/core/production-checklist' },
            { text: 'Troubleshooting', link: '/core/troubleshooting' },
            { text: 'Configuration', link: '/core/configuration' },
            { text: 'Redis data model', link: '/core/redis-data-model' },
          ],
        },
      ],
      '/nestjs/': [
        {
          text: 'NestJS',
          items: [
            { text: 'Getting started', link: '/nestjs/getting-started' },
            { text: 'Module, emitters and handlers', link: '/nestjs/guide' },
            { text: 'Configuration', link: '/nestjs/configuration' },
          ],
        },
      ],
      '/dashboard/': [
        {
          text: 'Dashboard',
          items: [
            { text: 'Overview', link: '/dashboard/overview' },
            { text: 'Getting started', link: '/dashboard/getting-started' },
            { text: 'HTTP API', link: '/dashboard/api' },
          ],
        },
      ],
      '/': [
        {
          text: 'Project',
          items: [
            { text: 'Comparison', link: '/comparison' },
            { text: 'Changelog', link: '/changelog' },
            { text: 'For AI coding agents', link: '/for-agents' },
          ],
        },
      ],
    },
    search: { provider: 'local' },
    outline: [2, 3],
  },
});
