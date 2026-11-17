import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { linkSchema } from '../fireside/schemas.js';
import { episodeArg, guarded, ok, pick, podcastArg, type ToolDeps } from './common.js';
import { ToolInputError } from './errors.js';

const LIVE = "Changes appear under the episode's show notes, in its feed and on its page right away.";

const url = z
  .url({ protocol: /^https?$/ })
  .max(2000)
  .describe('A full http or https URL, up to 2,000 characters. Each URL can appear once per episode.');
const title = z.string().trim().min(1).max(1000).describe('The text listeners see, up to 1,000 characters.');
const excerpt = z.string().max(10_000).nullable().describe('A note about the link, up to 10,000 characters.');
const linkArg = z.string().trim().min(1).describe('The link token, from fireside_list_links.');

const listOutput = z.object({ links: z.array(linkSchema) });
const itemOutput = z.object({ link: linkSchema });

export function registerLinkTools(server: McpServer, { client, resolver }: ToolDeps, write: boolean): void {
  server.registerTool(
    'fireside_list_links',
    {
      title: 'List links',
      description:
        "List an episode's links in the order listeners see them under its show notes, in its feed and on its page, " +
        'each with its token, url, title and excerpt. clicks, the number of clicks Fireside has tracked, is ' +
        "included only when click tracking is on and the key belongs to the podcast's owner or a manager. Needs " +
        'the owner, manager, or producer role.',
      inputSchema: z.strictObject({ podcast: podcastArg(resolver), episode: episodeArg }),
      outputSchema: listOutput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args, ctx) =>
      guarded(async () => {
        const podcast = await resolver.podcast(args.podcast, ctx.mcpReq.signal);
        const episode = await resolver.episode(podcast, args.episode, ctx.mcpReq.signal);
        return ok({ links: (await client.listLinks(podcast, episode, ctx.mcpReq.signal)).data });
      }),
  );
  if (!write) return;

  server.registerTool(
    'fireside_set_links',
    {
      title: 'Replace links',
      description:
        "Replace an episode's whole link list, in the order given, for example with links pulled from its show " +
        'notes or transcript, or to reorder them. Links left out are deleted, and an empty list deletes them all, ' +
        'so to change one or two use fireside_add_link, fireside_update_link or fireside_delete_link instead. ' +
        "Include a link's token (from fireside_list_links) to keep it and its click count; a link sent without its " +
        `token is added as new, with no clicks. If any link is invalid, nothing changes. ${LIVE}`,
      inputSchema: z.strictObject({
        podcast: podcastArg(resolver),
        episode: episodeArg,
        links: z
          .array(
            z.strictObject({
              token: linkArg.optional().describe("An existing link's token, to keep it. Omit for a new link."),
              url,
              title,
              excerpt: excerpt
                .optional()
                .describe('Optional note about the link, up to 10,000 characters. A link sent without one has none.'),
            }),
          )
          .max(500)
          .describe('The complete new link list, in order, up to 500 links.'),
      }),
      outputSchema: listOutput,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    (args, ctx) =>
      guarded(async () => {
        const duplicate = firstDuplicate(args.links.map((l) => l.url));
        if (duplicate !== undefined) {
          throw new ToolInputError(`${duplicate} appears more than once; each URL can appear once per episode.`);
        }
        const podcast = await resolver.podcast(args.podcast, ctx.mcpReq.signal);
        const episode = await resolver.episode(podcast, args.episode, ctx.mcpReq.signal);
        const links = args.links.map((l) => ({ ...pick(l, 'token', 'excerpt'), url: l.url, title: l.title }));
        return ok({ links: (await client.replaceLinks(podcast, episode, links, ctx.mcpReq.signal)).data });
      }),
  );

  server.registerTool(
    'fireside_add_link',
    {
      title: 'Add link',
      description:
        "Add one link to the end of an episode's links. To set many at once, or to reorder them, use " +
        `fireside_set_links. ${LIVE}`,
      inputSchema: z.strictObject({
        podcast: podcastArg(resolver),
        episode: episodeArg,
        url,
        title,
        excerpt: excerpt.optional(),
      }),
      outputSchema: itemOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (args, ctx) =>
      guarded(async () => {
        const podcast = await resolver.podcast(args.podcast, ctx.mcpReq.signal);
        const episode = await resolver.episode(podcast, args.episode, ctx.mcpReq.signal);
        const fields = pick(args, 'url', 'title', 'excerpt');
        return ok({ link: (await client.createLink(podcast, episode, fields, ctx.mcpReq.signal)).data });
      }),
  );

  server.registerTool(
    'fireside_update_link',
    {
      title: 'Update link',
      description:
        "Change one link's url, title or excerpt, leaving the rest alone; excerpt null removes the excerpt. The link " +
        `keeps its place and its click count. ${LIVE}`,
      inputSchema: z.strictObject({
        podcast: podcastArg(resolver),
        episode: episodeArg,
        link: linkArg,
        url: url.optional(),
        title: title.optional(),
        excerpt: excerpt.optional().describe('A note about the link, up to 10,000 characters. null removes it.'),
      }),
      outputSchema: itemOutput,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    (args, ctx) =>
      guarded(async () => {
        const changes = pick(args, 'url', 'title', 'excerpt');
        if (Object.keys(changes).length === 0) {
          throw new ToolInputError('Nothing to change: pass at least one of url, title, excerpt.');
        }
        const podcast = await resolver.podcast(args.podcast, ctx.mcpReq.signal);
        const episode = await resolver.episode(podcast, args.episode, ctx.mcpReq.signal);
        return ok({ link: (await client.updateLink(podcast, episode, args.link, changes, ctx.mcpReq.signal)).data });
      }),
  );

  server.registerTool(
    'fireside_delete_link',
    {
      title: 'Delete link',
      description: `Delete one link from an episode, with its click count. Returns the link as it was. ${LIVE}`,
      inputSchema: z.strictObject({ podcast: podcastArg(resolver), episode: episodeArg, link: linkArg }),
      outputSchema: itemOutput,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    (args, ctx) =>
      guarded(async () => {
        const podcast = await resolver.podcast(args.podcast, ctx.mcpReq.signal);
        const episode = await resolver.episode(podcast, args.episode, ctx.mcpReq.signal);
        return ok({ link: (await client.deleteLink(podcast, episode, args.link, ctx.mcpReq.signal)).data });
      }),
  );
}

function firstDuplicate(values: string[]): string | undefined {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return undefined;
}
