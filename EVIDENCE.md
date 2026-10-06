# Evidence: earlier-messages bar in a crewmate DM (PR #16539, issue #16877)

Frames captured from the real built SPA of the PR head `add2bacaa444069c410ae4f75a66c5d36eb6680a`, gateway-free
(`website/scripts/lib/stub-dashboard-api.mjs` + `serve-dist.mjs`), at 1280x800 on the Crewmates (Members) page.

The crewmate thread holds 120 rows. The first slot read answers the newest 20 with `has_more: true`; a `before=` read
answers the 60 rows below the cursor. The DM's slot is made the chat store's active slot first (opened on the Sessions
page), then the app navigates in place to Crewmates, which is the case the PR changes.

| frame | state |
|---|---|
| `*-idle.png` | older history exists: the bar is shown above the oldest loaded turn |
| `*-loading.png` | the older read is in flight: `aria-busy=true` |
| `*-failed.png` | the older read failed: "Couldn't load earlier messages" + Retry |
| `*-loaded.png` | the older page has loaded above; the reader's place is kept (the anchor row stayed at y=156 before and after) |

`capture-crewmate-dm-earlier.mjs` is the harness that produced them (run from `website/` against a built `dist`).
