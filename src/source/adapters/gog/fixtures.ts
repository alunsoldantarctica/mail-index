/**
 * Recorded gog fixtures + a replay runner (PLAN §19 "recorded fixtures, no live
 * network"). gog's `gmail raw` emits the *raw Gmail REST JSON* (lossless
 * `Users.Messages.Get`) — the same shape gws emits — so these fixtures reuse the
 * three logical messages (direct, list, sent) the gws/source fixtures cover, in
 * gog's command surface (`auth list`, `gmail messages search`, `gmail raw`). The
 * gog adapter therefore passes the same {@link runMailSourceContract} harness,
 * proving argument building, pagination, JSON parsing, and payload walking with
 * NO child process and NO network.
 *
 * Hand-authored synthetic data on `example.com`/`example.org` (no real personal
 * data, per the 2a/2b boundary, PLAN §2). Same ids + same authenticated address
 * as the gws bundle so a single {@link MailSourceFixtures} drives both adapters.
 */

import type { MailSourceFixtures } from '../../fixtures/index.js';
import type { GogRunner } from './runner.js';

/** Base64url-encode a UTF-8 string the way Gmail bodies are returned. */
function b64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}

/** The mailbox these fixtures authenticate as (matches the source fixtures). */
const ADDRESS = 'al@example.com';

/** `gog auth list` response — the account is authorized. */
const AUTH_LIST = { accounts: [{ email: ADDRESS, status: 'valid' }] };

/**
 * Raw Gmail `Users.Messages.Get` resources, keyed by id — exactly what
 * `gog gmail raw <id> -j` returns (lossless: full headers + body parts).
 */
const RAW_MESSAGES: Record<string, unknown> = {
  'fixt-direct-1': {
    id: 'fixt-direct-1',
    threadId: 'thread-direct-1',
    labelIds: ['INBOX', 'IMPORTANT', 'CATEGORY_PERSONAL'],
    snippet: 'Confirming the 20% deposit is due Friday — wire details below.',
    internalDate: '1717000000000',
    sizeEstimate: 4096,
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'Date', value: 'Wed, 29 May 2024 18:26:40 +0000' },
        { name: 'From', value: 'Jordan Partner <jordan@partner.example.com>' },
        { name: 'To', value: 'Al Operator <al@example.com>' },
        { name: 'Subject', value: 'Re: Deposit terms for the Antarctica charter' },
      ],
      body: {
        size: 140,
        data: b64url(
          'Hi Al,\n\nConfirming the 20% deposit is due Friday. Wire details below.\n\n' +
            'Best,\nJordan\n\n> On Tue, Al wrote:\n> Can you confirm the deposit schedule?',
        ),
      },
    },
  },
  'fixt-list-1': {
    id: 'fixt-list-1',
    threadId: 'thread-list-1',
    labelIds: ['INBOX', 'CATEGORY_UPDATES', 'UNREAD'],
    snippet: 'Top stories: new zodiac schedules, ice-class vessel availability…',
    internalDate: '1716900000000',
    sizeEstimate: 28672,
    payload: {
      mimeType: 'multipart/alternative',
      headers: [
        { name: 'Date', value: 'Tue, 28 May 2024 14:40:00 +0000' },
        { name: 'From', value: 'Expedition Weekly <news@bulletin.example.org>' },
        { name: 'To', value: 'subscribers@bulletin.example.org' },
        { name: 'Subject', value: 'This week in polar logistics' },
        { name: 'List-Id', value: 'Expedition Weekly <news.bulletin.example.org>' },
        { name: 'List-Unsubscribe', value: '<https://bulletin.example.org/unsubscribe>' },
      ],
      parts: [
        {
          mimeType: 'text/html',
          headers: [],
          body: {
            size: 200,
            data: b64url(
              '<html><body><h1>This week in polar logistics</h1>' +
                '<p>Top stories: new zodiac schedules, ice-class vessel availability.</p>' +
                '<a href="https://bulletin.example.org/unsubscribe">Unsubscribe</a>' +
                '</body></html>',
            ),
          },
        },
      ],
    },
  },
  'fixt-sent-1': {
    id: 'fixt-sent-1',
    threadId: 'thread-direct-1',
    labelIds: ['SENT', 'CATEGORY_PERSONAL'],
    snippet: 'Can you confirm the deposit schedule?',
    internalDate: '1716800000000',
    sizeEstimate: 2048,
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'Date', value: 'Mon, 27 May 2024 10:53:20 +0000' },
        { name: 'From', value: 'Al Operator <al@example.com>' },
        { name: 'To', value: 'Jordan Partner <jordan@partner.example.com>' },
        { name: 'Subject', value: 'Re: Deposit terms for the Antarctica charter' },
      ],
      body: {
        size: 50,
        data: b64url('Can you confirm the deposit schedule?\n\nThanks,\nAl'),
      },
    },
  },
};

