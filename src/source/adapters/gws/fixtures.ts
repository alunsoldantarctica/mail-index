/**
 * Recorded gws fixtures + a replay runner (SCOPE 0.4, PLAN §19 "recorded
 * fixtures, no live network"). These are the *raw Gmail REST JSON* shapes gws
 * emits, captured/synthesised for the three logical messages the stage-0.3
 * source fixtures cover (direct, list, sent) so the gws adapter passes the same
 * {@link runMailSourceContract} harness the fake does — proving argument
 * building, pagination, JSON parsing, and payload walking, with NO child
 * process and NO network.
 *
 * The records are hand-authored synthetic data on `example.com`/`example.org`
 * (no real personal data, per the 2a/2b boundary, PLAN §2). They mirror the
 * provider-neutral expectations in `../../fixtures/index.ts`: same ids, same
 * authenticated address, the same direct + list + sent breadth (≥2 messages,
 * §19), so a single {@link MailSourceFixtures} bundle drives both adapters.
 */

import type { MailSourceFixtures } from '../../fixtures/index.js';
import type { GwsRunner } from './runner.js';

/** Base64url-encode a UTF-8 string the way Gmail bodies are returned. */
function b64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}

/** The mailbox these fixtures authenticate as (matches the source fixtures). */
const ADDRESS = 'al@example.com';

/** `gmail users getProfile` response. */
const PROFILE = { emailAddress: ADDRESS, messagesTotal: 3, threadsTotal: 2 };

/**
 * Raw Gmail `messages.get?format=full` resources, keyed by id. `format=metadata`
 * is served by stripping the body data from these same payloads (mirroring how
 * Gmail returns metadata: headers + snippet + labels, no decoded body parts).
 */
const FULL_MESSAGES: Record<string, unknown> = {
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
        {
          name: 'List-Unsubscribe',
          value: '<https://bulletin.example.org/unsubscribe>',
        },
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

/** Ids in newest-first order, as `messages.list` returns them. */
const LIST_ORDER = ['fixt-direct-1', 'fixt-list-1', 'fixt-sent-1'] as const;

/** Strip decoded body data to mimic `format=metadata` (headers, no body data). */
function toMetadataResource(full: unknown): unknown {
  const m = full as { payload?: { headers?: unknown; mimeType?: unknown } } & Record<
    string,
    unknown
  >;
  return {
    id: m['id'],
    threadId: m['threadId'],
    labelIds: m['labelIds'],
    snippet: m['snippet'],
    internalDate: m['internalDate'],
    sizeEstimate: m['sizeEstimate'],
    payload: { mimeType: m.payload?.mimeType, headers: m.payload?.headers },
  };
}

/** The label this Gmail message carries for Sent filtering in list replay. */
function isSent(id: string): boolean {
  const m = FULL_MESSAGES[id] as { labelIds?: string[] } | undefined;
  return m?.labelIds?.includes('SENT') ?? false;
}

/**
 * Build a fixture-backed {@link GwsRunner} that replays the recorded gws JSON
 * for the supported calls. It interprets the same argv the real adapter emits
 * (getProfile / messages list / messages get format=metadata|full), so it
 * exercises the adapter's real argument-building and pagination. Unknown ids
 * reject (mirroring gws' non-zero exit on a 404), which the adapter turns into
 * an omitted metadata row / null full record.
 */
export function makeGwsFixtureRunner(): GwsRunner {
  return (args: readonly string[]) => {
    const a = [...args];
    // a = ['gmail','users', <method...> , '--params', '<json>']
    const paramsIdx = a.indexOf('--params');
    const params: Record<string, unknown> =
      paramsIdx >= 0 && a[paramsIdx + 1] ? JSON.parse(a[paramsIdx + 1] as string) : {};

    const method = a.slice(2, paramsIdx >= 0 ? paramsIdx : undefined).join('.');

    if (method === 'getProfile') {
      return Promise.resolve(PROFILE);
    }

    if (method === 'messages.list') {
      const q = typeof params['q'] === 'string' ? (params['q'] as string) : '';
      const excludeSent = q.includes('-in:sent');
      const maxResults = typeof params['maxResults'] === 'number' ? params['maxResults'] : 100;
      const token = typeof params['pageToken'] === 'string' ? (params['pageToken'] as string) : '';

      const ordered = LIST_ORDER.filter((id) => !(excludeSent && isSent(id)));
      // Paginate deterministically: pageToken encodes the next start offset.
      const start = token ? Number(token) : 0;
      const slice = ordered.slice(start, start + maxResults);
      const nextStart = start + slice.length;
      const nextPageToken = nextStart < ordered.length ? String(nextStart) : undefined;

      return Promise.resolve({
        messages: slice.map((id) => ({ id, threadId: lookupThread(id) })),
        ...(nextPageToken ? { nextPageToken } : {}),
        resultSizeEstimate: ordered.length,
      });
    }

    if (method === 'messages.get') {
      const id = String(params['id'] ?? '');
      const full = FULL_MESSAGES[id];
      if (!full) {
        return Promise.reject(new Error(`gws fixture: no message "${id}" (simulated 404)`));
      }
      if (params['format'] === 'metadata') {
        return Promise.resolve(toMetadataResource(full));
      }
      return Promise.resolve(full);
    }

    return Promise.reject(new Error(`gws fixture: unsupported call "${method}"`));
  };
}

function lookupThread(id: string): string | undefined {
  const m = FULL_MESSAGES[id] as { threadId?: string } | undefined;
  return m?.threadId;
}

/**
 * The provider-neutral expectations the contract harness asserts against, built
 * to match these gws fixtures (same address + same ids as the recorded JSON).
 * Bodies are filled so the harness's "full record carries a non-empty body"
 * assertion holds after the adapter decodes them.
 */
export const GWS_CONTRACT_FIXTURES: MailSourceFixtures = {
  address: ADDRESS,
  messages: LIST_ORDER.map((id) => {
    const m = FULL_MESSAGES[id] as {
      threadId?: string;
      labelIds?: string[];
      payload?: { mimeType?: string };
    };
    // Minimal stand-in record: the harness only reads id/labels/address breadth
    // and that getFull yields a body; the adapter produces the authoritative
    // values. Bodies left null here — the harness sources bodies from the
    // adapter (via the runner), not from this expectation bundle.
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
