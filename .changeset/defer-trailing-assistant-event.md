---
"@koed/koed": patch
---

Fix two historical-onboarding correctness bugs found in review: a recently active Conversation whose final JSONL record exceeds the transcript-activity scan window no longer gets wrongly excluded by the 30-day cutoff (it read the transcript's creation time instead of the record's own timestamp), and a trailing agent_message with no response_item yet in view is now deferred across historical batches instead of being committed as its own item, preventing a duplicate projected representation of the same assistant turn once the response_item arrives.
