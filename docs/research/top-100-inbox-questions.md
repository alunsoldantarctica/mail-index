# Top 100 inbox questions an LLM should answer over your mail

What people actually try to answer *inside their inbox* — the recurring lookups,
syntheses, and "wait, what did we decide?" questions — distilled into 100
concrete prompts an agent could field against an indexed mailbox.

Each is tagged by where the value comes from:

- **[R]** — *retrieval / structured lookup.* Find or extract a known item. Often
  solvable without an LLM (a tracking chip, a `category:purchases` filter), but
  the agent still has to locate it from a vague ask.
- **[S]** — *synthesis.* Requires reading across one or many messages and
  composing an answer that no single field or search result contains. This is
  where an LLM is irreducible — and where a query-based Gmail/Outlook search has
  no primitive at all (see [COMPARISON.md](../COMPARISON.md)).

> **These 100 are a runnable benchmark suite.** Each question is encoded as a
> PII-free generic query in [`bench/run.mjs`](../../bench/run.mjs) and scored for
> tokens-to-answer (mail-index vs a stock Gmail-API MCP) via
> `node bench/run.mjs --suite inbox100`. See [`bench/README.md`](../../bench/README.md).

> **Why these categories?** They are the ones the research below independently
> converges on. Email search is ~95% refinding/known-item lookup (not topic
> exploration); the highest-frequency structured needs are invoices, receipts,
> tracking, flights, appointments, and banking; and the most-cited *AI* email
> task across Gmail, Microsoft Copilot, and Superhuman is summarizing a thread
> to surface **decisions made** and **actions suggested**. Full evidence +
> sources at the end.

---

## 1 · Retrieval & refinding — find a specific known item (18)

The dominant mode of email search. The agent's job is to bridge a fuzzy
human description ("that thing from the landlord") to the right message.

1. [R] Find the email from [person/company] about [topic].
2. [R] What was the attachment [name] sent me last month? Pull the latest version.
3. [S] I remember an email about "[half-remembered phrase]" — which one is it?
4. [R] Find the most recent message in the [project/client] thread.
5. [R] Where's the PDF/contract/spreadsheet someone sent me a while ago?
6. [R] Find the email with the login code / verification link / password reset.
7. [R] What's the confirmation/reference number from [service]?
8. [S] Find the email where [person] gave me their new address / phone / IBAN.
9. [R] Show me everything from [domain] in the last [N] weeks.
10. [R] Find the email that had the Zoom/Meet/Teams link for [meeting].
11. [S] Which email had the discount/promo code I never used?
12. [R] Find the newsletter issue that mentioned [topic].
13. [R] Where's the email with the wifi password / building code / gate code?
14. [S] I got an email with directions/parking info for [event] — find it.
15. [R] Find the resume / job description / offer letter I was sent.
16. [R] Locate the email thread I starred / flagged about [topic].
17. [S] Find the email where someone shared a doc/Drive/Dropbox link to [thing].
18. [S] What was that recommendation [person] emailed me — restaurant, book, tool?

## 2 · Finance, invoices & purchases (14)

The single most-named structured retrieval need. Heavy synthesis value when
the ask spans many senders or a date range.

19. [R] Find the invoice from [vendor] for [month/order].
20. [S] List every invoice/receipt I received in [Q/month/year].
21. [S] Total up what I spent at [vendor] over the last [N] months.
22. [S] Pull together all my receipts for an expense report for [trip/project].
23. [R] Find the bill/statement from [utility/bank/card] for [period].
24. [S] Which subscriptions am I paying for? Find the renewal emails.
25. [S] What recurring charges renew in the next 30 days? (price + date)
26. [R] Find the payment confirmation for [purchase].
27. [S] Did I get a refund for [order]? What's its status?
28. [R] Find the credit-card / bank statement attachment for [month].
29. [S] List all tax-relevant documents (1099s, donation receipts, etc.) this year.
30. [R] Find the warranty / proof-of-purchase email for [product].
31. [S] What did this project/contractor cost me in total across their invoices?
32. [S] Which invoices are unpaid or overdue based on what's in my inbox?

## 3 · Logistics, travel & deliveries (14)

Google and Gmail built dedicated infrastructure (Search reservation cards,
package tracking chips, a Purchases tab) precisely because these are so frequent.

