# Sponsor Outreach for Google Sheets: setup and use

A Google Apps Script for student societies and other organisations that email firms about sponsorship. It researches contacts for free, drafts each email in Gmail from a template, sends it on a schedule, follows up in the same thread and keeps a log in your tracker. Nothing in it is tied to one organisation: your name, description and senders all live in the spreadsheet.

## What you get

| File | What it is |
|---|---|
| `Code.gs` | The whole script, including the free research bot |
| `InitialEmail.html` | A draft outreach email to rewrite in your own words (see Make the emails yours) |
| `FollowUp.html` | A draft follow up email to rewrite in your own words |
| `appsscript.json` | Project settings: United Kingdom (UK) time zone and the Gmail service switched on |

Your tracker's first row should start with these eight headers in columns A to H: Firm Name, Name of contact, Role, Email, Contacted by, Date Emailed, Status, Notes / Result. If no tab has them, setup creates a Tracker tab that does. Columns A to H stay exactly where they are, and setup adds:

| Col | Header | Who fills it |
|---|---|---|
| I | Draft email? | You: Yes builds the Gmail draft (becomes Drafted) |
| J | Send | You: Send now, 9am tomorrow, 9am Monday or Cancel scheduled send |
| K | Follow ups on | You (ticked automatically when the draft is made) |
| L | Days between follow ups | You (defaults to 7) |
| M | Note for next follow up | You: added above the signature of the next follow up, then cleared |
| N | Next step | Script: what happens next and when |
| O | Activity log | Script: newest first, for example Sent 02/11/26, Followed up 09/11/26, Bounce back detected |
| P | Personalised paragraph | Script, editable before drafting |
| Q | Research notes | Script: domain, email format, contacts with sources, and anything it rejected |
| R | Follow ups sent | Script |
| S, T, U | Thread ID, Draft ID, Next action at | Script (hidden) |

It also adds two tabs: **Outreach Settings** and **Outreach Senders**.

## The free research bot

Apps Script cannot search the internet by itself, so the bot uses two free services, both under your organisation's account and neither needing a card:

1. **Tavily** searches the web and returns the pages it finds. Free plan: 1,000 searches a month.
2. **Groq** runs a free artificial intelligence (AI) model that reads those pages, picks the contacts and writes the personalised paragraph.

The script does not simply trust the AI model. Before anything reaches the sheet:

1. Every email address is pulled off the pages by the script itself. An address only counts as published if it really appears on one of the pages.
2. Addresses at another organisation (for example a careers website or another society that lists the firm as a sponsor) are rejected.
3. A person's name is only written in column B if it appears in the search results.
4. A guessed address (marked pattern_guess) is rebuilt by the script from the firm's email format, only for a person named in the results, and only when the results back up that format.
5. Every relevant address that passes goes in the Email column, for example `recruitment@firm.co.uk, jane.smith@firm.com`, with published addresses first. Press, media, investor and sales mailboxes are never used. "Most email addresses per firm" on the settings tab sets the limit (3 by default). Everyone in the Email column receives the email, and the names of the people among them go in Name of contact.
6. Anything rejected is listed under "Not used" in Research notes, so you can see what was thrown out.

Each firm uses 5 searches (3 for contacts and 2 for the paragraph), so the free plan covers about 200 firms a month. The Groq free limits allow roughly 40 firms a day. When a limit is reached, the row goes back in the queue, Next step says "Waiting for the free research limit to reset", and it finishes by itself once the limit resets. Searches already made are reused for 6 hours, so a retry costs nothing.

## Make the emails yours

`InitialEmail.html` and `FollowUp.html` are plain drafts. Open them in the script editor and rewrite the sentences however you like; you can also add your logo with an `<img>` tag. Keep the words in double curly brackets, which the script fills in for each email:

| Placeholder | Filled with |
|---|---|
| `{{INTRO_GREETING}}`, `{{LETTER_GREETING}}`, `{{GREETING}}` | "Dear Sir/Madam" (or a first name, see the settings tab); the follow up uses "Dear <Firm> Team" |
| `{{FIRM_NAME}}`, `{{FIRM_POSSESSIVE}}` | The firm in column A, for example Acme and Acme’s |
| `{{PERSONALISED_PARAGRAPH}}` | Column P, written by the research bot |
| `{{ORG_NAME}}`, `{{ORG_DESCRIPTION}}`, `{{MEMBER_INTERESTS}}`, `{{ACADEMIC_YEAR}}` | The matching rows on the Outreach Settings tab |
| `{{SIGNATURE}}`, `{{SENDER_NAME}}`, `{{SENDER_TITLE_LINE}}` | The sender's details from the Outreach Senders tab |
| `{{EXTRA_NOTE}}` | Column M, only in the follow up |

`{{SIGNATURE}}` produces table rows, so keep it inside the `<table>` it sits in. The two example paragraphs in `Code.gs` (PARAGRAPH_EXAMPLES) set the style of the personalised paragraph; replace them with paragraphs your organisation has written.

## Before you start

1. **Use one shared Gmail account.** Do everything signed in as your organisation's shared Gmail account. Every email goes out from that account or its Send mail as aliases, whoever edits the sheet.
2. **Check that replies reach that inbox.** From a personal account, reply to an email sent from each alias and make sure it lands in the shared inbox. The script can only see this inbox. If replies go elsewhere, put the shared address in "Reply to address" on the settings tab.
3. **Free Tavily account.** Sign up at app.tavily.com with your organisation's email (no card) and copy the Application Programming Interface (API) key from the dashboard. It starts with tvly.
4. **Free Groq account.** Sign up at console.groq.com with your organisation's email (no card), open API Keys, create a key and copy it. It starts with gsk.
5. **Prospectus.** Put your sponsorship prospectus as a Portable Document Format (PDF) file in the shared account's Google Drive, or share it with that account, and copy its link.

## Install (about 10 minutes)

1. Open the tracker, then Extensions > Apps Script.
2. Project Settings (gear icon) > tick **Show "appsscript.json" manifest file in editor**. Back in the Editor, open `appsscript.json` and replace its contents with the file provided.
3. Open `Code.gs`, delete what is there, paste `Code.gs`.
4. Click **+** and choose the HyperText Markup Language (HTML) file option, name it `InitialEmail` (no extension) and paste `InitialEmail.html`. Do the same for `FollowUp`.
5. Save, then reload the spreadsheet tab. A **Sponsor Outreach** menu appears.
6. Sponsor Outreach > **Install or repair**. Approve the permissions (Google shows "Google hasn't verified this app": click Advanced > Go to project > Allow). If nothing happens after approving, click Install or repair again. If you already had an older version installed, this also tidies the settings tab (removes settings that no longer exist, refreshes the notes, adds new settings) without changing your values.
7. Sponsor Outreach > **Set Tavily key (free web search)**, then **Set Groq key (free AI model)**.
8. **Outreach Settings** tab: fill in Organisation name, One line about the organisation and What your members are interested in, check the Email subject and Academic year, and paste the prospectus link. **Outreach Senders** tab: replace the three example people with your own senders (name, Send mail as address, job title, and optionally phone and signature image link). Contacted by uses this list.
9. Optional: add **Replied** and **Bounced** to your Status dropdown, so the script can set them. It never removes your colours. If the dropdown has **Drafting**, the script sets it when a draft is made.
10. Sponsor Outreach > **Check setup**. Every line should start with OK.
11. Test with a row using your own personal email in column D before emailing a firm.

## Day to day