/** Ids in newest-first order, as `gmail messages search` returns them. */
const LIST_ORDER = ['fixt-direct-1', 'fixt-list-1', 'fixt-sent-1'] as const;

/** The label this Gmail message carries for Sent filtering in search replay. */
function isSent(id: string): boolean {
  const m = RAW_MESSAGES[id] as { labelIds?: string[] } | undefined;
  return m?.labelIds?.includes('SENT') ?? false;
}

function lookupThread(id: string): string | undefined {
  const m = RAW_MESSAGES[id] as { threadId?: string } | undefined;
  return m?.threadId;
}

/** Read the value following a flag in an argv (e.g. `--max` → `'2'`). */
function flagValue(args: readonly string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] != null ? args[i + 1] : undefined;
}

/**
 * Build a fixture-backed {@link GogRunner} that replays the recorded gog JSON
 * for the supported calls. It interprets the same argv the real adapter emits
 * (`auth list` / `gmail messages search <q> --max --page` / `gmail raw <id>`),
 * exercising the adapter's real argument-building, pagination, and payload
 * walking. Unknown ids reject (mirroring gog's non-zero exit on a 404), which
 * the adapter turns into an omitted metadata row / null full record.
 */
export function makeGogFixtureRunner(): GogRunner {
  return (args: readonly string[]) => {
    const a = [...args];

    // `auth list`
    if (a[0] === 'auth' && a[1] === 'list') {
      return Promise.resolve(AUTH_LIST);
    }

    // `gmail messages search <query> -a <acct> --max <n> [--page <token>]`
    if (a[0] === 'gmail' && a[1] === 'messages' && a[2] === 'search') {
      const query = a[3] ?? '';
      const excludeSent = query.includes('-in:sent');
      const max = Number(flagValue(a, '--max') ?? 100);
      const token = flagValue(a, '--page');

      const ordered = LIST_ORDER.filter((id) => !(excludeSent && isSent(id)));
      const start = token ? Number(token) : 0;
      const slice = ordered.slice(start, start + max);
      const nextStart = start + slice.length;
      const nextPageToken = nextStart < ordered.length ? String(nextStart) : undefined;

      return Promise.resolve({
        messages: slice.map((id) => ({ id, threadId: lookupThread(id) })),
        ...(nextPageToken ? { nextPageToken } : {}),
        resultSizeEstimate: ordered.length,
      });
    }

    // `gmail raw <id> -a <acct>`
    if (a[0] === 'gmail' && a[1] === 'raw') {
      const id = a[2] ?? '';
      const raw = RAW_MESSAGES[id];
      if (!raw) {
        return Promise.reject(new Error(`gog fixture: no message "${id}" (simulated 404)`));
      }
      return Promise.resolve(raw);
    }

    return Promise.reject(new Error(`gog fixture: unsupported call "${a.join(' ')}"`));
  };
}

/**
 * The provider-neutral expectations the contract harness asserts against, built
 * to match these gog fixtures (same address + ids as the recorded JSON). Bodies
 * left null here — the harness sources bodies from the adapter (via the runner).
 */
export const GOG_CONTRACT_FIXTURES: MailSourceFixtures = {
  address: ADDRESS,
  messages: LIST_ORDER.map((id) => {
    const m = RAW_MESSAGES[id] as { threadId?: string; labelIds?: string[] };
    return {
      id,
      threadId: m.threadId ?? null,
      internalDate: null,
      dateHeader: null,
      from: null,
      to: null,
      cc: null,
      subject: null,
      labels: m.labelIds ?? [],
      snippet: null,
      sizeEstimate: null,
      bodyText: null,
      bodyHtml: null,
      mimeType: null,
    };
  }),
};