33. [R] When is my next flight? Departure time, terminal, confirmation code.
34. [S] Summarize my whole upcoming trip to [place] from my inbox (flights, hotel, car).
35. [R] What's my hotel reservation for [dates/city]? Address + check-in time.
36. [R] Find my car-rental / train / bus booking for [trip].
37. [S] What's the status of my order from [retailer]?
38. [R] Where's my package — what's the tracking number and carrier?
39. [S] List everything that's supposed to be delivered this week.
40. [R] Find the boarding pass / e-ticket for [flight].
41. [S] Did my flight get changed or cancelled? What's the new itinerary?
42. [R] What's the seat / baggage / class info on my booking?
43. [S] Pull all confirmations for [event/conference] — registration, travel, lodging.
44. [R] Find the rental agreement / Airbnb check-in instructions.
45. [S] What's my full schedule of reservations for next weekend?
46. [R] Find the email with the event tickets (concert, game, theater).

## 4 · Summarization & catch-up (12)

The most-cited AI email use case. Surfacing *decisions* and *actions* from long
threads is the canonical example given by Microsoft, Gmail, and Superhuman.

47. [S] Summarize this thread — what's it about and where does it stand?
48. [S] What decisions were made in this thread?
49. [S] What actions were suggested / assigned, and to whom?
50. [S] TL;DR this 40-message thread before I reply.
51. [S] What did I miss while I was away? Catch me up on important mail.
52. [S] Summarize everything from [person/client] this week.
53. [S] What are the key points in this long email I need to act on?
54. [S] Give me a digest of today's inbox grouped by priority.
55. [S] What's the latest in the [project] thread since [date]?
56. [S] Summarize the back-and-forth and tell me what's still unresolved.
57. [S] Which emails this week actually need a response from me?
58. [S] Boil this newsletter / report email down to the parts relevant to [topic].

## 5 · Commitments, follow-ups & waiting-on (12)

What you owe, what's owed to you, and what's gone quiet — pure cross-message
synthesis with no native search equivalent.

59. [S] What did I promise to do in my emails this week?
60. [S] Who is waiting on a reply from me?
61. [S] What am I waiting on from other people?
62. [S] Which threads have gone silent that I should follow up on?
63. [S] Did [person] ever get back to me about [topic]?
64. [S] What are my open action items buried in email?
65. [S] What deadlines are mentioned in my recent mail?
66. [S] Did I ever confirm / reply to [invitation / request]?
67. [S] List commitments I made to [client] that I haven't delivered.
68. [S] Which emails am I CC'd on that actually expect something from me?
69. [S] What follow-ups did I say I'd send "next week" that are now due?
70. [S] Are there any unanswered questions directed at me in my threads?

## 6 · Scheduling & appointments (8)

71. [R] When is my appointment with [person/place]? Date, time, location.
72. [S] What meetings do I have confirmed by email this week?
73. [S] Find the back-and-forth where we settled on a time for [meeting].
74. [R] What's the dial-in / address / link for [upcoming appointment]?
75. [S] Did we ever finalize a date for [event], or is it still being scheduled?
76. [S] Cross-check my email invitations against my calendar — anything missing?
77. [R] Find the reschedule / cancellation notice for [appointment].
78. [S] What's the agenda or pre-read for [upcoming meeting] from the invite thread?

## 7 · Relationship & cross-thread context (12)

The "what did we agree?" questions — the strongest case for LLM synthesis,
and structurally impossible for query-based search to answer.

79. [S] What did I agree to with [client] about pricing / scope / terms?
80. [S] Summarize my entire relationship/history with [contact].
81. [S] What's the last thing [person] and I discussed?
82. [S] Who do I correspond with most / who are my key contacts?
83. [S] What did [person] commit to in our past emails?
84. [S] Catch me up before this call — what's the context with [contact/company]?
85. [S] What's the status of my deal/dedeal with [company] across all threads?
86. [S] Has [person] ever mentioned [topic] to me? What did they say?
87. [S] What are the open issues between me and [client/vendor]?
88. [S] Pull every email referencing [project/contract/case number].
89. [S] What's the history of complaints/requests from [customer]?
90. [S] Did [person] and I ever agree on [specific detail]? Quote the email.

