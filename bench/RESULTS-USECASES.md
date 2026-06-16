# 30 common use cases — mail-index vs a stock Gmail-API MCP (token cost)

Tokens an agent's context pays to **answer** each question. Account `personal` · token count: chars/4 (approx — set ANTHROPIC_API_KEY for exact Claude counts) · reproduce: `node bench/run.mjs`.

**Fixed schema tax** (every turn): mail-index 1816 tok (18 tools) · stock Gmail MCP 1367 tok (14 tools).

## A. Aggregation — "list all …" (read every match)

| Use case | mail-index (calls / tok) | Gmail MCP (calls / tok) | Savings |
|---|--:|--:|--:|
| all supplier / vendor emails (6mo) | 1 / 22,448 | 201 / 417,424 | 18.6× |
| all purchases & receipts (6mo) | 1 / 22,374 | 201 / 342,474 | 15.3× |
| all invoices received (6mo) | 1 / 22,417 | 201 / 356,724 | 15.9× |
| all newsletters / subscriptions (6mo) | 1 / 22,431 | 201 / 362,024 | 16.1× |
| all meetings / calendar invites (6mo) | 1 / 22,484 | 201 / 394,474 | 17.5× |
| all travel / flight / hotel confirmations (6mo) | 1 / 22,444 | 201 / 346,049 | 15.4× |
| all shipping / delivery notifications (6mo) | 1 / 22,450 | 201 / 404,549 | 18.0× |
| all bank / financial statements (6mo) | 1 / 22,358 | 201 / 341,499 | 15.3× |
| all recruiter / job emails (6mo) | 1 / 22,472 | 201 / 422,924 | 18.8× |
| all customer-support threads (6mo) | 1 / 22,467 | 201 / 352,524 | 15.7× |
| all password-reset / security alerts (6mo) | 1 / 22,276 | 201 / 375,624 | 16.9× |
| all event invitations (6mo) | 1 / 22,565 | 201 / 332,074 | 14.7× |
| all subscription / recurring charges (6mo) | 1 / 22,462 | 201 / 379,374 | 16.9× |
| everything about insurance (6mo) | 1 / 22,568 | 201 / 315,499 | 14.0× |
| all messages mentioning a contract (6mo) | 1 / 22,562 | 201 / 402,999 | 17.9× |
| **subtotal (15)** | **336,778** | **5,546,235** | **16.5×** |

## B. Recall — find one message

| Use case | mail-index (calls / tok) | Gmail MCP (calls / tok) | Savings |
|---|--:|--:|--:|
| a payment / account deposit confirmation | 1 / 556 | 4 / 5,230 | 9.4× |
| a security alert email | 1 / 567 | 4 / 5,998 | 10.6× |
| an event invitation | 1 / 580 | 4 / 5,396 | 9.3× |
| a refund notification | 1 / 584 | 4 / 7,339 | 12.6× |
| a recruiter / job-opportunity message | 1 / 590 | 4 / 4,578 | 7.8× |
| a recent order / dispatch confirmation | 1 / 582 | 4 / 5,630 | 9.7× |
| an appointment / booking confirmation | 1 / 576 | 4 / 6,293 | 10.9× |
| a news / market briefing | 1 / 547 | 4 / 4,389 | 8.0× |
| a payment receipt | 1 / 562 | 4 / 5,430 | 9.7× |
| a login / verification-code notice | 1 / 581 | 4 / 5,605 | 9.6× |
| **subtotal (10)** | **5,725** | **55,888** | **9.8×** |

## C. Read one message in full

| Use case | mail-index (calls / tok) | Gmail MCP (calls / tok) | Savings |
|---|--:|--:|--:|
| read the single most relevant invoice | 2 / 470 | 2 / 51,718 | 110.0× |
| read the latest order/shipping update | 2 / 772 | 2 / 16,336 | 21.2× |
| **subtotal (2)** | **1,242** | **68,054** | **54.8×** |

## D. Relational — contacts / "what did I miss" (no Gmail primitive)

| Use case | mail-index (calls / tok) | Gmail MCP (calls / tok) | Savings |
|---|--:|--:|--:|
| who do I correspond with most (top contacts) | 1 / 2,212 | 201 / 333,674 | 150.8× |
| which companies do I have back-and-forth with | 1 / 2,190 | 201 / 335,299 | 153.1× |
| catch me up on what I missed this week | 1 / 18 | 201 / 333,674 | 18537.4× |
| **subtotal (3)** | **4,420** | **1,002,647** | **226.8×** |

## Overall (30 use cases)

| | mail-index | Gmail MCP | Savings |
|---|--:|--:|--:|
| total tokens to answer | **348,165** | **6,672,824** | **19.2×** |

> Gmail cost model (generous to Gmail): recall = list + top-3 metadata gets; read = 1 full get; aggregate/relational = list + one *metadata* get per match (sampled avg × match count; full payloads are ~2.5× heavier). Gmail `list` returns ids only, so every match must be fetched to be read. Relational tasks (top contacts, "what did I miss") have no Gmail primitive — the agent must scan + aggregate the mailbox; mail-index answers from precomputed structure in one compact call. Match counts cap at the Gmail API page size, so large aggregations are *under*-counted for Gmail.
