# 100 inbox questions — mail-index vs a stock Gmail-API MCP (token cost)

Tokens an agent's context pays to **answer** each question. Account `personal` · token count: chars/4 (approx — set ANTHROPIC_API_KEY for exact Claude counts) · reproduce: `node bench/run.mjs --suite inbox100`.

**Fixed schema tax** (every turn): mail-index 1816 tok (18 tools) · stock Gmail MCP 1367 tok (14 tools).

## 1. Retrieval & refinding — find a known item

| Use case | mail-index (calls / tok) | Gmail MCP (calls / tok) | Savings |
|---|--:|--:|--:|
| a message from a sender about a topic | 1 / 580 | 4 / 6,190 | 10.7× |
| the latest attachment someone sent | 1 / 582 | 4 / 7,968 | 13.7× |
| a half-remembered message by a phrase | 1 / 584 | 4 / 5,573 | 9.5× |
| the most recent message in a project thread | 1 / 601 | 4 / 6,575 | 10.9× |
| a contract / PDF someone sent | 1 / 589 | 4 / 6,397 | 10.9× |
| a login code / verification link | 1 / 604 | 4 / 5,657 | 9.4× |
| a confirmation / reference number | 1 / 590 | 4 / 5,468 | 9.3× |
| someone's new address / phone / bank details | 1 / 580 | 4 / 5,177 | 8.9× |
| everything from a frequent sender (recent) | 1 / 23,678 | 1 / 8 | 0.0× |
| the video-call link for a meeting | 1 / 622 | 4 / 5,986 | 9.6× |
| a discount / promo code I never used | 1 / 579 | 4 / 7,402 | 12.8× |
| the newsletter issue mentioning a topic | 1 / 561 | 4 / 5,608 | 10.0× |
| the wifi / building / gate code | 1 / 548 | 4 / 5,431 | 9.9× |
| directions / parking info for an event | 1 / 622 | 4 / 5,359 | 8.6× |
| a resume / job description / offer letter | 1 / 580 | 4 / 5,170 | 8.9× |
| a thread I starred / flagged | 1 / 591 | 3 / 4,046 | 6.8× |
| a shared Drive / Dropbox doc link | 1 / 620 | 4 / 5,520 | 8.9× |
| a recommendation someone emailed (book/tool) | 1 / 546 | 4 / 6,529 | 12.0× |
| **subtotal (18)** | **33,657** | **100,064** | **3.0×** |

## 2. Finance, invoices & purchases

| Use case | mail-index (calls / tok) | Gmail MCP (calls / tok) | Savings |
|---|--:|--:|--:|
| the invoice from a vendor for a month | 1 / 588 | 4 / 5,510 | 9.4× |
| every invoice / receipt in a quarter | 1 / 23,149 | 201 / 374,024 | 16.2× |
| total spend at a vendor over months | 1 / 22,758 | 201 / 368,624 | 16.2× |
| all receipts for an expense report | 1 / 22,962 | 201 / 370,249 | 16.1× |
| the bill/statement from a utility or bank | 1 / 538 | 4 / 5,317 | 9.9× |
| subscriptions I'm paying for (renewals) | 1 / 23,363 | 201 / 374,899 | 16.0× |
| recurring charges renewing in 30 days | 1 / 4,399 | 39 / 69,088 | 15.7× |
| a payment confirmation for a purchase | 1 / 555 | 4 / 4,749 | 8.6× |
| the status of a refund | 1 / 585 | 4 / 5,420 | 9.3× |
| a credit-card / bank statement attachment | 1 / 601 | 4 / 4,557 | 7.6× |
| tax documents this year (1099 / receipts) | 1 / 23,108 | 201 / 379,849 | 16.4× |
| warranty / proof of purchase for a product | 1 / 602 | 4 / 6,163 | 10.2× |
| a project/contractor's total cost across invoices | 1 / 23,557 | 88 / 152,557 | 6.5× |
| unpaid / overdue invoices in my inbox | 1 / 22,914 | 37 / 78,673 | 3.4× |
| **subtotal (14)** | **169,679** | **2,199,679** | **13.0×** |

## 3. Logistics, travel & deliveries