## 8 · Account, security, admin & grounded replies (10)

Lower-volume but high-stakes, plus the "writing" task that needs your own mail
as context.

91. [R] Find the latest password-reset / 2FA / security-alert email from [service].
92. [S] Which accounts have flagged suspicious logins or security notices recently?
93. [R] Find the terms-of-service / privacy-policy update from [company].
94. [S] What renewals, expirations, or required actions are coming up (domains, licenses, IDs)?
95. [R] Find the onboarding / welcome email with my account details for [service].
96. [S] Draft a reply to this email grounded in what we agreed earlier in the thread.
97. [S] Write a follow-up to [person] referencing our last exchange.
98. [S] Has this sender emailed me before, and what was the prior context?
99. [S] Is this email likely phishing/spam given the sender's history with me?
100. [S] Unsubscribe candidates — which senders do I never open or reply to?

---

## How this list was built (research + verification)

Produced by a fan-out deep-research workflow (Sonnet agents): 5 search angles →
26 sources fetched → 100 claims extracted → 3-vote adversarial verification (≥2/3
refutes kills a claim) → synthesis. 9 of 25 top-ranked claims survived; the
categories above are the ones the surviving evidence supports.

### Verified findings (high/medium confidence)

- **Email search is ~95% refinding/known-item lookup, not topic exploration.**
  Diary study (Elsweiler & Ruthven 2007, n=36, 3 weeks) + large-scale Outlook
  query-log analysis (Ai et al. 2017, 711k users, ~2M queries/week), via
  [arxiv.org/pdf/2412.12330](https://arxiv.org/pdf/2412.12330). *(high)*
- **Top structured retrieval needs, named unprompted by survey respondents:**
  invoices/bills, order receipts, shipping tracking, parcel status, flight
  confirmations, appointments, banking — [ZeroBounce, n=1,091](https://www.zerobounce.net/email-statistics-report). *(medium)*
- **Thread summarization to surface decisions + suggested actions is the most
  prominently cited AI email use case** by a major vendor — [Microsoft Copilot
  in Outlook (Microsoft Learn)](https://learn.microsoft.com/en-us/training/modules/summarize-simplify-information-with-microsoft-copilot-microsoft-365/6-catch-up-prepare-week-copilot-outlook). *(high)*
- **The four canonical AI email tasks — writing, summarizing, replying,
  searching** — per [Superhuman](https://www.producthunt.com/products/superhuman)
  (marketing copy; pre-Grammarly-acquisition). *(medium)*
- **Travel logistics is high-frequency structured retrieval:** Google Search
  surfaces 4 Gmail reservation types (hotel/flight/car/bus-train) and Gmail ships
  in-inbox package tracking — [Google support](https://support.google.com/websearch/answer/1710607),
  [package tracking coverage](https://www.foxnews.com/tech/gmail-adding-package-tracking-feature-ahead-holiday-shopping-season). *(high)*
- **Purchase/finance retrieval is a distinct first-class need:** Gmail's hidden
  `category:purchases` operator classifies receipts, invoices, statements,
  downloads — [labnol](https://www.labnol.org/find-receipts-invoices-purchases-in-gmail-251119). *(high)*

### Caveats

Source quality is mixed — the two strongest claims rest on peer-reviewed
research; others on vendor marketing and a commercial survey. The Outlook
log analysis is enterprise-only and may not generalize to consumer Gmail. The
survey identifies categories but not their relative frequency. Several plausible
claims (semantic-search demand, productivity-cost dollar figures, search-UX
frustration) were **refuted** for lack of credible primary sourcing — they may
still be true but aren't substantiated here.

### Open questions (not answered by the research)

1. **Relative frequency ranking** across the 8 categories — which tasks are 10×
   more common than others?
2. **Where is LLM synthesis irreducible** vs. addressable by structured
   extraction (regex tracking numbers, schema.org flight markup)? The **[S]**
   tags above are Claude's judgment, not measured.
3. **Consumer vs. enterprise** behavior differences (strongest evidence is
   enterprise Outlook).
4. **What share of top retrieval tasks need cross-thread synthesis** ("what did I
   agree across 6 months") vs. single-email lookup — the former is mail-index's
   sweet spot.
