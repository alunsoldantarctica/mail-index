/**
 * Recorded `MailSource` fixtures (SCOPE 0.3, PLAN §19 "recorded fixtures, no
 * live network"). A small, hand-authored set of provider-neutral records that
 * exercise the contract: one direct (human-to-human) message, one list/
 * newsletter, and one Sent message (D11). Field shapes mirror
 * {@link MessageFull} from `../index.ts`.
 *
 * These back both the reusable contract suite (`../contract.ts`) and the
 * in-memory fake (`../fake.ts`). They contain no real personal data — synthetic
 * addresses on `example.com` / `example.org`.
 */

import type { MessageFull } from '../index.js';

/** Bundle a fixture set into the shape the contract harness consumes. */
export interface MailSourceFixtures {
  /** The authenticated mailbox these fixtures belong to (probe expectation). */
  address: string;
  /** Full records, in newest-first order (as `listIds` should yield them). */
  messages: MessageFull[];
}

/** A direct, human-to-human message (a Correspondent reply). */
export const DIRECT_MESSAGE: MessageFull = {
  id: 'fixt-direct-1',
  threadId: 'thread-direct-1',
  internalDate: 1_717_000_000_000, // 2024-05-29T...Z
  dateHeader: 'Wed, 29 May 2024 18:26:40 +0000',
  from: 'Jordan Partner <jordan@partner.example.com>',
  to: 'Al Operator <al@example.com>',
  cc: null,
  subject: 'Re: Deposit terms for the Antarctica charter',
  labels: ['INBOX', 'IMPORTANT', 'CATEGORY_PERSONAL'],
  snippet: 'Confirming the 20% deposit is due Friday — wire details below.',
  sizeEstimate: 4096,
  bodyText:
    'Hi Al,\n\nConfirming the 20% deposit is due Friday. Wire details below.\n\n' +
    'Best,\nJordan\n\n> On Tue, Al wrote:\n> Can you confirm the deposit schedule?',
  bodyHtml: null,
  mimeType: 'text/plain',
};

/** A list/newsletter message (List-* headers → is_list in classification). */
export const LIST_MESSAGE: MessageFull = {
  id: 'fixt-list-1',
  threadId: 'thread-list-1',
  internalDate: 1_716_900_000_000,
  dateHeader: 'Tue, 28 May 2024 14:40:00 +0000',
  from: 'Expedition Weekly <news@bulletin.example.org>',
  to: 'subscribers@bulletin.example.org',
  cc: null,
  subject: 'This week in polar logistics',
  labels: ['INBOX', 'CATEGORY_UPDATES', 'UNREAD'],
  snippet: 'Top stories: new zodiac schedules, ice-class vessel availability…',
  sizeEstimate: 28_672,
  headers: {
    'List-Id': 'Expedition Weekly <news.bulletin.example.org>',
    'List-Unsubscribe': '<https://bulletin.example.org/unsubscribe>',
  },
  bodyText: null,
  bodyHtml:
    '<html><body><h1>This week in polar logistics</h1>' +
    '<p>Top stories: new zodiac schedules, ice-class vessel availability.</p>' +
    '<a href="https://bulletin.example.org/unsubscribe">Unsubscribe</a>' +
    '</body></html>',
  mimeType: 'text/html',
};

/** A message the user sent (D11 — Sent metadata is indexed). */
export const SENT_MESSAGE: MessageFull = {
  id: 'fixt-sent-1',
  threadId: 'thread-direct-1',
  internalDate: 1_716_800_000_000,
  dateHeader: 'Mon, 27 May 2024 10:53:20 +0000',
  from: 'Al Operator <al@example.com>',
  to: 'Jordan Partner <jordan@partner.example.com>',
  cc: null,
  subject: 'Re: Deposit terms for the Antarctica charter',
  labels: ['SENT', 'CATEGORY_PERSONAL'],
  snippet: 'Can you confirm the deposit schedule?',
  sizeEstimate: 2048,
  bodyText: 'Can you confirm the deposit schedule?\n\nThanks,\nAl',
  bodyHtml: null,
  mimeType: 'text/plain',
};

/** The default fixture set used by the contract test. Newest-first. */
export const DEFAULT_FIXTURES: MailSourceFixtures = {
  address: 'al@example.com',
  messages: [DIRECT_MESSAGE, LIST_MESSAGE, SENT_MESSAGE],
};