| Use case | mail-index (calls / tok) | Gmail MCP (calls / tok) | Savings |
|---|--:|--:|--:|
| my next flight (time / terminal / code) | 1 / 585 | 4 / 5,925 | 10.1× |
| summarize my whole upcoming trip | 2 / 2,167 | 2 / 11,072 | 5.1× |
| my hotel reservation (address / check-in) | 1 / 621 | 4 / 5,218 | 8.4× |
| my car-rental / train / bus booking | 1 / 582 | 4 / 4,246 | 7.3× |
| the status of an order from a retailer | 1 / 556 | 4 / 6,166 | 11.1× |
| a package tracking number and carrier | 1 / 590 | 4 / 4,616 | 7.8× |
| everything due to be delivered this week | 1 / 23,270 | 1 / 8 | 0.0× |
| the boarding pass / e-ticket for a flight | 1 / 585 | 4 / 6,257 | 10.7× |
| whether a flight changed or got cancelled | 1 / 572 | 4 / 5,853 | 10.2× |
| seat / baggage / class info on a booking | 1 / 575 | 4 / 4,317 | 7.5× |
| all confirmations for an event / conference | 1 / 23,716 | 201 / 318,274 | 13.4× |
| rental / Airbnb check-in instructions | 1 / 590 | 4 / 5,624 | 9.5× |
| my schedule of reservations next weekend | 1 / 23,699 | 1 / 8 | 0.0× |
| event tickets (concert / game / theater) | 1 / 605 | 4 / 5,567 | 9.2× |
| **subtotal (14)** | **78,713** | **383,151** | **4.9×** |

## 4. Summarization & catch-up

| Use case | mail-index (calls / tok) | Gmail MCP (calls / tok) | Savings |
|---|--:|--:|--:|
| summarize this thread / where it stands | 2 / 699 | 2 / 15,255 | 21.8× |
| what decisions were made in this thread | 2 / 1,525 | 2 / 35,038 | 23.0× |
| what actions were suggested / assigned | 2 / 2,615 | 2 / 20,440 | 7.8× |
| TL;DR a long thread before I reply | 2 / 727 | 2 / 15,255 | 21.0× |
| what did I miss while away | 1 / 18 | 201 / 390,724 | 21706.9× |
| everything from a person this week | 1 / 23,096 | 1 / 8 | 0.0× |
| key points in a long email to act on | 2 / 1,367 | 2 / 26,700 | 19.5× |
| digest of today's inbox by priority | 1 / 18 | 61 / 117,223 | 6512.4× |
| latest in a project thread since a date | 2 / 3,466 | 2 / 26,700 | 7.7× |
| summarize the back-and-forth, what's unresolved | 2 / 473 | 2 / 49,993 | 105.7× |
| which emails this week need a response | 1 / 18 | 201 / 402,874 | 22381.9× |
| boil a newsletter down to one topic | 2 / 538 | 2 / 34,320 | 63.8× |
| **subtotal (12)** | **34,560** | **1,134,530** | **32.8×** |

## 5. Commitments, follow-ups & waiting-on

| Use case | mail-index (calls / tok) | Gmail MCP (calls / tok) | Savings |
|---|--:|--:|--:|
| what did I promise to do this week | 1 / 18 | 10 / 3,551 | 197.3× |
| who is waiting on a reply from me | 1 / 18 | 201 / 390,724 | 21706.9× |
| what am I waiting on from other people | 1 / 18 | 17 / 6,303 | 350.2× |
| threads gone silent I should follow up on | 1 / 23,289 | 33 / 56,189 | 2.4× |
| whether someone got back to me on a topic | 1 / 596 | 4 / 5,771 | 9.7× |
| open action items buried in email | 1 / 18 | 201 / 390,724 | 21706.9× |
| deadlines mentioned in recent mail | 1 / 23,450 | 16 / 32,220 | 1.4× |
| whether I confirmed / replied to an invite | 1 / 578 | 4 / 5,745 | 9.9× |
| commitments to a client I haven't delivered | 1 / 22,750 | 15 / 6,425 | 0.3× |
| emails I'm CC'd on that expect something | 1 / 23,543 | 201 / 390,724 | 16.6× |
| follow-ups I said I'd send 'next week' | 1 / 23,089 | 1 / 8 | 0.0× |
| unanswered questions directed at me | 1 / 22,629 | 32 / 51,322 | 2.3× |
| **subtotal (12)** | **139,996** | **1,339,706** | **9.6×** |

## 6. Scheduling & appointments