1. **Type the firm in column A.** Within 10 minutes the bot fills Email (every relevant address, separated by commas), contact names and roles (when it finds named people), the Personalised paragraph and Research notes. Check them before drafting, and delete any address you do not want to email.
2. **Pick Contacted by.**
3. **Set Draft email? to Yes.** The draft appears in Gmail Drafts with the prospectus attached and the sender's signature, addressed to everyone in the Email column. Status changes to Drafting. Edit the draft in Gmail if you like.
4. **Choose Send.** Send now, 9am tomorrow or 9am Monday. Cancel scheduled send undoes a schedule. Status changes to Sent & Waiting when it goes, also when you send it yourself from Gmail.
5. **Follow ups** go in the same thread at 9am UK time after the set number of days, skip weekends, and stop at the maximum (2 by default). Untick to stop. They only go while Status is **Sent & Waiting**.
6. **Sync with Gmail now** and **Process due sends now** (Sponsor Outreach menu) finish with a summary: what changed row by row, what is coming up, and which drafts are waiting for a Send choice. Sync only recognises emails sent from this Gmail account with the Season tag (26/27 by default) in the subject.

## Safety rules built in

26/27 below stands for the Season tag on the settings tab.

1. Never emails an address that already has a 26/27 email in Sent, whether the script or a person sent it. Checked when drafting and again right before sending. It also notes when someone else at the same firm was emailed.
2. Before the first email goes, the draft must be addressed to exactly the emails in column D, come from the person in Contacted by, mention the firm, carry the 26/27 subject and have the prospectus attached. If not, nothing is sent and Next step says why.
3. Follow ups go only to the original recipients who are still in column D, inside the original thread (the script finds it by the 26/27 subject), from the alias in Contacted by.
4. Follow ups stop for good when a reply arrives (in the thread or as a separate email from that address or about the partnership from the firm's domain) or a bounce back arrives. When an email went to several addresses and the bounce back names only one of them, only that address is dropped and follow ups carry on to the others. Out of office replies are logged but do not stop them.
5. Emails and follow ups sent by hand from the shared account (any alias) are picked up at the daily 7am sync: they count towards the maximum and restart the follow up clock.
6. Changing Status to anything other than Sent & Waiting (for example Sent Rejected) pauses follow ups immediately.
7. A scheduled first email more than a day late (for example during a Google outage) is not sent; it asks you to choose again.
8. Everything that sends runs under a lock, and Gmail itself is checked before every send, so two runs can never send the same email. If rows are sorted or inserted mid run, the script finds each row again by its thread before writing or sending.
9. Only the account that ran Install or repair can send. If someone reinstalls under another account, the old account's triggers switch themselves off.

## Good to know

1. Emails sent from someone's personal account are invisible to the script. Send from the shared account, or note it in the sheet.
2. Changed the paragraph, email or sender after drafting? Set Draft email? to Yes again. This rebuilds the same draft and replaces edits made in Gmail.
3. After a bounce, type a new address in column D: the old email is unlinked and you can draft again.
4. A firm already on the tracker is not researched twice (Research notes says which row). Use Sponsor Outreach > Research selected rows again to force it. Research only fills the Email column when it is empty, so clear it first if you want the new addresses. Rewrite paragraph for selected rows writes a new paragraph only.
5. Rows you already contacted are never emailed again by the script. If their earlier email is in this Gmail with 26/27 in the subject, the daily sync links it and logs it; tick Follow ups on for those rows if you want follow ups. Uncontacted rows with no email are researched after install; set "Research new firms automatically" to No first if you do not want that. A blank Status, Not Contacted and Drafting all count as not sent yet.
6. Limits for a free Gmail account: 100 email recipients a day (every address in the Email column counts, so 3 addresses use 3) and 90 minutes of background run time a day. The free research limits are above.
7. The keys are stored in the script's properties. Anyone with edit access to the sheet can open the script and see them, so keep edit access to the committee.
8. Fewer searches per firm (settings tab) stretches the free searches further; more searches find more contacts. Up to 5 searches for contacts and 3 for the paragraph are used; higher numbers count as those.
9. Next year, update Email subject, Season tag and Academic year on the settings tab.
