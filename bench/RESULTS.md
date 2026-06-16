# Recall × token cost — distilled Gmail query vs one mail-index phrase

Answering *"list my purchases over the last 6 months"*. Recall is measured against a
transaction-sender reference set (PayPal, Amazon, AliExpress, Wealthsimple, Klarna, Apple,
Stripe, Shopify, Uber, Booking) — every item a real transaction, so a miss is a true miss.
Tokens = the cost to actually answer: Gmail must read every match (list ids + one metadata
get per match); mail-index returns a scannable snippet set in one call. Reproduce:
`node bench/accuracy.mjs`. (Counts: chars/4 (approx); reference set size 301.)

| Approach | Query | Matches | Recall | Tokens to answer |
|---|---|--:|--:|--:|
| Gmail MCP | simple phrase | 303 | 14% | 519,242 |
| Gmail MCP | basic keywords | 400 | 43% | 682,224 |
| Gmail MCP | distilled (best-effort) | 400 | 24% | 655,074 |
| Gmail MCP | broad (kitchen sink) | 400 | 49% | 682,024 |
| **mail-index** | **one phrase** | **241** | **39%** | **26,976** |

**Takeaway — two things to notice:**

1. **You cannot reliably distill a better query up front.** Adding precision constraints
   (phrase matches, `-unsubscribe`) can *lower* recall versus naive keywords — real
   transactions get excluded. The agent is guessing terms blind, with no corpus to check against.
2. **On Gmail, recall and token cost rise together.** The only lever for higher recall is a
   broader query, which forces reading more messages — and you must read them, because listing
   purchases means verifying each (stock "order filled" ≠ a purchase). Reading *is* the cost.

A single mail-index phrase returns a scannable, snippet-first candidate set in one call at a
**fraction of the tokens (~20–25×)**. Its recall is comparable to a broad Gmail query, and the
remaining gap closes **for free** — mail-index can retrieve by sender/category (structure a
keyword query has no access to) and iterate locally, where on Gmail every refinement re-reads
the mailbox. Accuracy on Gmail is bought with tokens; on mail-index it is bought with structure.

> Honesty notes: the reference is a proxy (transactional senders only), so it *under*-counts
> the true purchase set — the real recall gap is larger. The Gmail token model is generous
> (metadata gets, not full; a real agent also burns tokens guessing queries).