| Use case | mail-index (calls / tok) | Gmail MCP (calls / tok) | Savings |
|---|--:|--:|--:|
| my appointment with someone (when / where) | 1 / 632 | 4 / 7,775 | 12.3× |
| meetings confirmed by email this week | 1 / 23,761 | 1 / 8 | 0.0× |
| the thread where we settled on a meeting time | 1 / 603 | 4 / 5,612 | 9.3× |
| the dial-in / link for an appointment | 1 / 584 | 4 / 5,986 | 10.3× |
| whether a date got finalized for an event | 1 / 625 | 4 / 6,247 | 10.0× |
| cross-check invitations vs my calendar | 1 / 18 | 85 / 176,928 | 9829.3× |
| a reschedule / cancellation notice | 1 / 577 | 4 / 4,723 | 8.2× |
| agenda / pre-read for an upcoming meeting | 2 / 446 | 2 / 42,716 | 95.8× |
| **subtotal (8)** | **27,246** | **249,995** | **9.2×** |

## 7. Relationship & cross-thread context

| Use case | mail-index (calls / tok) | Gmail MCP (calls / tok) | Savings |
|---|--:|--:|--:|
| what I agreed with a client (pricing / scope) | 1 / 23,324 | 201 / 374,074 | 16.0× |
| summarize my history with a contact | 1 / 2,301 | 201 / 390,724 | 169.8× |
| the last thing a person and I discussed | 1 / 567 | 4 / 5,605 | 9.9× |
| who do I correspond with most | 1 / 2,301 | 201 / 390,724 | 169.8× |
| what a person committed to in past emails | 1 / 22,199 | 201 / 390,724 | 17.6× |
| context before a call with a contact | 1 / 18 | 201 / 390,724 | 21706.9× |
| status of a deal across all threads | 1 / 23,593 | 201 / 390,674 | 16.6× |
| whether a person mentioned a topic to me | 1 / 23,309 | 201 / 390,724 | 16.8× |
| open issues between me and a vendor | 1 / 23,815 | 201 / 373,349 | 15.7× |
| every email referencing a project / case number | 1 / 22,793 | 201 / 390,724 | 17.1× |
| history of complaints / requests from a customer | 1 / 23,852 | 201 / 314,874 | 13.2× |
| which companies I have back-and-forth with | 1 / 2,301 | 201 / 402,874 | 175.1× |
| **subtotal (12)** | **170,373** | **4,205,794** | **24.7×** |

## 8. Account, security, admin & grounded replies

| Use case | mail-index (calls / tok) | Gmail MCP (calls / tok) | Savings |
|---|--:|--:|--:|
| the latest password-reset / 2FA / alert | 1 / 549 | 4 / 4,761 | 8.7× |
| accounts with suspicious-login notices | 1 / 22,151 | 194 / 367,823 | 16.6× |
| a terms-of-service / privacy update | 1 / 578 | 4 / 4,700 | 8.1× |
| renewals / expirations coming up (domain / license) | 1 / 22,743 | 152 / 301,655 | 13.3× |
| the welcome email with account details | 1 / 565 | 4 / 5,982 | 10.6× |
| draft a reply grounded in the thread | 2 / 546 | 2 / 15,252 | 27.9× |
| write a follow-up referencing the last exchange | 2 / 385 | 2 / 19,453 | 50.5× |
| whether a sender emailed me before | 1 / 594 | 4 / 5,602 | 9.4× |
| whether an email is likely phishing / spam | 1 / 22,674 | 171 / 354,399 | 15.6× |
| senders I never open (unsubscribe candidates) | 1 / 2,301 | 201 / 404,049 | 175.6× |
| **subtotal (10)** | **73,086** | **1,483,676** | **20.3×** |

## Overall (100 inbox questions)

| | mail-index | Gmail MCP | Savings |
|---|--:|--:|--:|
| total tokens to answer | **727,310** | **11,096,595** | **15.3×** |

> Gmail cost model (generous to Gmail): recall = list + top-3 metadata gets; read = 1 full get; aggregate/relational = list + one *metadata* get per match (sampled avg × match count; full payloads are ~2.5× heavier). Gmail `list` returns ids only, so every match must be fetched to be read. Relational tasks (top contacts, "what did I miss") have no Gmail primitive — the agent must scan + aggregate the mailbox; mail-index answers from precomputed structure in one compact call. Match counts cap at the Gmail API page size, so large aggregations are *under*-counted for Gmail.
