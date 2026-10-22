# 2.14.3

Fixes from production use: Lever job descriptions that were missing most of the posting, and agent attribution on listing corrections. No database migration; rollback is image-only.

- **Lever JDs are complete.** A Lever posting's JD is now its description plus every `lists` section (responsibilities, requirements, bonus points) and the `additional` closing. Before, when `descriptionPlain` was present it was used on its own, which on many boards is only the company intro, so triage scored a JD with no duties, stack or pay.
- **Lever workplace.** Lever's `workplaceType` (`remote`, `hybrid`, `onSite`) is carried on single postings and board listings. A structured `remote` outranks a text reading such as an office clause for residents of one metro area, so those postings no longer come out `hybrid`.
- **Attribution.** `update_position` accepts an `actor` argument, as `set_position_status` already did, and records `<actor> via <token>` on edits and workplace/geo overrides. Callers that share a token no longer show up as the token name.

**Expect after upgrading:** the next watch check or `refresh_jd` of an existing Lever position stores a longer JD as a material change, and the position may be re-triaged against it. Re-triage stays within the daily triage cap.
