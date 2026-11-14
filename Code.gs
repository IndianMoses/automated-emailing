/**
 * SPONSOR OUTREACH AUTOMATION (TEMPLATE)
 * ======================================
 * Google Apps Script bound to a sponsorship tracker spreadsheet. Your organisation's name,
 * description and members' interests are set on the Outreach Settings tab, and the emails come
 * from the InitialEmail and FollowUp files, which you can rewrite in your own words.
 *
 * What it does
 *   1. Research   Type a firm in column A. A free research bot finds the best contacts, the
 *                 firm's email format and a personalised paragraph: Tavily searches the web and
 *                 a Groq AI model reads the results (both free accounts, no card). The script
 *                 checks every address against the pages it came from.
 *   2. Draft      Set "Draft email?" to Yes. A Gmail draft is created from the alias picked in
 *                 "Contacted by", with the prospectus attached and that person's signature.
 *   3. Send       Choose "Send now", "9am tomorrow" or "9am Monday" in the Send column.
 *   4. Follow up  Follow ups go out in the same thread at 9am UK time after the chosen number
 *                 of days, only while Status is "Sent & Waiting" and nobody has replied.
 *   5. Sync       Emails and follow ups sent by hand, replies and bounce backs are picked up
 *                 from Gmail and written to the Activity log.
 *
 * Install it while signed in to your organisation's shared Gmail account: every automatic
 * action runs as the account that ran "Install or repair".
 */

// ===== 1. Configuration =====================================================================

const APP = {
  MENU: 'Sponsor Outreach',
  TZ: 'Europe/London',
  DEFAULT_TRACKER_NAME: 'Tracker',
  SETTINGS_SHEET: 'Outreach Settings',
  SENDERS_SHEET: 'Outreach Senders',
  FIRST_ROW: 2,
  SEND_HOUR: 9,                 // used by "9am tomorrow" and "9am Monday"
  RUN_BUDGET_MS: 270000,        // stop starting new work after 4.5 minutes (Apps Script stops at 6)
  RESEARCH_CLAIM_SECONDS: 900,  // a research job that has not finished after 15 minutes is retried
  MISSED_SEND_HOURS: 24,        // a scheduled first email more than this late is not sent
  LOG_MAX_LINES: 80
};

// Columns A to H are the existing tracker. I to U are added by setup.
const COL = {
  FIRM: 1, CONTACT: 2, ROLE: 3, EMAIL: 4, SENDER: 5, DATE_EMAILED: 6, STATUS: 7, NOTES: 8,
  DRAFT: 9, SEND: 10, FU_ON: 11, FU_DAYS: 12, FU_NOTE: 13, NEXT: 14, LOG: 15,
  PARAGRAPH: 16, RESEARCH: 17, FU_COUNT: 18, THREAD_ID: 19, DRAFT_ID: 20, NEXT_AT: 21
};
const LAST_COL = 21;

const BASE_HEADERS = ['Firm Name', 'Name of contact', 'Role', 'Email', 'Contacted by',
  'Date Emailed', 'Status', 'Notes / Result'];
const NEW_HEADERS = ['Draft email?', 'Send', 'Follow ups on', 'Days between follow ups',
  'Note for next follow up', 'Next step', 'Activity log', 'Personalised paragraph',
  'Research notes', 'Follow ups sent', 'Thread ID', 'Draft ID', 'Next action at'];

const DRAFT_OPTIONS = ['Yes', 'No', 'Drafted'];
const SEND_OPTIONS = ['Send now', '9am tomorrow', '9am Monday', 'Cancel scheduled send'];
const STATUS_OPTIONS = ['Not Contacted', 'Drafting', 'Sent & Waiting', 'Replied', 'Sent Accepted',
  'Sent Rejected', 'Bounced', 'No Response'];
const STATUS_DRAFTING = 'Drafting';
const STATUS_WAITING = 'Sent & Waiting';
const STATUS_REPLIED = 'Replied';
const STATUS_BOUNCED = 'Bounced';

// [key, label on the settings sheet, default, explanation]
const SETTINGS = [
  ['prospectus', 'Prospectus (Google Drive link)', '',
    'Share link of the 2026/27 Sponsorship Prospectus. The Gmail account running this needs access to it.'],
  ['subject', 'Email subject', 'Partnership Enquiry 2026/27', 'Keep the season (for example 2026/27) in it, so replies and follow ups are found.'],
  ['seasonTag', 'Season tag', '26/27',
    'A thread counts as this season when its subject contains this (also matches 2026/27, 2026-27, 2026/2027).'],
  ['academicYear', 'Academic year', '2026/27', 'Used in the email text.'],
  ['orgName', 'Organisation name', 'Your Society', 'Used in the emails, the signature and the research.'],
  ['orgDescription', 'One line about the organisation', 'a student society at Your University',
    'Completes the sentence "I am writing on behalf of <name>, ...". Also tells the research bot who you are.'],
  ['memberInterests', 'What your members are interested in', 'quantitative research, data science, software engineering and finance',
    'Used in the emails and to write the personalised paragraph.'],
  ['defaultDays', 'Default days between follow ups', 7, ''],
  ['maxFollowUps', 'Maximum follow ups', 2, 'Counts follow ups sent by hand too.'],
  ['followUpHour', 'Follow up hour (UK time)', 9, 'Follow ups go out in the first run after this hour.'],
  ['skipWeekends', 'Skip weekends for follow ups', 'Yes', 'A follow up due on Saturday or Sunday waits until Monday.'],
  ['fuOnWhenDrafting', 'Switch follow ups on when drafting', 'Yes', ''],
  ['greetByName', 'Greet contacts by first name', 'No',
    'No keeps "Dear Sir/Madam" and "Dear <Firm> Team". Yes uses the first name in column B when the email goes to one address.'],
  ['autoResearch', 'Research new firms automatically', 'Yes', 'No means research only runs from the menu.'],
  ['contactSearches', 'Web searches for contacts', 3,
    '1 to 5. Each one uses one of the 1,000 free Tavily searches a month.'],
  ['paragraphSearches', 'Web searches for paragraph', 2, '1 to 3. Each one uses one free Tavily search.'],
  ['maxEmails', 'Most email addresses per firm', 3,
    'How many of the addresses found go in the Email column. Everyone listed there receives the email.'],
  ['orgLine', 'Signature organisation line', '',
    'The line under the job title in the signature. Leave blank to use the organisation name.'],
  ['replyTo', 'Reply to address (optional)', '',
    'Leave blank. Only fill in (for example your shared Gmail address) if replies to your Send mail as addresses do not arrive in this Gmail inbox.'],
  ['freeContactModel', 'Free model for contacts (Groq)', 'openai/gpt-oss-20b', 'Separate models use separate free daily limits.'],
  ['freeWritingModel', 'Free model for paragraph (Groq)', 'openai/gpt-oss-120b', '']
];

// Rows from older versions of the settings tab, removed by Install or repair.
const OBSOLETE_SETTINGS = ['Claude model', 'Research engine'];

// [name as typed in "Contacted by", send as address, job title, phone, signature image link]
// Examples only: replace them on the Outreach Senders tab with your own committee members.
const SENDER_DEFAULTS = [
  ['Alex Taylor', 'alex.taylor@example.org', 'Head of Partnerships', '', ''],
  ['Sam Jones', 'sam.jones@example.org', 'President', '', ''],
  ['Jordan Lee', 'jordan.lee@example.org', '', '', '']
];

const FREE_MAIL = ['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'hotmail.co.uk', 'live.com',
  'live.co.uk', 'yahoo.com', 'yahoo.co.uk', 'icloud.com', 'me.com', 'aol.com', 'proton.me',
  'protonmail.com', 'qq.com', '163.com'];

const META_HEADERS = ['From', 'To', 'Cc', 'Bcc', 'Subject', 'Message-ID', 'Message-Id', 'References',
  'In-Reply-To', 'Auto-Submitted', 'X-Autoreply', 'X-Autorespond', 'Precedence', 'Content-Type',
  'X-Failed-Recipients'];

const CACHE = {}; // per execution cache, reset by Apps Script on every run

// ===== 2. Menu ==============================================================================

function onOpen() {
  SpreadsheetApp.getUi().createMenu(APP.MENU)
    .addItem('Research queued firms now', 'menuResearchNow')
    .addItem('Research selected rows again', 'menuResearchSelected')
    .addItem('Rewrite paragraph for selected rows', 'menuRewriteParagraph')
    .addSeparator()
    .addItem('Sync with Gmail now', 'menuSyncNow')
    .addItem('Process due sends now', 'menuProcessNow')
    .addSeparator()
    .addItem('Set Tavily key (free web search)', 'menuSetTavilyKey')
    .addItem('Set Groq key (free AI model)', 'menuSetGroqKey')
    .addItem('Set Hunter API key (optional)', 'menuSetHunterKey')
    .addItem('Check setup', 'menuCheckSetup')
    .addItem('Install or repair', 'setupOutreach')
    .addToUi();
}

function menuResearchNow() {
  if (!requireOwner_() || !requireResearchKeys_()) return;
  const started = Date.now();
  const done = runResearchQueue_(started, true);
  const left = readRows_(trackerSheet_()).filter(function (r) { return needsResearch_(r); }).length;
  toast_('Researched ' + done + ' firm(s).' + (left ? ' ' + left + ' still queued; they run automatically.' : ''));
}

function menuResearchSelected() { researchSelected_({ forceContacts: true }); }
function menuRewriteParagraph() { researchSelected_({ onlyParagraph: true, forceParagraph: true }); }

function requireResearchKeys_() {
  const missing = researchKeysMissing_();
  if (!missing.length) return true;
  alert_('Set the ' + missing.join(' and ') + ' first, from the Sponsor Outreach menu.');
  return false;
}

function researchSelected_(opts) {
  if (!requireOwner_() || !requireResearchKeys_()) return;
  const sheet = trackerSheet_();
  const range = SpreadsheetApp.getActiveRange();
  if (!range || range.getSheet().getSheetId() !== sheet.getSheetId()) {
    alert_('Select one or more rows on the tracker first.');
    return;
  }
  const started = Date.now();
  let done = 0, skipped = 0;
  for (let r = Math.max(range.getRow(), APP.FIRST_ROW); r <= range.getLastRow(); r++) {
    if (late_(started, 150000)) { skipped++; continue; }
    const row = readRow_(sheet, r);
    if (!row.firm) continue;
    researchRow_(sheet, r, settings_(), opts);
    done++;
  }
  toast_('Done for ' + done + ' row(s).' + (skipped ? ' Ran out of time for ' + skipped + '; run it again for those.' : ''));
}

function menuSyncNow() {
  if (!requireOwner_() || !requireGmailService_()) return;
  const sheet = trackerSheet_();
  CACHE.events = [];
  CACHE.syncChecked = 0;
  const finished = runSync_(Date.now(), true);
  const lines = [(finished ? 'Gmail sync finished. ' : 'Gmail sync is partly done; the rest runs automatically within 10 minutes. ') +
    'Rows checked: ' + CACHE.syncChecked + '.'];
  if (CACHE.events.length) {
    lines.push('What changed:\n' + eventsSummary_(sheet));
  } else {
    lines.push('Nothing new in Gmail for those rows.');
    lines.push('Rows are checked when they have an email address and Status is blank, Drafting or Sent & Waiting. ' +
      'An email only counts when it was sent from this Gmail account and its subject contains ' + settings_().seasonTag +
      ' (the Season tag on the settings tab). Emails sent from a personal account cannot be seen.');
  }
  alert_(lines.join('\n\n'), 'Sync with Gmail');
}

function menuProcessNow() {
  if (!requireOwner_() || !requireGmailService_()) return;
  const sheet = trackerSheet_();
  const s = settings_();
  CACHE.events = [];
  const ran = runDispatcher_({ research: false });
  const lines = [CACHE.events.length ? 'Done. What changed:\n' + eventsSummary_(sheet)
    : ran ? 'Nothing was due right now.' : 'Another run of the script was busy, so nothing was sent this time. Try again in a minute.'];
  const rows = readRows_(sheet);
  const label = function (row) { return 'Row ' + row.row + ' (' + (row.firm || 'no firm') + ')'; };
  const coming = [];
  rows.forEach(function (row) {
    if (!row.threadId && row.draftId && row.nextAt) coming.push(label(row) + ': first email ' + dt_(row.nextAt));
    else if (row.threadId && row.fuOn && isWaiting_(row.status) && row.nextAt) coming.push(label(row) + ': ' + row.next);
  });
  const waiting = rows.filter(function (row) { return !row.threadId && row.draftId && !row.nextAt; }).map(label);
  if (coming.length) lines.push('Coming up:\n' + coming.slice(0, 20).join('\n'));
  if (waiting.length) {
    lines.push('Drafts waiting for you to choose Send now, 9am tomorrow or 9am Monday in the Send column (J):\n' +
      waiting.slice(0, 20).join('\n'));
  }
  if (!coming.length && !waiting.length && !CACHE.events.length) {
    lines.push('A draft is only sent after you choose an option in the Send column (J).');
  }
  lines.push('Follow ups only go out between ' + hourText_(s.followUpHour) + ' and ' + hourText_(s.followUpHour + 1) +
    ' UK time' + (s.skipWeekends ? ' on weekdays' : '') + '.');
  alert_(lines.join('\n\n'), 'Process due sends');
}

/** The Activity log lines added during this run, row by row, for the menu summaries. */
function eventsSummary_(sheet) {
  const ev = CACHE.events || [];
  const out = ev.slice(0, 25).map(function (e) {
    return 'Row ' + e.row + ' (' + (text_(sheet.getRange(e.row, COL.FIRM).getValue()) || 'no firm') + '): ' + e.text;
  });
  if (ev.length > 25) out.push('and ' + (ev.length - 25) + ' more (see the Activity log column)');
  return out.join('\n');
}

function hourText_(h) { return h === 12 ? '12pm' : h > 12 ? (h - 12) + 'pm' : h + 'am'; }

function requireGmailService_() {
  if (typeof Gmail !== 'undefined') return true;
  alert_('The Gmail service is switched off, so the script cannot read Gmail. In the script editor, click + next to ' +
    'Services, choose Gmail API and click Add (or paste appsscript.json again), then try again.');
  return false;
}

function menuSetTavilyKey() { setSecret_('TAVILY_API_KEY', 'Tavily key', 'Sign up free at app.tavily.com (no card) and paste the API key (it starts with tvly-).'); }
function menuSetGroqKey() { setSecret_('GROQ_API_KEY', 'Groq key', 'Sign up free at console.groq.com (no card), create an API key and paste it (it starts with gsk_).'); }
function menuSetHunterKey() { setSecret_('HUNTER_API_KEY', 'Hunter API key (optional)', 'Paste a hunter.io API key, or leave blank and press OK to remove it.'); }

function setSecret_(prop, title, help) {
  if (!requireOwner_()) return;
  const ui = SpreadsheetApp.getUi();
  const res = ui.prompt(title, help, ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  const value = res.getResponseText().trim();
  const props = PropertiesService.getScriptProperties();
  if (value) props.setProperty(prop, value); else props.deleteProperty(prop);
  toast_(value ? title + ' saved.' : title + ' removed.');
}

function menuCheckSetup() {
  const lines = [];
  const props = PropertiesService.getScriptProperties();
  const me = Session.getEffectiveUser().getEmail();
  const owner = props.getProperty('OWNER_EMAIL');
  lines.push((owner ? 'OK  ' : 'FIX ') + 'Installed by: ' + (owner || 'not installed yet, run Install or repair'));
  if (owner && me && owner.toLowerCase() !== me.toLowerCase()) {
    lines.push('FIX You are signed in as ' + me + '. Check setup as ' + owner + '.');
  }
  const handlers = ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); });
  ['handleEdit', 'dispatcher', 'dailySync'].forEach(function (f) {
    lines.push((handlers.indexOf(f) !== -1 ? 'OK  ' : 'FIX ') + 'Trigger ' + f);
  });
  lines.push(typeof Gmail !== 'undefined' ? 'OK  Gmail advanced service is on'
    : 'FIX Gmail advanced service is off: add "Gmail API" under Services in the script editor');
  lines.push(props.getProperty('TAVILY_API_KEY') ? 'OK  Tavily key set' : 'FIX Tavily key not set (free at app.tavily.com)');
  const gk = props.getProperty('GROQ_API_KEY');
  if (!gk) lines.push('FIX Groq key not set (free at console.groq.com)');
  else {
    const ok = testGroqKey_(gk);
    lines.push(ok === true ? 'OK  Groq key works' : 'FIX Groq key: ' + ok);
  }
  const pause = Number(props.getProperty('RESEARCH_PAUSE_UNTIL') || 0);
  if (pause > Date.now()) lines.push('TIP Research is paused until ' + dt_(new Date(pause)) + ' because a free limit was reached');
  lines.push(props.getProperty('HUNTER_API_KEY') ? 'OK  Hunter key set' : 'OK  Hunter key not set (optional)');
  try {
    const blob = prospectusBlob_(settings_());
    lines.push('OK  Prospectus: ' + blob.getName() + ' (' + Math.round(blob.getBytes().length / 1024) + ' KB)');
  } catch (err) { lines.push('FIX Prospectus: ' + msg_(err)); }
  const senders = senders_();
  if (!senders.length) lines.push('FIX No senders on the ' + APP.SENDERS_SHEET + ' sheet');
  senders.forEach(function (x) {
    const res = resolveSender_(x.name);
    lines.push((res.error ? 'FIX ' : 'OK  ') + 'Sender ' + x.name + (res.error ? ': ' + res.error : ' (' + x.email + ')') +
      (!res.error && !x.title ? ', job title is blank' : ''));
  });
  const missing = missingStatuses_();
  if (missing.length) lines.push('TIP Add ' + missing.join(' and ') + ' to the Status dropdown so the script can set them');
  alert_(lines.join('\n'), 'Sponsor Outreach setup check');
}

// ===== 3. Install or repair =================================================================

function setupOutreach() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const me = Session.getEffectiveUser().getEmail();
  const props = PropertiesService.getScriptProperties();
  const owner = props.getProperty('OWNER_EMAIL');
  if (owner && me && owner.toLowerCase() !== me.toLowerCase()) {
    if (!confirm_('This was installed by ' + owner + '. Installing again as ' + me +
      ' means every email will be sent from ' + me + '\'s Gmail. Continue?')) return;
  }

  // Tracker sheet: the active sheet if it has "Firm Name" in A1, otherwise the first that does.
  let sheet = findTrackerSheet_(ss);
  if (!sheet) {
    sheet = ss.insertSheet(APP.DEFAULT_TRACKER_NAME);
    sheet.getRange(1, 1, 1, BASE_HEADERS.length).setValues([BASE_HEADERS]).setFontWeight('bold');
  }
  const current = sheet.getRange(1, 9, 1, NEW_HEADERS.length).getValues()[0];
  const clashes = [];
  current.forEach(function (v, i) {
    if (String(v).trim() && String(v).trim() !== NEW_HEADERS[i]) clashes.push(colLetter_(9 + i) + '1 ("' + v + '")');
  });
  if (clashes.length) {
    alert_('Setup stopped: these header cells are already in use: ' + clashes.join(', ') +
      '. Move those columns to the right of column U and run Install or repair again.');
    return;
  }
  sheet.getRange(1, 9, 1, NEW_HEADERS.length).setValues([NEW_HEADERS]);
  sheet.getRange(1, 8).copyFormatToRange(sheet, 9, LAST_COL, 1, 1);

  const rows = Math.max(sheet.getMaxRows() - 1, 1);
  const list = function (values) {
    return SpreadsheetApp.newDataValidation().requireValueInList(values, true).setAllowInvalid(true).build();
  };
  sheet.getRange(APP.FIRST_ROW, COL.DRAFT, rows, 1).setDataValidation(list(DRAFT_OPTIONS));
  sheet.getRange(APP.FIRST_ROW, COL.SEND, rows, 1).setDataValidation(list(SEND_OPTIONS));
  sheet.getRange(APP.FIRST_ROW, COL.FU_ON, rows, 1)
    .setDataValidation(SpreadsheetApp.newDataValidation().requireCheckbox().build());
  sheet.getRange(APP.FIRST_ROW, COL.FU_DAYS, rows, 1)
    .setDataValidation(SpreadsheetApp.newDataValidation().requireNumberBetween(1, 60).setAllowInvalid(false).build());
  sheet.getRange(APP.FIRST_ROW, COL.THREAD_ID, rows, 3).setNumberFormat('@');
  sheet.getRange(APP.FIRST_ROW, COL.NEXT, rows, 4).setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);
  sheet.setColumnWidth(COL.NEXT, 230);
  sheet.setColumnWidth(COL.LOG, 300);
  sheet.setColumnWidth(COL.PARAGRAPH, 320);
  sheet.setColumnWidth(COL.RESEARCH, 280);
  sheet.hideColumns(COL.THREAD_ID, 3);

  // Settings and senders sheets (created once, never overwritten).
  const settingsSheet = ensureSettingsSheet_(ss);
  const sendersSheet = ensureSendersSheet_(ss);
  sheet.getRange(APP.FIRST_ROW, COL.SENDER, rows, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInRange(sendersSheet.getRange('A2:A50'), true).setAllowInvalid(true).build());

  // Status dropdown: added only when the column has none, so existing colours are kept.
  if (!sheet.getRange(APP.FIRST_ROW, COL.STATUS).getDataValidation()) {
    sheet.getRange(APP.FIRST_ROW, COL.STATUS, rows, 1).setDataValidation(list(STATUS_OPTIONS));
  }

  // Triggers: remove old copies first so nothing runs twice.
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (TRIGGER_FUNCS.indexOf(t.getHandlerFunction()) !== -1) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('handleEdit').forSpreadsheet(ss).onEdit().create();
  ScriptApp.newTrigger('dispatcher').timeBased().everyMinutes(10).create();
  ScriptApp.newTrigger('dailySync').timeBased().everyDays(1).atHour(7).inTimezone(APP.TZ).create();

  props.setProperty('OWNER_EMAIL', me || '');
  props.setProperty('SPREADSHEET_ID', ss.getId());
  props.setProperty('TRACKER_SHEET_ID', String(sheet.getSheetId()));
  props.deleteProperty('CLAUDE_API_KEY'); // left over from older versions, no longer used
  CACHE.tracker = sheet;

  const todo = [];
  CACHE.settings = null;
  researchKeysMissing_().forEach(function (k) { todo.push('Sponsor Outreach > Set ' + k); });
  if (!String(settingsSheet.getRange(2, 2).getValue()).trim()) todo.push('Paste the prospectus Drive link on the ' + APP.SETTINGS_SHEET + ' sheet');
  todo.push('Fill in job titles, phones and signature images on the ' + APP.SENDERS_SHEET + ' sheet');
  const missing = missingStatuses_();
  if (missing.length) todo.push('Add ' + missing.join(' and ') + ' to your Status dropdown (optional)');
  todo.push('Sponsor Outreach > Check setup');
  alert_('Installed on "' + sheet.getName() + '" as ' + me + '.\n\nStill to do:\n' +
    todo.map(function (t, i) { return (i + 1) + '. ' + t; }).join('\n'), 'Sponsor Outreach');
}

function ensureSettingsSheet_(ss) {
  let sh = ss.getSheetByName(APP.SETTINGS_SHEET);
  if (sh) {
    // Upgrade an older tab: remove settings that no longer exist, refresh the notes and add new
    // settings at the bottom. Values you typed are never changed.
    const obsolete = OBSOLETE_SETTINGS.map(function (x) { return x.toLowerCase(); });
    for (let r = sh.getLastRow(); r >= 2; r--) {
      if (obsolete.indexOf(String(sh.getRange(r, 1).getValue()).trim().toLowerCase()) !== -1) sh.deleteRow(r);
    }
    const have = sh.getLastRow() >= 2 ? sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues()
      .map(function (r) { return String(r[0]).trim().toLowerCase(); }) : [];
    have.forEach(function (label, i) {
      const d = SETTINGS.filter(function (x) { return x[1].toLowerCase() === label; })[0];
      if (d && String(sh.getRange(i + 2, 3).getValue()) !== d[3]) sh.getRange(i + 2, 3).setValue(d[3]);
    });
    SETTINGS.filter(function (d) { return have.indexOf(d[1].toLowerCase()) === -1; }).forEach(function (d) {
      const r = sh.getLastRow() + 1;
      sh.getRange(r, 2).setNumberFormat('@');
      sh.getRange(r, 1, 1, 3).setValues([[d[1], String(d[2]), d[3]]]);
    });
    return sh;
  }
  sh = ss.insertSheet(APP.SETTINGS_SHEET);
  sh.getRange(1, 1, 1, 3).setValues([['Setting', 'Value', 'Notes']]).setFontWeight('bold');
  sh.getRange(2, 2, SETTINGS.length, 1).setNumberFormat('@');
  sh.getRange(2, 1, SETTINGS.length, 3).setValues(SETTINGS.map(function (s) { return [s[1], String(s[2]), s[3]]; }));
  sh.setColumnWidth(1, 260); sh.setColumnWidth(2, 340); sh.setColumnWidth(3, 520);
  sh.setFrozenRows(1);
  return sh;
}

function ensureSendersSheet_(ss) {
  let sh = ss.getSheetByName(APP.SENDERS_SHEET);
  if (sh) return sh;
  sh = ss.insertSheet(APP.SENDERS_SHEET);
  sh.getRange(1, 1, 1, 5).setValues([['Name (as in Contacted by)', 'Send mail as address', 'Job title', 'Phone',
    'Signature image link']]).setFontWeight('bold');
  sh.getRange(2, 1, 49, 5).setNumberFormat('@');
  sh.getRange(2, 1, SENDER_DEFAULTS.length, 5).setValues(SENDER_DEFAULTS);
  sh.setColumnWidth(1, 200); sh.setColumnWidth(2, 260); sh.setColumnWidth(3, 260); sh.setColumnWidth(4, 160);
  sh.setColumnWidth(5, 420);
  sh.setFrozenRows(1);
  return sh;
}

// ===== 4. Triggers ==========================================================================

const TRIGGER_FUNCS = ['handleEdit', 'dispatcher', 'dailySync'];

/**
 * True when this run belongs to the account that installed the script. Triggers left behind by an
 * earlier install under another Google account remove themselves, so two accounts never run at once.
 */
function ownerOk_() {
  const owner = String(PropertiesService.getScriptProperties().getProperty('OWNER_EMAIL') || '').toLowerCase();
  const me = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
  if (owner && me && owner === me) return true;
  if (owner && me) {
    try {
      ScriptApp.getProjectTriggers().forEach(function (t) {
        if (TRIGGER_FUNCS.indexOf(t.getHandlerFunction()) !== -1) ScriptApp.deleteTrigger(t);
      });
    } catch (err) { /* ignore */ }
  }
  return false;
}

/** Installable edit trigger (runs as the installing account, whoever edits). */
function handleEdit(e) {
  if (!e || !e.range) return;
  if (!ownerOk_()) return;
  const sheet = e.range.getSheet();
  if (!isTracker_(sheet)) return;
  const r1 = Math.max(e.range.getRow(), APP.FIRST_ROW);
  const r2 = Math.min(e.range.getLastRow(), r1 + 199);
  if (r2 < r1) return;
  const c1 = e.range.getColumn(), c2 = e.range.getLastColumn();
  const hit = function (c) { return c >= c1 && c <= c2; };
  const started = Date.now();
  const s = settings_();
  let r;

  if (hit(COL.FIRM)) markQueued_(sheet, r1, r2);

  if (hit(COL.DRAFT)) {
    for (r = r1; r <= r2; r++) {
      if (late_(started, 200000)) break;
      const rr = r;
      if (normChoice_(sheet.getRange(rr, COL.DRAFT).getValue()) === 'yes') {
        safe_(sheet, rr, function () { processDraftRequest_(sheet, rr, s); });
      }
    }
  }

  if (hit(COL.SEND)) {
    const ran = withLock_(function () {
      for (r = r1; r <= r2; r++) {
        if (late_(started, 240000)) break;
        const rr = r;
        safe_(sheet, rr, function () { applySendChoice_(sheet, rr, s); });
      }
    }, 20000);
    if (!ran) {
      for (r = r1; r <= r2; r++) {
        if (text_(sheet.getRange(r, COL.SEND).getValue())) setVal_(sheet, r, COL.NEXT, 'Busy: this will be handled within 10 minutes');
      }
    }
  }

  if (hit(COL.FU_ON) || hit(COL.FU_DAYS) || hit(COL.STATUS) || hit(COL.EMAIL) || hit(COL.SENDER)) {
    withLock_(function () {
      for (r = r1; r <= r2; r++) {
        if (late_(started, 240000)) break;
        const rr = r;
        const row = readRow_(sheet, rr);
        if (row.threadId) {
          safe_(sheet, rr, function () {
            if (hit(COL.EMAIL) && unlinkAfterBounce_(sheet, rr, row, s)) return;
            refreshRow_(sheet, rr, s);
          });
        } else if ((hit(COL.EMAIL) || hit(COL.SENDER)) && row.draftId) {
          setNext_(sheet, rr, 'Email or Contacted by changed: set Draft email? to Yes to rebuild the draft before sending', row.nextAt);
        }
      }
    }, 20000);
  }
}

/** On a bounced row, typing a new address unlinks the old email so the new address can be drafted. */
function unlinkAfterBounce_(sheet, r, row, s) {
  const bounced = normStatus_(row.status) === 'bounced' || /^Bounced/.test(row.next);
  if (!bounced || !row.emails.length) return false;
  const meta = getThreadMeta_(row.threadId);
  const a = meta ? analyzeThread_(meta, row.emails, ourAddresses_(), s) : null;
  if (a && a.sendTo && a.sendTo.length) return false; // the bounced address is still in column D
  logEvent_(sheet, r, 'New address after bounce ' + d_(new Date()) + ': earlier email to ' +
    (a && a.recipients ? a.recipients.join(', ') : 'the old address') + ' unlinked');
  setText_(sheet, r, COL.THREAD_ID, '');
  setVal_(sheet, r, COL.FU_COUNT, '');
  setVal_(sheet, r, COL.DRAFT, '');
  setVal_(sheet, r, COL.DATE_EMAILED, '');
  if (normStatus_(row.status) === 'bounced' || isWaiting_(row.status)) setVal_(sheet, r, COL.STATUS, '');
  setNext_(sheet, r, 'New address: set Draft email? to Yes to email it', null);
  return true;
}

/** Runs every 10 minutes. */
function dispatcher() {
  if (!ownerOk_()) return;
  runDispatcher_({ research: true });
}

/** Sends that are due, waiting draft requests, an unfinished sync and (opts.research) the research queue. */
function runDispatcher_(opts) {
  const started = Date.now();
  const sheet = trackerSheet_();
  if (!sheet) return false;
  const s = settings_();
  const now = new Date();

  // a) Sends, under the script lock so nothing can go out twice.
  const ran = withLock_(function () {
    const rows = readRows_(sheet);
    rows.forEach(function (row) {
      if (row.sendChoice && !late_(started, 200000)) safe_(sheet, row.row, function () { applySendChoice_(sheet, row.row, s); });
    });
    readRows_(sheet).forEach(function (row) {
      if (late_(started, 200000)) return;
      if (row.threadId || !row.draftId || !row.nextAt || row.nextAt > now) return;
      if (now - row.nextAt > APP.MISSED_SEND_HOURS * 3600000) {
        setNext_(sheet, row.row, 'Scheduled send was missed: choose an option in Send again', null);
        logEvent_(sheet, row.row, 'Scheduled send missed ' + d_(now) + ' (more than a day late, not sent)');
        return;
      }
      safe_(sheet, row.row, function () { sendInitial_(sheet, row.row, s); });
    });
    if (inFollowUpWindow_(now, s)) {
      readRows_(sheet).forEach(function (row) {
        if (late_(started, 200000)) return;
        if (row.threadId && row.fuOn && isWaiting_(row.status) && row.nextAt && row.nextAt <= now) {
          safe_(sheet, row.row, function () { processFollowUp_(sheet, row.row, s, now); });
        }
      });
    }
  }, 20000);

  // b) Draft requests that were waiting (busy lock or research still running).
  readRows_(sheet).forEach(function (row) {
    if (late_(started, 150000)) return;
    if (normChoice_(row.draftChoice) === 'yes') safe_(sheet, row.row, function () { processDraftRequest_(sheet, row.row, s); });
  });

  // c) Finish a Gmail sync that ran out of time.
  if (PropertiesService.getScriptProperties().getProperty('SYNC_CURSOR') && !late_(started, 150000)) runSync_(started, false);

  // d) Research queue.
  if (opts && opts.research) runResearchQueue_(started, false);
  return ran;
}

/** Runs once a day between 7 and 8am UK time. */
function dailySync() { if (ownerOk_()) runSync_(Date.now(), true); }

// ===== 5. Rows, log and sheet helpers =======================================================

function spreadsheet_() {
  if (CACHE.ss) return CACHE.ss;
  let ss = null;
  try { ss = SpreadsheetApp.getActiveSpreadsheet(); } catch (err) { ss = null; }
  if (!ss) {
    const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
    if (id) ss = SpreadsheetApp.openById(id);
  }
  CACHE.ss = ss;
  return ss;
}

function trackerSheet_() {
  if (CACHE.tracker) return CACHE.tracker;
  const ss = spreadsheet_();
  if (!ss) return null;
  const id = PropertiesService.getScriptProperties().getProperty('TRACKER_SHEET_ID');
  let sheet = null;
  if (id) sheet = ss.getSheets().filter(function (sh) { return String(sh.getSheetId()) === id; })[0] || null;
  if (!sheet) sheet = findTrackerSheet_(ss);
  CACHE.tracker = sheet;
  return sheet;
}

function findTrackerSheet_(ss) {
  const looks = function (sh) { return String(sh.getRange(1, 1).getValue()).trim().toLowerCase() === 'firm name'; };
  let active = null;
  try { active = ss.getActiveSheet(); } catch (err) { active = null; }
  if (active && looks(active)) return active;
  return ss.getSheets().filter(looks)[0] || null;
}

function isTracker_(sheet) {
  const t = trackerSheet_();
  return !!t && t.getSheetId() === sheet.getSheetId();
}

function readRows_(sheet) {
  const last = sheet.getLastRow();
  if (last < APP.FIRST_ROW) return [];
  const values = sheet.getRange(APP.FIRST_ROW, 1, last - APP.FIRST_ROW + 1, LAST_COL).getValues();
  return values.map(function (v, i) { return rowObj_(APP.FIRST_ROW + i, v); });
}

function readRow_(sheet, r) {
  return rowObj_(r, sheet.getRange(r, 1, 1, LAST_COL).getValues()[0]);
}

function rowObj_(r, v) {
  const g = function (c) { return v[c - 1]; };
  return {
    row: r,
    firm: text_(g(COL.FIRM)),
    contact: text_(g(COL.CONTACT)),
    role: text_(g(COL.ROLE)),
    emailCell: text_(g(COL.EMAIL)),
    emails: extractEmails_(g(COL.EMAIL)),
    sender: text_(g(COL.SENDER)),
    dateEmailed: text_(g(COL.DATE_EMAILED)),
    status: text_(g(COL.STATUS)),
    draftChoice: text_(g(COL.DRAFT)),
    sendChoice: text_(g(COL.SEND)),
    fuOn: truthy_(g(COL.FU_ON)),
    fuDays: num_(g(COL.FU_DAYS)),
    fuNote: text_(g(COL.FU_NOTE)),
    next: text_(g(COL.NEXT)),
    log: text_(g(COL.LOG)),
    paragraph: text_(g(COL.PARAGRAPH)),
    research: text_(g(COL.RESEARCH)),
    fuCount: num_(g(COL.FU_COUNT)),
    threadId: text_(g(COL.THREAD_ID)),
    draftId: text_(g(COL.DRAFT_ID)),
    nextAt: parseDate_(g(COL.NEXT_AT))
  };
}

function setVal_(sheet, r, c, value) { sheet.getRange(r, c).setValue(value); }
function setText_(sheet, r, c, value) { sheet.getRange(r, c).setNumberFormat('@').setValue(value); }

/** Next step text (column N) plus the machine readable time (hidden column U). */
function setNext_(sheet, r, text, at) {
  setVal_(sheet, r, COL.NEXT, text || '');
  setText_(sheet, r, COL.NEXT_AT, at ? at.toISOString() : '');
}

/** Adds a line to the top of the Activity log. once: never add the same line twice. */
function logEvent_(sheet, r, text, opts) {
  opts = opts || {};
  const cell = sheet.getRange(r, COL.LOG);
  const lines = String(cell.getValue() || '').split('\n').filter(function (l) { return l.trim(); });
  if (lines.length && lines[0] === text) return false;
  if (opts.once && lines.indexOf(text) !== -1) return false;
  lines.unshift(text);
  cell.setValue(lines.slice(0, APP.LOG_MAX_LINES).join('\n'));
  if (CACHE.events) CACHE.events.push({ row: r, text: text }); // collected for the menu summaries
  return true;
}

/** Row r still holds this firm? If rows moved (sort, insert), find the row again. */
function relocate_(sheet, r, firm, col, value) {
  const here = readRow_(sheet, r);
  const matches = function (row) {
    if (row.firm !== firm) return false;
    if (!col) return true;
    return text_(sheet.getRange(row.row, col).getValue()) === value;
  };
  if (matches(here)) return r;
  const found = readRows_(sheet).filter(matches);
  return found.length === 1 ? found[0].row : -1;
}

function rowWithThread_(sheet, threadId) {
  const hit = readRows_(sheet).filter(function (row) { return row.threadId === threadId; })[0];
  return hit ? hit.row : 0;
}

function safe_(sheet, r, fn) {
  try { return fn(); } catch (err) {
    console.error('Row ' + r + ': ' + (err && err.stack ? err.stack : err));
    try { logEvent_(sheet, r, 'Error ' + d_(new Date()) + ': ' + msg_(err).slice(0, 250)); } catch (ignore) { /* sheet busy */ }
    return null;
  }
}

function withLock_(fn, waitMs) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(waitMs || 30000)) return false;
  try { fn(); } finally { lock.releaseLock(); }
  return true;
}

function late_(started, budgetMs) { return Date.now() - started > (budgetMs || APP.RUN_BUDGET_MS); }

function requireOwner_() {
  const owner = PropertiesService.getScriptProperties().getProperty('OWNER_EMAIL');
  if (!owner) { alert_('Run Sponsor Outreach > Install or repair first.'); return false; }
  const me = Session.getEffectiveUser().getEmail();
  if (!me || me.toLowerCase() !== owner.toLowerCase()) {
    alert_('Use this menu while signed in as ' + owner + '. Everything is sent from that Gmail account. ' +
      'The columns on the sheet (Draft email?, Send, Follow ups on) work for everyone.');
    return false;
  }
  return true;
}

function alert_(message, title) {
  try { SpreadsheetApp.getUi().alert(title || APP.MENU, message, SpreadsheetApp.getUi().ButtonSet.OK); }
  catch (err) { console.log((title ? title + ': ' : '') + message); }
}

function confirm_(message) {
  try {
    const ui = SpreadsheetApp.getUi();
    return ui.alert(APP.MENU, message, ui.ButtonSet.YES_NO) === ui.Button.YES;
  } catch (err) { return true; }
}

function toast_(message) {
  try { spreadsheet_().toast(message, APP.MENU, 8); } catch (err) { console.log(message); }
}

// ===== 6. Settings, senders and status ======================================================

function settings_() {
  if (CACHE.settings) return CACHE.settings;
  const sh = spreadsheet_().getSheetByName(APP.SETTINGS_SHEET);
  const map = {};
  if (sh && sh.getLastRow() >= 2) {
    sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues().forEach(function (row) {
      map[String(row[0]).trim().toLowerCase()] = row[1];
    });
  }
  const s = {};
  SETTINGS.forEach(function (d) {
    const v = map[d[1].toLowerCase()];
    s[d[0]] = (v === undefined || v === null || String(v).trim() === '') ? d[2] : (v instanceof Date ? String(v) : v);
  });
  ['prospectus', 'subject', 'seasonTag', 'academicYear', 'orgName', 'orgDescription', 'memberInterests', 'orgLine',
    'freeContactModel', 'freeWritingModel'].forEach(function (k) { s[k] = String(s[k]).trim(); });
  s.replyTo = extractEmails_(s.replyTo)[0] || '';
  s.defaultDays = clampInt_(s.defaultDays, 1, 60, 7);
  s.maxFollowUps = clampInt_(s.maxFollowUps, 0, 10, 2);
  s.followUpHour = clampInt_(s.followUpHour, 6, 20, 9);
  s.contactSearches = clampInt_(s.contactSearches, 1, 5, 3);
  s.paragraphSearches = clampInt_(s.paragraphSearches, 1, 3, 2);
  s.maxEmails = clampInt_(s.maxEmails, 1, 5, 3);
  ['skipWeekends', 'fuOnWhenDrafting', 'greetByName', 'autoResearch'].forEach(function (k) { s[k] = yes_(s[k]); });
  s.seasonRe = seasonRegex_(s.seasonTag);
  CACHE.settings = s;
  return s;
}

function senders_() {
  if (CACHE.senders) return CACHE.senders;
  const sh = spreadsheet_().getSheetByName(APP.SENDERS_SHEET);
  const list = [];
  if (sh && sh.getLastRow() >= 2) {
    sh.getRange(2, 1, sh.getLastRow() - 1, 5).getValues().forEach(function (row) {
      const name = text_(row[0]);
      if (!name) return;
      list.push({
        name: name,
        email: (extractEmails_(row[1])[0] || ''),
        title: text_(row[2]),
        phone: text_(row[3]),
        signatureUrl: text_(row[4])
      });
    });
  }
  CACHE.senders = list;
  return list;
}

function resolveSender_(name) {
  if (!name) return { error: 'choose who is sending in Contacted by (column E)' };
  const key = String(name).trim().toLowerCase();
  const s = senders_().filter(function (x) { return x.name.toLowerCase() === key || x.email === key; })[0];
  if (!s) return { error: '"' + name + '" is not on the ' + APP.SENDERS_SHEET + ' sheet' };
  if (!s.email) return { error: 'no send mail as address for ' + s.name + ' on the ' + APP.SENDERS_SHEET + ' sheet' };
  const me = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
  if (!CACHE.aliases) {
    try { CACHE.aliases = GmailApp.getAliases().map(function (a) { return String(a).toLowerCase(); }); }
    catch (err) { CACHE.aliases = []; }
  }
  if (s.email !== me && CACHE.aliases.indexOf(s.email) === -1) {
    return { error: s.email + ' is not a Send mail as address in ' + (me || 'this Gmail account') };
  }
  return s;
}

/** Every address that counts as "us": this account, its aliases and the senders sheet. */
function ourAddresses_() {
  if (CACHE.ours) return CACHE.ours;
  const set = new Set();
  const me = Session.getEffectiveUser().getEmail();
  if (me) set.add(me.toLowerCase());
  try { GmailApp.getAliases().forEach(function (a) { set.add(String(a).toLowerCase()); }); } catch (err) { /* ignore */ }
  senders_().forEach(function (x) { if (x.email) set.add(x.email); });
  CACHE.ours = set;
  return set;
}

function statusList_() {
  if (CACHE.statusList !== undefined) return CACHE.statusList;
  let list = null;
  try {
    const dv = trackerSheet_().getRange(APP.FIRST_ROW, COL.STATUS).getDataValidation();
    if (dv) {
      const type = dv.getCriteriaType();
      const crit = SpreadsheetApp.DataValidationCriteria;
      if (type === crit.VALUE_IN_LIST) list = dv.getCriteriaValues()[0].map(String);
      else if (type === crit.VALUE_IN_RANGE) list = dv.getCriteriaValues()[0].getValues().map(function (x) { return String(x[0]); });
      else list = [];
    }
  } catch (err) { list = null; }
  CACHE.statusList = list; // null means no dropdown, so any status is fine
  return list;
}

/** The dropdown's own spelling of a status, or null when the dropdown does not have it. */
function statusLabel_(value) {
  const list = statusList_();
  if (!list) return value;
  const hit = list.filter(function (x) { return normStatus_(x) === normStatus_(value); })[0];
  return hit || null;
}

function setStatus_(sheet, r, value) {
  const label = statusLabel_(value);
  if (label) setVal_(sheet, r, COL.STATUS, label);
  return !!label;
}

function missingStatuses_() {
  return [STATUS_REPLIED, STATUS_BOUNCED].filter(function (x) { return !statusLabel_(x); });
}

// ===== 7. Research queue and results =======================================================

function markQueued_(sheet, r1, r2) {
  const s = settings_();
  if (!s.autoResearch) return;
  const all = readRows_(sheet);
  all.filter(function (row) { return row.row >= r1 && row.row <= r2; }).forEach(function (row) {
    if (row.research || !needsResearch_(row)) return;
    const dup = duplicateFirm_(all, row);
    setVal_(sheet, row.row, COL.RESEARCH, dup ? duplicateNote_(row, dup) : 'Queued for research');
  });
}

/** Another row for the same firm that is earlier in the sheet or already contacted. */
function duplicateFirm_(rows, row) {
  const key = firmKey_(row.firm);
  return rows.filter(function (o) {
    return o.row !== row.row && firmKey_(o.firm) === key && (o.row < row.row || !!o.threadId || !notSentYet_(o.status));
  })[0] || null;
}

function firmKey_(name) { return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

function duplicateNote_(row, dup) {
  return 'Skipped: ' + row.firm + ' is already in row ' + dup.row + (dup.status ? ' (' + dup.status + ')' : '') +
    '. To research it anyway use Sponsor Outreach > Research selected rows again.';
}

function needsResearch_(row) {
  if (!row.firm || row.threadId || row.draftId) return false;
  if (!notSentYet_(row.status)) return false;
  if (row.emails.length && row.paragraph) return false;
  if (!row.research || /^queued/i.test(row.research)) return true;
  if (/^researching/i.test(row.research)) return !CacheService.getScriptCache().get(claimKey_(row.firm));
  return false;
}

function runResearchQueue_(started, force) {
  const sheet = trackerSheet_();
  const s = settings_();
  if (!sheet || (!s.autoResearch && !force)) return 0;
  if (researchKeysMissing_().length) return 0;
  if (Number(PropertiesService.getScriptProperties().getProperty('RESEARCH_PAUSE_UNTIL') || 0) > Date.now()) return 0;
  let done = 0;
  const rows = readRows_(sheet);
  for (let i = 0; i < rows.length; i++) {
    if (late_(started, 120000)) break; // one firm can take up to two minutes
    if (!needsResearch_(rows[i])) continue;
    const dup = duplicateFirm_(rows, rows[i]);
    if (dup) { setVal_(sheet, rows[i].row, COL.RESEARCH, duplicateNote_(rows[i], dup)); continue; }
    researchRow_(sheet, rows[i].row, s, {});
    done++;
  }
  return done;
}

function claimKey_(firm) { return 'research:' + String(firm).toLowerCase().slice(0, 200); }

function claimResearch_(sheet, r, firm) {
  let ok = false;
  withLock_(function () {
    if (readRow_(sheet, r).firm !== firm) return;
    const cache = CacheService.getScriptCache();
    if (cache.get(claimKey_(firm))) return;
    cache.put(claimKey_(firm), '1', APP.RESEARCH_CLAIM_SECONDS);
    setVal_(sheet, r, COL.RESEARCH, 'Researching… started ' + fmt_(new Date(), 'dd/MM/yy HH:mm'));
    SpreadsheetApp.flush();
    ok = true;
  }, 30000);
  return ok;
}

function releaseResearch_(firm) { CacheService.getScriptCache().remove(claimKey_(firm)); }

/**
 * opts.forceContacts: search contacts even when column D has an email.
 * opts.forceParagraph: rewrite column P even when it has text.
 * opts.onlyParagraph: skip the contact search.
 */
function researchRow_(sheet, r, s, opts) {
  opts = opts || {};
  const row = readRow_(sheet, r);
  if (!row.firm) return;
  const doContacts = !opts.onlyParagraph && (opts.forceContacts || !row.emails.length);
  const doParagraph = opts.forceParagraph || !row.paragraph;
  if (!doContacts && !doParagraph) {
    setVal_(sheet, r, COL.RESEARCH, 'Nothing to research ' + d_(new Date()) + ': email and paragraph are filled in');
    return;
  }
  if (!claimResearch_(sheet, r, row.firm)) return;
  const out = { contacts: null, paragraph: null, errors: [], pause: 0 };
  const failed = function (part, err) {
    out.errors.push(part + ': ' + msg_(err));
    out.pause = Math.max(out.pause, err && err.pauseMinutes ? err.pauseMinutes : 0);
  };
  try {
    if (doContacts) {
      try { out.contacts = researchContacts_(row.firm, s); } catch (err) { failed('contacts', err); }
    }
    if (doParagraph && !out.pause) {
      const domain = (out.contacts && out.contacts.domain) || domainOf_(row.emails[0] || '');
      try { out.paragraph = writeParagraph_(row.firm, domain, s); } catch (err) { failed('paragraph', err); }
    } else if (doParagraph) {
      out.errors.push('paragraph: waiting for the free limit to reset');
    }
    if (out.pause) {
      PropertiesService.getScriptProperties().setProperty('RESEARCH_PAUSE_UNTIL', String(Date.now() + out.pause * 60000));
    }
  } finally {
    withLock_(function () {
      const rr = relocate_(sheet, r, row.firm);
      if (rr > 0) applyResearch_(sheet, rr, out, opts);
    }, 60000);
    releaseResearch_(row.firm);
  }
}

function applyResearch_(sheet, r, out, opts) {
  const row = readRow_(sheet, r);
  const now = new Date();
  const notes = [];
  if (out.contacts) {
    const c = out.contacts;
    if (!row.emails.length && c.recommended.length) {
      // Every address picked goes in the Email column, for example "a@firm.com, b@firm.com".
      setVal_(sheet, r, COL.EMAIL, c.recommended.join(', '));
      // Names and roles of the people among them (shared mailboxes have no name).
      const people = c.contacts.filter(function (x) { return x.name && c.recommended.indexOf(x.email) !== -1; });
      if (people.length && !row.contact) setVal_(sheet, r, COL.CONTACT, people.map(function (x) { return x.name; }).join(', '));
      const roles = people.map(function (x) { return x.role; }).filter(function (x) { return x; });
      if (roles.length && !row.role) setVal_(sheet, r, COL.ROLE, roles.join('; '));
    }
    notes.push(contactNotes_(c));
  }
  if (out.paragraph) {
    if (!row.paragraph || opts.forceParagraph) setVal_(sheet, r, COL.PARAGRAPH, out.paragraph.paragraph);
    notes.push(paragraphNotes_(out.paragraph));
  }
  // A free limit was hit: queue the row again so it is finished automatically once the limit resets.
  const retry = out.pause > 0 && !opts.onlyParagraph;
  if (out.errors.length) {
    notes.push('Problems: ' + out.errors.join(' | '));
    notes.push(retry ? 'A free limit was reached; this row is researched again automatically once it resets.'
      : 'To try again, clear this cell (it is then researched within 10 minutes) or use Sponsor Outreach > Research selected rows again.');
  }
  const failed = !out.contacts && !out.paragraph;
  const head = retry ? 'Queued for research (free limit reached, retrying automatically) ' + d_(now)
    : (opts.onlyParagraph ? (failed ? 'Paragraph rewrite failed ' : 'Paragraph rewritten ')
      : (failed ? 'Research failed ' : 'Researched ')) + d_(now);
  // Keep earlier notes when this run did not search contacts again.
  const oldBody = String(row.research || '').replace(/^(queued|researching)[^\n]*\n?/i, '');
  const previous = (!out.contacts && !/^skipped/i.test(row.research) && /Domain: |Paragraph based on: /.test(oldBody))
    ? '\n\nEarlier research:\n' + oldBody : '';
  setVal_(sheet, r, COL.RESEARCH, (head + '\n' + notes.join('\n') + previous).slice(0, 45000));
  logEvent_(sheet, r, retry ? 'Research paused ' + d_(now) + ': free limit reached, it retries automatically'
    : head + (out.errors.length ? ' (see Research notes)' : ''));
  const fresh = readRow_(sheet, r);
  if (!fresh.threadId && !fresh.draftId) {
    setNext_(sheet, r, fresh.emails.length && fresh.paragraph
      ? 'Check email and paragraph, pick Contacted by, then set Draft email? to Yes'
      : retry ? 'Waiting for the free research limit to reset'
        : 'Research incomplete: add the missing email or paragraph by hand', null);
  } else if (fresh.draftId && out.paragraph && opts.forceParagraph) {
    setNext_(sheet, r, 'Paragraph changed: set Draft email? to Yes to update the draft', fresh.nextAt);
  }
}

function contactNotes_(c) {
  const lines = [];
  lines.push('Domain: ' + (c.domain || 'unknown') + ' | Email format: ' + (c.format || 'unknown') +
    (c.evidence ? ' (' + c.evidence + ')' : '') + (c.hunterPattern ? ' | Hunter pattern: ' + c.hunterPattern : ''));
  lines.push('Recommended: ' + (c.recommended.join(', ') || 'none found'));
  if (c.contacts.length) {
    lines.push('Contacts found:');
    c.contacts.forEach(function (x) {
      lines.push('• ' + [x.email, x.name, x.role, x.type, x.region, x.confidence, x.source]
        .filter(function (v) { return v; }).join(' | '));
    });
  }
  if (c.dropped && c.dropped.length) {
    lines.push('Not used (not on any page found, not at the firm, or guessed without a confirmed format): ' + c.dropped.join(', '));
  }
  if (c.notes) lines.push('Why: ' + c.notes);
  return lines.join('\n');
}

function paragraphNotes_(p) {
  return 'Paragraph based on: ' + (p.fact || 'see sources') +
    (p.sources.length ? '\nParagraph sources: ' + p.sources.join(' ') : '');
}

function paragraphSystem_(s) {
  return 'You write one paragraph of a sponsorship letter from ' + s.orgName + ', ' + s.orgDescription + ', to a firm. ' +
    'The paragraph must be accurate, specific to the firm and written in British English.';
}

// Two fictional examples of the style wanted. Replace them with paragraphs your organisation has written.
const PARAGRAPH_EXAMPLES = [
  'Given Northfield Capital\u2019s commitment to combining rigorous research with modern technology, we believe there is ' +
  'a strong alignment with the interests of our members. We were particularly interested in Northfield Capital\u2019s ' +
  'recently launched graduate research programme, which gives new joiners hands-on experience building forecasting models ' +
  'alongside senior researchers. This focus on developing early careers talent in data-driven research closely aligns with ' +
  'our members\u2019 interests, and we would be very interested in exploring a partnership with Northfield Capital.',
  'Given Bramley Systems\u2019 strength in engineering and trading technology, we believe there is a strong alignment with ' +
  'the interests of our members. We were particularly interested in Bramley Systems\u2019 investment in low latency ' +
  'infrastructure and its open approach to sharing engineering practice through talks and published work. This commitment ' +
  'to technical excellence closely aligns with the areas our members are increasingly exploring, and we would be very ' +
  'interested in building a partnership around that shared interest.'
];

function normaliseContacts_(j, hunter) {
  const contacts = (Array.isArray(j.contacts) ? j.contacts : []).map(function (c) {
    const name = clean_(c.name);
    return {
      name: teamName_(name) ? '' : name, role: noDash_(clean_(c.role)), email: extractEmails_(c.email)[0] || '',
      type: clean_(c.email_type), region: clean_(c.region), confidence: clean_(c.confidence),
      source: clean_(c.source_url)
    };
  }).filter(function (c) { return c.email; }).slice(0, 8);
  let rec = (Array.isArray(j.recommended) ? j.recommended : [j.recommended])
    .map(function (x) { return extractEmails_(x)[0]; }).filter(function (x) { return !!x; });
  rec = unique_(rec).slice(0, 5);
  if (!rec.length && contacts.length) rec = [contacts[0].email];
  return {
    domain: clean_(j.domain).toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, ''),
    format: clean_(j.email_format), evidence: noDash_(clean_(j.email_format_evidence)),
    contacts: contacts, recommended: rec, notes: noDash_(clean_(j.notes)),
    hunterPattern: hunter && hunter.pattern ? hunter.pattern : ''
  };
}

/** Dashes used as punctuation become commas (hyphenated words like data-driven stay). */
function noDash_(s) { return String(s || '').replace(/\s*[\u2013\u2014]\s*/g, ', ').replace(/\s+-\s+/g, ', ').trim(); }

/** "Campus Recruiting Team" is a mailbox, not a person, so it never goes in Name of contact. */
function teamName_(n) {
  return /\b(team|recruit\w*|careers?|talent|hr|human resources|office|desk|campus|department|graduates?|university|relations|programmes?|programs?|events?|enquir\w*|inquir\w*|info|mailbox|inbox)\b/i.test(n);
}

function tidyParagraph_(p) {
  return String(p || '')
    .replace(/\s*[\u2014\u2013]\s*/g, ', ')
    .replace(/\s+-\s+/g, ', ')
    .replace(/'/g, '\u2019')
    .replace(/^["\u201c\u201d\s]+|["\u201c\u201d\s]+$/g, '')
    .replace(/,\s*,/g, ',')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Optional: Hunter.io domain search (free plan: 25 searches a month). */
function hunterLookup_(firm) {
  const key = PropertiesService.getScriptProperties().getProperty('HUNTER_API_KEY');
  if (!key) return null;
  try {
    const url = 'https://api.hunter.io/v2/domain-search?company=' + encodeURIComponent(firm) +
      '&department=hr&limit=10&api_key=' + encodeURIComponent(key);
    const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return null;
    const d = JSON.parse(res.getContentText()).data || {};
    return {
      domain: d.domain || '', pattern: d.pattern || '',
      emails: (d.emails || []).slice(0, 10).map(function (x) {
        return {
          email: x.value, name: [x.first_name, x.last_name].filter(function (v) { return v; }).join(' '),
          position: x.position || '', confidence: x.confidence || ''
        };
      })
    };
  } catch (err) { return null; }
}

// ===== 7b. Free research bot: Tavily web search plus a Groq model ===========================
// Tavily (app.tavily.com) and Groq (console.groq.com) both have free plans with no card.
// Tavily finds pages and the script itself pulls every email address off those pages. The Groq
// model then picks the contacts and writes the paragraph from those results only, and the script
// checks its answer against the pages, so an address or name it made up never reaches the sheet.

const TAVILY_URL = 'https://api.tavily.com/search';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODELS_URL = 'https://api.groq.com/openai/v1/models';

// Words that do not identify a firm, ignored when matching an email domain to the firm's name.
const FIRM_FILLER = ['the', 'and', 'group', 'capital', 'partners', 'llc', 'llp', 'ltd', 'limited', 'plc', 'inc',
  'company', 'securities', 'management', 'investments', 'investment', 'trading', 'asset', 'global', 'holdings',
  'markets', 'financial', 'fund', 'funds', 'bank', 'research', 'technologies', 'technology', 'international', 'uk'];

function researchKeysMissing_() {
  const p = PropertiesService.getScriptProperties();
  return [['TAVILY_API_KEY', 'Tavily key'], ['GROQ_API_KEY', 'Groq key']]
    .filter(function (k) { return !p.getProperty(k[0]); }).map(function (k) { return k[1]; });
}

/** An error that pauses research for a while instead of failing the row. */
function limitError_(message, minutes) {
  const err = new Error(message);
  err.pauseMinutes = minutes;
  return err;
}

function tavilySearch_(query, extra) {
  const key = PropertiesService.getScriptProperties().getProperty('TAVILY_API_KEY');
  if (!key) throw new Error('no Tavily key (Sponsor Outreach > Set Tavily key)');
  const body = { query: query, search_depth: 'basic', max_results: 5, include_answer: false };
  Object.keys(extra || {}).forEach(function (k) { body[k] = extra[k]; });
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = UrlFetchApp.fetch(TAVILY_URL, {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { Authorization: 'Bearer ' + key }, payload: JSON.stringify(body)
    });
    const code = res.getResponseCode();
    if (code === 200) return JSON.parse(res.getContentText()).results || [];
    if (code === 432 || code === 433) throw limitError_('the free Tavily searches for this month are used up', 24 * 60);
    if (code === 401) throw new Error('the Tavily key was rejected');
    if ((code === 429 || code >= 500) && attempt < 3) { Utilities.sleep(5000 * attempt); continue; }
    if (code === 429) throw limitError_('Tavily is rate limiting', 15);
    throw new Error('Tavily error ' + code + ': ' + res.getContentText().slice(0, 200));
  }
  throw limitError_('Tavily is busy', 15);
}

/** Tavily results trimmed to what research needs, cached for 6 hours so a retry costs no searches. */
function tavilyCached_(query, extra) {
  const cache = CacheService.getScriptCache();
  const key = 'tv:' + Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, query + '|' + JSON.stringify(extra || {})));
  const hit = cache.get(key);
  if (hit) return JSON.parse(hit);
  const results = tavilySearch_(query, extra).map(function (r) {
    return {
      title: clip_(r.title, 160), url: String(r.url || ''), content: clip_(r.content, 700),
      emails: emailContexts_(String(r.raw_content || '') + '\n' + String(r.content || '')).slice(0, 15)
    };
  });
  const json = JSON.stringify(results);
  if (json.length < 90000) { try { cache.put(key, json, 21600); } catch (err) { /* too big to cache */ } }
  return results;
}

function groqChat_(model, system, user, effort, maxTokens) {
  const key = PropertiesService.getScriptProperties().getProperty('GROQ_API_KEY');
  if (!key) throw new Error('no Groq key (Sponsor Outreach > Set Groq key)');
  const body = {
    model: model, temperature: 0.3, max_completion_tokens: maxTokens,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }]
  };
  if (/gpt-oss/i.test(model)) { body.reasoning_effort = effort; body.include_reasoning = false; }
  let slept = 0;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = UrlFetchApp.fetch(GROQ_URL, {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { Authorization: 'Bearer ' + key }, payload: JSON.stringify(body)
    });
    const code = res.getResponseCode();
    if (code === 200) {
      const j = JSON.parse(res.getContentText());
      const choice = j.choices && j.choices[0];
      const content = choice && choice.message && choice.message.content;
      if (!content) {
        throw new Error(choice && choice.finish_reason === 'length' ? 'the free model ran out of room, try again'
          : 'the free model returned an empty answer');
      }
      return content;
    }
    if (code === 429 || code === 498 || code >= 500) {
      // A short wait is the per minute limit; a long one means the daily limit is used up.
      const wait = retryAfter_(res) || 10 * attempt;
      if (wait > 45 || slept + wait > 60 || attempt === 3) {
        throw limitError_('the free Groq limit is used up for now', wait > 45 ? Math.max(30, Math.ceil(wait / 60)) : 10);
      }
      Utilities.sleep(Math.ceil(wait * 1000) + 500);
      slept += wait;
      continue;
    }
    let detail = res.getContentText();
    try { const j = JSON.parse(detail); detail = (j.error && j.error.message) || detail; } catch (err) { /* not JSON */ }
    if (code === 401) throw new Error('the Groq key was rejected');
    if (code === 413) throw new Error('the search results were too long for the free model; lower "Web searches for contacts" on the settings tab');
    throw new Error('Groq error ' + code + ': ' + String(detail).slice(0, 250));
  }
  throw limitError_('Groq is busy', 10);
}

/** Asks the model and reads the JSON at the end of its answer, asking once more if the JSON is broken. */
function groqJson_(model, system, user, effort, maxTokens) {
  const first = groqChat_(model, system, user, effort, maxTokens);
  try { return extractJson_(first); } catch (err) { /* ask once more below */ }
  return extractJson_(groqChat_(model, system, user + '\n\nYour last reply did not end with valid JSON. ' +
    'Reply again, ending with the JSON object inside <json></json> tags.', effort, maxTokens));
}

function retryAfter_(res) {
  const h = (res.getHeaders && res.getHeaders()) || {};
  const k = Object.keys(h).filter(function (x) { return x.toLowerCase() === 'retry-after'; })[0];
  const v = k ? parseFloat(h[k]) : NaN;
  return isNaN(v) ? 0 : v;
}

function testGroqKey_(key) {
  try {
    const res = UrlFetchApp.fetch(GROQ_MODELS_URL, { method: 'get', muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + key } });
    return res.getResponseCode() === 200 ? true : 'error ' + res.getResponseCode() + ' ' + res.getContentText().slice(0, 150);
  } catch (err) { return msg_(err); }
}

/** Every email address in a page with the text around it. Placeholders and no reply addresses are skipped. */
function emailContexts_(text) {
  const out = [], seen = {};
  const re = /[a-z0-9._%+'-]+@(?:[a-z0-9-]+\.)+[a-z]{2,}/gi;
  let m;
  while ((m = re.exec(text)) !== null && out.length < 40) {
    const email = extractEmails_(m[0])[0];
    if (!email || seen[email] || junkEmail_(email)) continue;
    seen[email] = true;
    out.push({
      email: email,
      context: text.slice(Math.max(0, m.index - 140), Math.min(text.length, m.index + m[0].length + 140)).replace(/\s+/g, ' ').trim()
    });
  }
  return out;
}

function junkEmail_(e) {
  return /^(no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|example|test|your|yourname|youremail|name|email|user|username|first|firstname|first[._]?last|firstname[._]?lastname|flast|f\.?last|john|jane|j\.?doe|john[._]?doe|jane[._]?doe|j\.?smith|john[._]?smith|jane[._]?smith)@/i.test(e) ||
    /@(.*\.)?(example\.(com|org|net)|sentry\.io|wixpress\.com|domain\.com|email\.com|yourcompany\.com|company\.com|yourdomain\.com|mysite\.com|companyname\.com)$/i.test(e);
}

function emailScore_(h) {
  const t = (h.email + ' ' + h.context).toLowerCase();
  return (t.match(/campus|graduate|grad|recruit|career|early|universit|student|intern|talent|people|sponsor|event|partner|emea|london|\buk\b/g) || []).length;
}

/** Runs the searches and collects numbered sources plus every email address found on them. */
function gatherEvidence_(searches) {
  const sources = [], byUrl = {}, emails = {}, order = [];
  searches.forEach(function (sq) {
    tavilyCached_(sq.q, sq.extra).forEach(function (r) {
      if (!r.url || byUrl[r.url]) return;
      byUrl[r.url] = true;
      sources.push({ n: sources.length + 1, title: r.title, url: r.url, content: r.content });
      (r.emails || []).forEach(function (h) {
        if (emails[h.email]) return;
        emails[h.email] = { email: h.email, url: r.url, n: sources.length, context: h.context };
        order.push(h.email);
      });
    });
  });
  const ranked = order.map(function (e) { return emails[e]; })
    .filter(function (h) { return FREE_MAIL.indexOf(domainOf_(h.email)) === -1; })
    .sort(function (a, b) { return emailScore_(b) - emailScore_(a); }).slice(0, 20);
  const text = (sources.map(function (x) { return x.title + ' ' + x.content; }).join(' ') + ' ' +
    ranked.map(function (x) { return x.context; }).join(' ')).toLowerCase();
  return { sources: sources, emails: ranked, allEmails: emails, text: text };
}

function sourcesBlock_(ev, chars) {
  return ev.sources.map(function (x) {
    return '[' + x.n + '] ' + x.title + ' | ' + x.url + '\n' + clip_(x.content, chars);
  }).join('\n\n');
}

function contactsSystem_(s) {
  return [
    'You research corporate contacts for ' + s.orgName + ', ' + s.orgDescription + ', which is looking for sponsors',
    'and recruiting partners for the ' + s.academicYear + ' academic year.',
    'You only have the web search results and email list given to you; never use your memory for an address or a name.',
    '',
    'Rules:',
    '- Label an address "published" (a person) or "role_mailbox" (a shared inbox) only if it is in the email list.',
    '- An address you build from the firm\'s email format must be labelled "pattern_guess", and only for a person',
    '  named in the search results, using a format the results give evidence for.',
    '- Prefer UK or EMEA contacts for campus recruiting, university relations, early careers, graduate recruitment,',
    '  talent acquisition, HR, events or sponsorship. Never personal addresses.',
    '- At most 6 contacts. Recommend every relevant address, up to 3 (for example the campus recruitment mailbox',
    '  and the named campus recruiter). Never recommend press, media, investor or sales addresses.',
    '- End your reply with one JSON object inside <json></json> tags and nothing after it.'
  ].join('\n');
}

function contactsPrompt_(firm, ev, hunter) {
  const parts = ['Firm: ' + firm, '', 'Web search results:', sourcesBlock_(ev, 350), ''];
  parts.push('Email addresses that appear on those pages (only these can be published or role_mailbox):');
  parts.push(ev.emails.length ? ev.emails.map(function (h) {
    return '- ' + h.email + ' (source [' + h.n + ']): "' + clip_(h.context, 200) + '"';
  }).join('\n') : '(none found)');
  if (hunter) parts.push('', 'Data from Hunter.io (an email finding service):', JSON.stringify(hunter));
  parts.push('',
    'Find the firm\'s main email domain, its email format (with the evidence), up to 6 relevant contacts and every',
    'good address (up to 3) for a sponsorship and partnership enquiry from a student society.',
    '',
    'Reply format:',
    '<json>',
    '{"domain": "example.com", "email_format": "{first}.{last}@example.com or null",',
    ' "email_format_evidence": "short note naming the source number",',
    ' "contacts": [{"name": "Full name, or null for a mailbox", "role": "job title or mailbox purpose",',
    '   "email": "address", "email_type": "published | role_mailbox | pattern_guess",',
    '   "region": "UK | EMEA | US | APAC | Global | Unknown", "confidence": "high | medium | low",',
    '   "source_url": "a URL from the results"}],',
    ' "recommended": ["best@example.com", "second@example.com"], "notes": "one or two sentences on why"}',
    '</json>');
  return parts.join('\n');
}

function researchContacts_(firm, s) {
  const hunter = hunterLookup_(firm);
  const queries = [
    firm + ' campus recruitment email UK',
    firm + ' graduate early careers recruiting contact email',
    firm + ' email format employees',
    firm + ' university relations EMEA contact',
    firm + ' student society sponsorship contact'
  ].slice(0, s.contactSearches);
  const ev = gatherEvidence_(queries.map(function (q) {
    return { q: q, extra: { include_raw_content: true, max_results: 5 } };
  }));
  if (!ev.sources.length) throw new Error('the web search found nothing for ' + firm);
  const j = groqJson_(s.freeContactModel, contactsSystem_(s), contactsPrompt_(firm, ev, hunter), 'low', 2500);
  return verifyContacts_(normaliseContacts_(j, hunter), ev, hunter, firm, s.maxEmails);
}

// Words in an address or job title that make a contact right, or wrong, for a sponsorship enquiry.
const RELEVANT_CONTACT = /campus|graduate|\bgrads?\b|recruit|career|early|universit|student|intern|talent|\bhr\b|human resources|people|sponsor|partner|event|outreach|diversity|emerging/i;
const IRRELEVANT_CONTACT = /\b(media|press|pr|news|newsroom|investors?|ir|legal|privacy|gdpr|dpo|data protection|compliance|abuse|security|sales|support|helpdesk|billing|accounts|invoices?|procurement|webmaster|marketing|complaints|clients?|customers?)\b/i;

/**
 * Checks the model's answer against the pages so nothing it made up reaches the sheet:
 * a published address must appear on a page (or in Hunter's data) and belong to the firm,
 * a name must appear in the results, and a guessed address is rebuilt by the script from an
 * email format the results back up, for a person named in them. Every relevant address that
 * passes goes in the Email column (up to max), addresses seen on a page first.
 */
function verifyContacts_(c, ev, hunter, firm, max) {
  const known = {};
  Object.keys(ev.allEmails).forEach(function (e) { known[e] = ev.allEmails[e].url; });
  ((hunter && hunter.emails) || []).forEach(function (h) {
    const e = extractEmails_(h.email)[0];
    if (e && !known[e]) known[e] = 'Hunter.io';
  });
  const hunterText = JSON.stringify(hunter || {}).toLowerCase();
  const names = plainText_(ev.text + ' ' + hunterText);
  if (c.domain && !(hunter && hunter.domain === c.domain) && (ev.text + hunterText).indexOf(c.domain) === -1 &&
      !ev.sources.some(function (x) { return underDomain_(hostOf_(x.url), c.domain); })) {
    c.domain = '';
  }
  const template = formatTemplate_(c.format) || formatTemplate_(hunter && hunter.pattern);
  const canGuess = !!(c.domain && template && formatSupported_(template, c, ev, hunter, firm));
  const list = c.contacts.slice();
  c.recommended.forEach(function (e) {
    if (!list.some(function (x) { return x.email === e; })) list.push({ name: '', role: '', email: e, type: '', region: '', confidence: '', source: '' });
  });
  const remap = {}, kept = [], dropped = [];
  list.forEach(function (x) {
    const original = x.email;
    if (x.name && !nameInText_(x.name, names)) x.name = ''; // never put an unchecked name in column B
    const fromResults = ev.sources.some(function (y) { return y.url === x.source; });
    if (known[x.email]) {
      if (!firmAddress_(x.email, firm, c.domain)) { dropped.push(original); return; }
      if (x.type !== 'published' && x.type !== 'role_mailbox') x.type = x.name ? 'published' : 'role_mailbox';
      if (x.type === 'role_mailbox') x.name = '';
      if (!fromResults) x.source = known[x.email];
    } else {
      const guess = canGuess && x.name ? guessEmail_(template, x.name, c.domain) : '';
      if (!guess) { dropped.push(original); return; }
      x.email = guess;
      x.type = 'pattern_guess';
      if (x.confidence !== 'low') x.confidence = 'medium';
      if (!fromResults) x.source = '';
    }
    remap[original] = x.email;
    if (!kept.some(function (k) { return k.email === x.email; })) kept.push(x);
  });
  const picked = c.recommended.map(function (e) { return remap[e] || ''; }).filter(function (e) { return e; });
  const seen = function (e) { return !!known[e]; };
  const local = function (x) { return x.email.split('@')[0].replace(/[._-]+/g, ' '); };
  // Relevant contacts: campus, graduate, recruiting, HR, events or sponsorship, or picked by the model.
  // Press, investor, sales and similar mailboxes never go in the Email column.
  const useful = kept.filter(function (x) {
    if (IRRELEVANT_CONTACT.test(local(x))) return false;
    const fits = RELEVANT_CONTACT.test(local(x) + ' ' + x.role);
    if (!fits && IRRELEVANT_CONTACT.test(x.role)) return false;
    return fits || picked.indexOf(x.email) !== -1;
  });
  // Addresses seen on a page first, then the model's picks, otherwise in the model's order.
  const rank = function (x) { return (seen(x.email) ? 2 : 0) + (picked.indexOf(x.email) !== -1 ? 1 : 0); };
  useful.sort(function (a, b) { return rank(b) - rank(a); });
  c.contacts = kept.slice(0, 8);
  c.recommended = useful.slice(0, max || 3).map(function (x) { return x.email; });
  c.dropped = unique_(dropped);
  if (!canGuess) c.format = c.format ? c.format + ' (not confirmed by the pages, so no addresses were guessed)' : '';
  return c;
}

/** "{first}.{last}@x.com", "first.last", "FirstName.LastName" or Hunter's "{f}{last}" become a template like {first}.{last}. */
function formatTemplate_(format) {
  const t = String(format || '').toLowerCase().replace(/\s+/g, '').split('@')[0]
    .replace(/[\[<(]/g, '{').replace(/[\]>)]/g, '}')
    .replace(/\{first_?initial\}/g, '{f}').replace(/\{last_?initial\}/g, '{l}')
    .replace(/\{?(firstname|first_name|first)\}?/g, '{first}')
    .replace(/\{?(lastname|last_name|last)\}?/g, '{last}')
    .replace(/(^|[._-]|\})([fl])(?=$|[._-]|\{)/g, '$1{$2}');
  if (!/\{(first|last)\}/.test(t) || !/^[._-]*$/.test(t.replace(/\{(first|last|f|l)\}/g, ''))) return '';
  return t;
}

/** The format counts as backed up by Hunter, by a page that shows it, or by an email format page about the firm. */
function formatSupported_(template, c, ev, hunter, firm) {
  if (hunter && hunter.pattern && formatTemplate_(hunter.pattern) === template) return true;
  const shown = ev.text.replace(/[\[\]{}<>]/g, '').replace(/first_?name/g, 'first').replace(/last_?name/g, 'last')
    .replace(/first_?initial/g, 'f').replace(/last_?initial/g, 'l');
  if (shown.indexOf(template.replace(/[{}]/g, '') + '@' + c.domain) !== -1) return true;
  return ev.sources.some(function (x) {
    const t = (x.title + ' ' + x.content).toLowerCase();
    return /e-?mail (address )?(format|pattern)/.test(t) && (t.indexOf(c.domain) !== -1 || firmWords_(firm).every(function (w) { return t.indexOf(w) !== -1; }));
  });
}

function guessEmail_(template, name, domain) {
  const parts = nameParts_(name);
  if (parts.length < 2) return '';
  const first = parts[0], last = parts[parts.length - 1];
  const local = template.replace(/\{first\}/g, first).replace(/\{last\}/g, last)
    .replace(/\{f\}/g, first[0]).replace(/\{l\}/g, last[0]);
  return /^[a-z0-9]+([._-][a-z0-9]+)*$/.test(local) ? local + '@' + domain : '';
}

function nameParts_(name) {
  return plainText_(name).replace(/\(.*?\)/g, ' ').replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(function (p) {
    return p.length > 1 && !/^(mr|mrs|ms|miss|mx|dr|prof|jr|sr|ii|iii|iv)$/.test(p);
  });
}

function nameInText_(name, text) {
  const parts = nameParts_(name);
  if (parts.length < 2) return false;
  return [parts[0], parts[parts.length - 1]].every(function (p) { return new RegExp('\\b' + p + '\\b').test(text); });
}

/** Lower case without accents, apostrophes or hyphens, so O'Brien and Obrien compare equal. */
function plainText_(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/['\u2019-]/g, '');
}

function firmWords_(firm) {
  return String(firm || '').toLowerCase().split(/[^a-z0-9]+/).filter(function (w) {
    return w.length >= 3 && FIRM_FILLER.indexOf(w) === -1;
  });
}

/** True when the address is at the firm's domain, or its domain contains a word of the firm's name. */
function firmAddress_(email, firm, domain) {
  const d = domainOf_(email);
  if (domain && underDomain_(d, domain)) return true;
  const base = d.split('.')[0];
  return firmWords_(firm).some(function (w) { return base.indexOf(w) !== -1; });
}

function underDomain_(host, domain) {
  return !!domain && (host === domain || host.slice(-(domain.length + 1)) === '.' + domain);
}

function paragraphPrompt_(firm, ev, s) {
  return [
    'Firm: ' + firm,
    '',
    'Web search results:',
    sourcesBlock_(ev, 600),
    '',
    'Using only facts from these results, write the personalised paragraph for our sponsorship letter.',
    '',
    'Structure: three sentences, 75 to 110 words.',
    '1. Start with "Given ' + firm + '\u2019s" and its strength, commitment or expertise (for example quantitative research,',
    '   market making, systematic investing, technology), then ", we believe there is a strong alignment with the interests of our members."',
    '2. Start with "We were particularly interested in" and name one specific thing from the results: an area of research,',
    '   trading approach, technology focus, graduate programme, recent initiative or company value.',
    '3. Say how that aligns with our members\u2019 interests (' + s.memberInterests + ') and end by saying we would be very',
    '   interested in exploring a partnership with ' + firm + ' (or building a partnership around that shared interest).',
    '',
    'Two examples of the style we want:',
    'Example 1: ' + PARAGRAPH_EXAMPLES[0],
    'Example 2: ' + PARAGRAPH_EXAMPLES[1],
    '',
    'Rules:',
    '- Every factual claim must come from the results above. Do not invent teams, programmes, products or figures.',
    '- Use your own words; never copy sentences from a result.',
    '- British spelling. Never use a dash as punctuation (no em dash, no en dash). Hyphenated words like data-driven are fine.',
    '- No quotation marks, exclamation marks or lists. Call the firm "' + firm + '".',
    '',
    'End your reply with one JSON object inside <json></json> tags and nothing after it:',
    '<json>{"paragraph": "...", "fact_used": "one line naming the specific fact", "sources": [numbers of the results you used]}</json>'
  ].join('\n');
}

function writeParagraph_(firm, domain, s) {
  const year = fmt_(new Date(), 'yyyy');
  const searches = [
    { q: firm + ' news ' + year, extra: { topic: 'news', time_range: 'year', max_results: 5 } },
    { q: firm + (domain ? ' ' + domain : '') + ' technology research engineering machine learning', extra: { max_results: 5 } },
    { q: firm + ' graduate programme internships students UK', extra: { max_results: 5 } }
  ].slice(0, s.paragraphSearches);
  const ev = gatherEvidence_(searches);
  if (!ev.sources.length) throw new Error('the web search found nothing to base the paragraph on');
  const j = groqJson_(s.freeWritingModel, paragraphSystem_(s), paragraphPrompt_(firm, ev, s), 'medium', 3000);
  const p = tidyParagraph_(clean_(j.paragraph));
  if (p.split(/\s+/).length < 30) throw new Error('the paragraph came back empty or too short');
  if (p.toLowerCase().indexOf(firm.toLowerCase()) === -1) throw new Error('the paragraph does not name ' + firm);
  const urls = unique_((Array.isArray(j.sources) ? j.sources : [j.sources]).map(function (x) {
    const u = clean_(x);
    if (/^https?:\/\//i.test(u)) return ev.sources.some(function (y) { return y.url === u; }) ? u : '';
    const n = parseInt(u.replace(/\D/g, ''), 10);
    return n >= 1 && n <= ev.sources.length ? ev.sources[n - 1].url : '';
  }).filter(function (u) { return u; })).slice(0, 4);
  return { paragraph: p, fact: noDash_(clean_(j.fact_used)), sources: urls.length ? urls : [ev.sources[0].url] };
}

function clip_(s, n) { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; }
function hostOf_(url) { return String(url || '').replace(/^https?:\/\//i, '').split(/[\/?#:]/)[0].replace(/^www\./i, '').toLowerCase(); }

// ===== 8. Drafting ==========================================================================

/** Draft email? = Yes. Writes the paragraph first if needed, then creates or updates the draft. */
function processDraftRequest_(sheet, r, s) {
  const row = readRow_(sheet, r);
  if (normChoice_(row.draftChoice) !== 'yes') return;
  if (!row.paragraph && !row.threadId) {
    if (/^researching/i.test(row.research) && CacheService.getScriptCache().get(claimKey_(row.firm))) {
      setNext_(sheet, r, 'Waiting for research to finish, the draft follows automatically', null);
      return;
    }
    if (!row.firm || !row.emails.length) {
      withLock_(function () { draftFailed_(sheet, r, !row.firm ? 'no firm name in column A' : 'no email address in column D'); }, 20000);
      return;
    }
    setVal_(sheet, r, COL.NEXT, 'Writing the personalised paragraph…');
    SpreadsheetApp.flush();
    if (!claimResearch_(sheet, r, row.firm)) return;
    let para = null, problem = '';
    try { para = writeParagraph_(row.firm, domainOf_(row.emails[0]), s); }
    catch (err) { problem = msg_(err); }
    finally { releaseResearch_(row.firm); }
    let rr = -1;
    withLock_(function () {
      rr = relocate_(sheet, r, row.firm);
      if (rr < 0) return;
      if (!para) {
        setVal_(sheet, rr, COL.RESEARCH, 'Paragraph failed ' + d_(new Date()) + ': ' + problem);
        draftFailed_(sheet, rr, 'could not write the paragraph (' + problem + ')');
        return;
      }
      setVal_(sheet, rr, COL.PARAGRAPH, para.paragraph);
      const old = readRow_(sheet, rr).research;
      setVal_(sheet, rr, COL.RESEARCH, ('Paragraph written ' + d_(new Date()) + '\n' + paragraphNotes_(para) +
        (old && !/^(queued|researching)/i.test(old) ? '\n\n' + old : '')).slice(0, 45000));
    }, 60000);
    if (rr < 0 || !para) return;
    r = rr;
  }
  const ran = withLock_(function () {
    const rr = relocate_(sheet, r, row.firm);
    if (rr > 0) createOrUpdateDraft_(sheet, rr, s);
  }, 30000);
  if (!ran) setVal_(sheet, r, COL.NEXT, 'Busy: the draft will be made within 10 minutes');
}

function draftFailed_(sheet, r, reason) {
  setVal_(sheet, r, COL.DRAFT, '');
  setNext_(sheet, r, 'Not drafted: ' + reason, readRow_(sheet, r).nextAt);
  logEvent_(sheet, r, 'Not drafted ' + d_(new Date()) + ': ' + reason);
}

/** Must run inside the script lock. */
function createOrUpdateDraft_(sheet, r, s) {
  const row = readRow_(sheet, r);
  const now = new Date();
  if (normChoice_(row.draftChoice) !== 'yes') return;
  if (row.threadId) {
    setVal_(sheet, r, COL.DRAFT, 'Drafted');
    logEvent_(sheet, r, 'No new draft ' + d_(now) + ': this firm was already emailed (see thread)');
    return;
  }
  if (!row.firm) return draftFailed_(sheet, r, 'no firm name in column A');
  if (!row.emails.length) return draftFailed_(sheet, r, 'no email address in column D');
  const sender = resolveSender_(row.sender);
  if (sender.error) return draftFailed_(sheet, r, sender.error);
  if (!row.paragraph) return draftFailed_(sheet, r, 'the personalised paragraph (column P) is empty');

  const earlier = findSeasonThreads_(row.emails, s);
  if (earlier.length) {
    logEvent_(sheet, r, 'Not drafted ' + d_(now) + ': ' + earlier[0].to.join(', ') + ' was already emailed on ' + d_(earlier[0].date));
    setVal_(sheet, r, COL.DRAFT, '');
    adoptThread_(sheet, r, earlier, s);
    return;
  }

  let blob;
  try { blob = prospectusBlob_(s); } catch (err) { return draftFailed_(sheet, r, msg_(err)); }
  const email = buildInitialEmail_(row, sender, s);
  const options = { htmlBody: email.html, from: sender.email, name: sender.name, attachments: [blob] };
  if (s.replyTo) options.replyTo = s.replyTo;
  const to = row.emails.join(',');
  const existing = row.draftId ? getDraft_(row.draftId) : null;
  const draft = existing ? existing.update(to, s.subject, email.text, options) : GmailApp.createDraft(to, s.subject, email.text, options);

  setText_(sheet, r, COL.DRAFT_ID, draft.getId());
  setVal_(sheet, r, COL.DRAFT, 'Drafted');
  // Status shows Drafting (when the dropdown has it) until the email is sent.
  if (notSentYet_(row.status) && normStatus_(row.status) !== normStatus_(STATUS_DRAFTING)) setStatus_(sheet, r, STATUS_DRAFTING);
  if (!row.fuDays) setVal_(sheet, r, COL.FU_DAYS, s.defaultDays);
  let fuNote = '';
  if (s.fuOnWhenDrafting && !row.fuOn && !existing && row.log.indexOf('Follow ups switched on') === -1) {
    setVal_(sheet, r, COL.FU_ON, true);
    fuNote = '; Follow ups switched on, every ' + (row.fuDays || s.defaultDays) + ' days';
  }
  setNext_(sheet, r, 'Draft ready in Gmail: check it, then choose an option in Send', null);
  logEvent_(sheet, r, (existing ? 'Draft updated ' : 'Draft created ') + d_(now) + ' (' + sender.name + ' to ' +
    row.emails.join(', ') + ')' + (row.nextAt ? '; scheduled send cancelled, choose Send again' : '') + fuNote);
  const others = domainSeasonThreads_(row.emails, s);
  if (others.length) {
    logEvent_(sheet, r, 'Note: ' + others[0].to.join(', ') + ' at the same firm was emailed on ' + d_(others[0].date), { once: true });
  }
}

function getDraft_(id) {
  if (!id) return null;
  try { return GmailApp.getDraft(id) || null; } catch (err) { return null; }
}

function prospectusBlob_(s) {
  if (CACHE.prospectus) return CACHE.prospectus;
  if (!s.prospectus) throw new Error('add the prospectus Google Drive link on the ' + APP.SETTINGS_SHEET + ' sheet');
  const id = driveId_(s.prospectus);
  if (!id) throw new Error('the prospectus link on the ' + APP.SETTINGS_SHEET + ' sheet is not a Google Drive link');
  let file;
  try { file = DriveApp.getFileById(id); }
  catch (err) { throw new Error('cannot open the prospectus in Drive (does this account have access?)'); }
  const type = file.getMimeType();
  const blob = (type === MimeType.GOOGLE_DOCS || type === MimeType.GOOGLE_SLIDES)
    ? file.getAs(MimeType.PDF).setName(file.getName() + '.pdf') : file.getBlob();
  if (blob.getBytes().length > 20 * 1024 * 1024) throw new Error('the prospectus is over 20 MB, too big for Gmail');
  CACHE.prospectus = blob;
  return blob;
}

function driveId_(link) {
  const s = String(link || '').trim();
  const m = s.match(/\/d\/([a-zA-Z0-9_-]{20,})/) || s.match(/[?&]id=([a-zA-Z0-9_-]{20,})/);
  if (m) return m[1];
  return /^[a-zA-Z0-9_-]{20,}$/.test(s) ? s : '';
}

function buildInitialEmail_(row, sender, s) {
  const greeting = greeting_(row, s, false);
  const html = fill_(templateText_('InitialEmail'), {
    INTRO_GREETING: esc_(greeting) + ',',
    LETTER_GREETING: esc_(greeting),
    FIRM_NAME: esc_(row.firm),
    FIRM_POSSESSIVE: esc_(possessive_(row.firm)),
    PERSONALISED_PARAGRAPH: esc_(curly_(row.paragraph)),
    ACADEMIC_YEAR: esc_(s.academicYear),
    ORG_NAME: esc_(s.orgName),
    ORG_DESCRIPTION: esc_(s.orgDescription),
    MEMBER_INTERESTS: esc_(s.memberInterests),
    SENDER_NAME: esc_(sender.name),
    SIGNATURE: signatureHtml_(sender, s)
  });
  return { html: html, text: htmlToText_(html) };
}

function buildFollowUp_(row, sender, s, note) {
  const html = fill_(templateText_('FollowUp'), {
    GREETING: esc_(greeting_(row, s, true)),
    FIRM_NAME: esc_(row.firm),
    ACADEMIC_YEAR: esc_(s.academicYear),
    EXTRA_NOTE: note ? '<p>' + esc_(note).replace(/\r?\n/g, '<br />') + '</p>' : '',
    SENDER_NAME: esc_(sender.name),
    SENDER_TITLE_LINE: sender.title ? esc_(sender.title) + '<br />' : '',
    ORG_NAME: esc_(s.orgName),
    ORG_DESCRIPTION: esc_(s.orgDescription),
    MEMBER_INTERESTS: esc_(s.memberInterests)
  });
  return { html: html, text: htmlToText_(html) };
}

function templateText_(name) { return HtmlService.createTemplateFromFile(name).getRawContent(); }

function signatureHtml_(sender, s) {
  const out = [];
  if (sender.signatureUrl) {
    out.push('<tr><td style="padding: 10px 0px 15px 0px" align="left"><img style="padding-bottom:5px" src="' +
      escAttr_(sender.signatureUrl) + '" width="120" alt="" /></td></tr>');
    out.push('<tr><td>' + esc_(sender.name) + '</td></tr>');
  } else {
    out.push('<tr><td style="padding-top: 10px">' + esc_(sender.name) + '</td></tr>');
  }
  const lines = [];
  if (sender.title) lines.push(esc_(sender.title));
  if (s.orgLine || s.orgName) lines.push(esc_(s.orgLine || s.orgName));
  if (sender.phone) lines.push('Phone: ' + esc_(sender.phone));
  lines.push('Email: <a href="mailto:' + escAttr_(sender.email) + '" target="_top" style="color:black; text-decoration:none">' +
    esc_(sender.email) + '</a>');
  out.push('<tr><td><p>' + lines.join('<br />\n') + '</p></td></tr>');
  return out.join('\n');
}

function greeting_(row, s, followUp) {
  // A first name only makes sense when the email goes to one person.
  const first = s.greetByName && row.emails.length === 1 ? firstName_(row.contact) : '';
  if (first) return 'Dear ' + first;
  return followUp ? 'Dear ' + row.firm + ' Team' : 'Dear Sir/Madam';
}

// ===== 9. Sending the first email ===========================================================

/** Handles the Send column. Must run inside the script lock. */
function applySendChoice_(sheet, r, s) {
  const row = readRow_(sheet, r);
  const choice = normChoice_(row.sendChoice);
  if (!choice) return;
  const now = new Date();
  setVal_(sheet, r, COL.SEND, '');
  if (choice.indexOf('cancel') !== -1) {
    if (!row.threadId && row.nextAt) {
      setNext_(sheet, r, 'Draft ready (scheduled send cancelled)', null);
      logEvent_(sheet, r, 'Scheduled send cancelled ' + d_(now));
    }
    return;
  }
  if (row.threadId) { logEvent_(sheet, r, 'Send ignored ' + d_(now) + ': already sent'); return; }
  if (!row.draftId) {
    setNext_(sheet, r, 'Set Draft email? to Yes and check the draft before sending', null);
    logEvent_(sheet, r, 'Send ignored ' + d_(now) + ': no draft yet');
    return;
  }
  if (choice.indexOf('now') !== -1) {
    setNext_(sheet, r, 'Sending…', now);
    sendInitial_(sheet, r, s);
    return;
  }
  const when = choice.indexOf('tomorrow') !== -1 ? nextDayAt_(now, APP.SEND_HOUR)
    : choice.indexOf('monday') !== -1 ? nextMondayAt_(now, APP.SEND_HOUR) : null;
  if (!when) return;
  const weekend = londonParts_(when).dow >= 6 ? ' (a weekend)' : '';
  setNext_(sheet, r, 'First email scheduled for ' + dt_(when) + weekend, when);
  logEvent_(sheet, r, 'Scheduled for ' + dt_(when) + weekend);
}

/** Sends the row's Gmail draft after safety checks. Must run inside the script lock. */
function sendInitial_(sheet, r, s) {
  const row = readRow_(sheet, r);
  const now = new Date();
  const stop = function (reason) {
    setNext_(sheet, r, 'Not sent: ' + reason, null);
    logEvent_(sheet, r, 'Not sent ' + d_(now) + ': ' + reason);
    return false;
  };
  if (row.threadId) return stop('this row already has a sent email');
  if (!row.draftId) return stop('no draft, set Draft email? to Yes');
  if (!row.emails.length) return stop('no email address in column D');
  const sender = resolveSender_(row.sender);
  if (sender.error) return stop(sender.error);

  const draft = getDraft_(row.draftId);
  if (!draft) {
    setText_(sheet, r, COL.DRAFT_ID, '');
    setVal_(sheet, r, COL.DRAFT, '');
    const found = findSeasonThreads_(row.emails, s);
    if (found.length) {
      logEvent_(sheet, r, 'Not sent ' + d_(now) + ': the draft was already sent from Gmail');
      adoptThread_(sheet, r, found, s);
      return false;
    }
    return stop('the draft is no longer in Gmail, set Draft email? to Yes to make it again');
  }
  const msg = draft.getMessage();
  const to = extractEmails_([msg.getTo(), msg.getCc(), msg.getBcc()].join(','));
  if (!sameSet_(to, row.emails)) {
    return stop('the draft goes to ' + (to.join(', ') || 'nobody') + ' but column D has ' + row.emails.join(', ') +
      '. Set Draft email? to Yes to rebuild it');
  }
  if (!s.seasonRe.test(msg.getSubject())) return stop('the draft subject does not contain ' + s.seasonTag);
  const from = extractEmails_(msg.getFrom())[0] || '';
  if (from !== sender.email) {
    return stop('the draft is from ' + (from || 'unknown') + ' but Contacted by is ' + sender.name + '. Set Draft email? to Yes to rebuild it');
  }
  const body = msg.getBody();
  if (body.indexOf(esc_(row.firm)) === -1 && body.indexOf(row.firm) === -1) {
    return stop('the draft does not mention ' + row.firm + '. Set Draft email? to Yes to rebuild it');
  }
  if (!msg.getAttachments().length) return stop('the draft has no prospectus attached');

  const earlier = findSeasonThreads_(row.emails, s);
  if (earlier.length) {
    stop('already emailed ' + earlier[0].to.join(', ') + ' on ' + d_(earlier[0].date) +
      '. Delete the leftover draft in Gmail');
    adoptThread_(sheet, r, earlier, s);
    return false;
  }

  const sent = draft.send();
  const threadId = sent.getThread().getId();
  const rr = relocate_(sheet, r, row.firm, COL.DRAFT_ID, row.draftId);
  const target = rr > 0 ? rr : r;
  setText_(sheet, target, COL.THREAD_ID, threadId);
  setText_(sheet, target, COL.DRAFT_ID, '');
  setVal_(sheet, target, COL.DATE_EMAILED, 'Sent ' + d_(now));
  setVal_(sheet, target, COL.STATUS, statusLabel_(STATUS_WAITING) || STATUS_WAITING);
  setVal_(sheet, target, COL.FU_COUNT, 0);
  logEvent_(sheet, target, 'Sent ' + d_(now) + ' (' + sender.name + ' to ' + row.emails.join(', ') + ')');
  scheduleNextFollowUp_(sheet, target, readRow_(sheet, target), s, now, 0);
  SpreadsheetApp.flush();
  return true;
}

// ===== 10. Gmail sync and follow ups ========================================================

function runSync_(started, fromStart) {
  const sheet = trackerSheet_();
  if (!sheet) return true;
  const s = settings_();
  const props = PropertiesService.getScriptProperties();
  const cursor = fromStart ? APP.FIRST_ROW : Number(props.getProperty('SYNC_CURSOR') || 0);
  if (!cursor) return true;
  let finished = true;
  const ran = withLock_(function () {
    const rows = readRows_(sheet);
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (row.row < cursor) continue;
      if (late_(started)) { props.setProperty('SYNC_CURSOR', String(row.row)); finished = false; return; }
      if (!wantsSync_(row)) continue;
      CACHE.syncChecked = (CACHE.syncChecked || 0) + 1;
      safe_(sheet, row.row, function () { refreshRow_(sheet, row.row, s); });
    }
  }, 60000);
  if (!ran) { props.setProperty('SYNC_CURSOR', String(cursor)); return false; }
  if (finished) props.deleteProperty('SYNC_CURSOR');
  return finished;
}

function wantsSync_(row) {
  if (row.threadId) return isWaiting_(row.status);
  if (!row.emails.length) return false;
  return notSentYet_(row.status) || isWaiting_(row.status) || !!row.draftId;
}

/**
 * Brings one row in line with Gmail: links emails sent by hand, notices replies, bounce backs
 * and hand sent follow ups, and works out the next follow up. Must run inside the script lock.
 * Returns {analysis, due} when a follow up is scheduled, otherwise null.
 */
function refreshRow_(sheet, r, s) {
  const row = readRow_(sheet, r);
  const now = new Date();
  if (!row.threadId) {
    if (!row.emails.length) return null;
    const found = findSeasonThreads_(row.emails, s);
    if (found.length) { adoptThread_(sheet, r, found, s); return null; }
    if (row.draftId && !getDraft_(row.draftId)) {
      setText_(sheet, r, COL.DRAFT_ID, '');
      setVal_(sheet, r, COL.DRAFT, '');
      setNext_(sheet, r, 'Draft no longer in Gmail Drafts: if it was sent from Gmail it is linked at the next sync, ' +
        'otherwise set Draft email? to Yes to make it again', null);
      logEvent_(sheet, r, 'Draft not found in Gmail Drafts ' + d_(now));
    }
    return null;
  }
  let threadId = row.threadId;
  let meta = getThreadMeta_(threadId);
  if (!meta && row.emails.length) {
    const found = findSeasonThreads_(row.emails, s);
    const pick = found.length ? found[found.length - 1].threadId : '';
    if (pick && pick !== threadId) {
      threadId = pick;
      setText_(sheet, r, COL.THREAD_ID, pick);
      logEvent_(sheet, r, 'Thread re-linked ' + d_(now));
      meta = getThreadMeta_(pick);
    }
  }
  if (!meta) {
    setNext_(sheet, r, 'Thread not found in Gmail: was it sent from this account?', null);
    logEvent_(sheet, r, 'Thread not found ' + d_(now));
    return null;
  }
  return applyAnalysis_(sheet, r, row, analyzeThread_(meta, row.emails, ourAddresses_(), s), s, now);
}

/** Pure analysis of a Gmail thread (metadata format). */
function analyzeThread_(meta, rowEmails, ours, s) {
  const msgs = (meta.messages || []).map(parseMessage_).filter(function (m) {
    return m.labels.indexOf('DRAFT') === -1 && m.labels.indexOf('TRASH') === -1;
  });
  msgs.sort(function (a, b) { return a.date - b.date; });
  const outbound = msgs.filter(function (m) { return isOurs_(m, ours); });
  const a = { threadId: meta.id, messages: msgs, outbound: outbound, replies: [], bounces: [], autoReplies: [], problems: [],
    bounced: [], fullBounce: false };
  if (!outbound.length) { a.problems.push('no email from us in the thread'); return a; }
  const first = outbound[0];
  a.first = first;
  a.last = outbound[outbound.length - 1];
  a.subject = first.subject;
  a.followUpsSent = outbound.length - 1;
  a.recipients = unique_(extractEmails_([first.to, first.cc, first.bcc].join(','))).filter(function (e) { return !ours.has(e); });
  a.sendTo = a.recipients.filter(function (e) { return rowEmails.indexOf(e) !== -1; });
  if (!s.seasonRe.test(a.subject)) a.problems.push('the thread subject does not contain ' + s.seasonTag);
  if (!a.sendTo.length) a.problems.push('the email went to ' + (a.recipients.join(', ') || 'nobody') + ', which is not in column D');
  msgs.forEach(function (m) {
    if (isOurs_(m, ours) || m.date < first.date) return;
    if (isBounce_(m)) a.bounces.push(m);
    else if (isAutoReply_(m)) a.autoReplies.push(m);
    else a.replies.push(m);
  });
  // A bounce back that names only some of the recipients removes just those; follow ups carry on
  // to the others. A bounce that names nobody, or every recipient, stops the row.
  a.bounces.forEach(function (m) {
    const named = bouncedAddresses_(m, a.recipients);
    if (!named.length) a.fullBounce = true;
    named.forEach(function (e) {
      if (!a.bounced.some(function (b) { return b.email === e; })) a.bounced.push({ email: e, date: m.date });
    });
  });
  const live = a.sendTo.filter(function (e) { return !a.bounced.some(function (b) { return b.email === e; }); });
  if (a.bounces.length && !live.length) a.fullBounce = true;
  if (!a.fullBounce) a.sendTo = live;
  a.inReplyTo = a.last.messageId;
  a.references = unique_(msgs.map(function (m) { return m.messageId; }).filter(function (x) { return x; })).join(' ');
  return a;
}

function applyAnalysis_(sheet, r, row, a, s, now) {
  // Gmail lookups first, sheet writes after, so a row moved by a sort or insert meanwhile is found again.
  const blocked = a.fullBounce || a.replies.length || a.problems.length;
  const elsewhere = blocked ? null : activityElsewhere_(a, s);
  const rr = relocate_(sheet, r, row.firm, COL.THREAD_ID, a.threadId);
  if (rr < 0) return null;
  r = rr;
  if (a.outbound.length && a.followUpsSent !== row.fuCount) {
    for (let i = row.fuCount + 1; i <= a.followUpsSent; i++) {
      logEvent_(sheet, r, 'Followed up ' + d_(a.outbound[i].date) + ' (sent by hand, found in Gmail)', { once: true });
    }
    setVal_(sheet, r, COL.FU_COUNT, a.followUpsSent);
  }
  if (a.fullBounce) {
    logEvent_(sheet, r, 'Bounce back detected ' + d_(a.bounces[a.bounces.length - 1].date), { once: true });
    if (isWaiting_(row.status)) setStatus_(sheet, r, STATUS_BOUNCED);
    setNext_(sheet, r, 'Bounced: check the address (other contacts are in Research notes)', null);
    return null;
  }
  if (elsewhere && elsewhere.kind === 'partialBounce') {
    elsewhere.addresses.forEach(function (e) { a.bounced.push({ email: e, date: elsewhere.date }); });
    a.sendTo = a.sendTo.filter(function (e) { return elsewhere.addresses.indexOf(e) === -1; });
  }
  a.bounced.forEach(function (b) {
    logEvent_(sheet, r, 'Bounce back detected ' + d_(b.date) + ' for ' + b.email + ' (the other addresses still get follow ups)', { once: true });
  });
  if (a.replies.length) {
    const rep = a.replies[0];
    logEvent_(sheet, r, 'Reply received ' + d_(rep.date) + ' from ' + (extractEmails_(rep.from)[0] || rep.from), { once: true });
    if (isWaiting_(row.status)) setStatus_(sheet, r, STATUS_REPLIED);
    setNext_(sheet, r, 'Reply received ' + d_(rep.date) + ': follow ups stopped', null);
    return null;
  }
  if (a.problems.length) {
    logEvent_(sheet, r, 'Follow ups paused ' + d_(now) + ': ' + a.problems.join('; '));
    setNext_(sheet, r, 'Follow ups paused: ' + a.problems[0], null);
    return null;
  }
  a.autoReplies.forEach(function (m) {
    logEvent_(sheet, r, 'Auto reply received ' + d_(m.date) + ' (follow ups continue)', { once: true });
  });
  if (elsewhere && elsewhere.kind !== 'partialBounce') {
    logEvent_(sheet, r, elsewhere.kind === 'bounce'
      ? 'Bounce back detected ' + d_(elsewhere.date) + ' (separate email)'
      : 'Reply received ' + d_(elsewhere.date) + ' from ' + elsewhere.from + ' (separate email)', { once: true });
    if (isWaiting_(row.status)) setStatus_(sheet, r, elsewhere.kind === 'bounce' ? STATUS_BOUNCED : STATUS_REPLIED);
    setNext_(sheet, r, (elsewhere.kind === 'bounce' ? 'Bounced' : 'Reply received ' + d_(elsewhere.date)) +
      ': follow ups stopped', null);
    return null;
  }
  const fresh = readRow_(sheet, r);
  const due = scheduleNextFollowUp_(sheet, r, fresh, s, a.last.date, a.followUpsSent);
  return due ? { analysis: a, due: due, row: r } : null;
}

/** Sets Next step and Next action at for the coming follow up. Returns the due time or null. */
function scheduleNextFollowUp_(sheet, r, row, s, lastOutbound, sentCount) {
  if (!row.fuOn) { setNext_(sheet, r, 'Follow ups off (tick Follow ups on to start them)', null); return null; }
  if (!isWaiting_(row.status)) { setNext_(sheet, r, 'Follow ups paused: Status is ' + (row.status || 'blank'), null); return null; }
  if (sentCount >= s.maxFollowUps) { setNext_(sheet, r, 'Follow ups finished (' + sentCount + ' sent)', null); return null; }
  const days = row.fuDays >= 1 ? Math.round(row.fuDays) : s.defaultDays;
  const due = followUpDue_(lastOutbound, days, s.followUpHour, s.skipWeekends);
  setNext_(sheet, r, 'Follow up ' + (sentCount + 1) + ' of ' + s.maxFollowUps + ' due ' + dt_(due), due);
  return due;
}

/** Must run inside the script lock. */
function processFollowUp_(sheet, r, s, now) {
  const res = refreshRow_(sheet, r, s);
  if (!res || res.due > now || !inFollowUpWindow_(now, s)) return false;
  const row = readRow_(sheet, res.row);
  // Same row as the analysed thread? If rows moved in between, skip; the next run picks it up.
  if (row.threadId !== res.analysis.threadId) return false;
  if (!row.fuOn || !isWaiting_(row.status)) return false;
  return sendFollowUp_(sheet, res.row, row, res.analysis, s, now);
}

function sendFollowUp_(sheet, r, row, a, s, now) {
  const sender = resolveSender_(row.sender);
  const n = a.followUpsSent + 1;
  if (sender.error) {
    setNext_(sheet, r, 'Follow up not sent: ' + sender.error, null);
    logEvent_(sheet, r, 'Follow up not sent ' + d_(now) + ': ' + sender.error);
    return false;
  }
  if (!a.inReplyTo) {
    setNext_(sheet, r, 'Follow up not sent: the earlier email has no Message ID', null);
    logEvent_(sheet, r, 'Follow up not sent ' + d_(now) + ': the earlier email has no Message ID');
    return false;
  }
  const note = row.fuNote;
  const body = buildFollowUp_(row, sender, s, note);
  const subject = /^re:/i.test(a.subject) ? a.subject : 'Re: ' + a.subject;
  const raw = buildMime_({
    fromName: sender.name, fromEmail: sender.email, to: a.sendTo, subject: subject, replyTo: s.replyTo,
    inReplyTo: a.inReplyTo, references: a.references, text: body.text, html: body.html
  });
  const sent = Gmail.Users.Messages.send({ raw: Utilities.base64EncodeWebSafe(raw), threadId: a.threadId }, 'me');
  setVal_(sheet, r, COL.FU_COUNT, n);
  if (note) setVal_(sheet, r, COL.FU_NOTE, '');
  logEvent_(sheet, r, 'Followed up ' + d_(now) + ' (follow up ' + n + ', ' + sender.name + ' to ' + a.sendTo.join(', ') +
    (note ? ', note: ' + note.replace(/\s+/g, ' ').slice(0, 80) : '') + ')');
  if (sent && sent.threadId && sent.threadId !== a.threadId) {
    logEvent_(sheet, r, 'Warning ' + d_(now) + ': Gmail put follow up ' + n + ' in a new thread');
  }
  scheduleNextFollowUp_(sheet, r, readRow_(sheet, r), s, now, n);
  SpreadsheetApp.flush();
  return true;
}

/** Links a 26/27 thread found in Gmail (sent by hand or from the Gmail draft) to the row. */
function adoptThread_(sheet, r, found, s) {
  const row = readRow_(sheet, r);
  const pick = found[found.length - 1];
  const other = rowWithThread_(sheet, pick.threadId);
  if (other && other !== r) {
    logEvent_(sheet, r, 'Already emailed ' + pick.to.join(', ') + ' on ' + d_(pick.date) + ' (tracked in row ' + other + ')', { once: true });
    setNext_(sheet, r, 'Duplicate of row ' + other + ': nothing will be sent from this row', null);
    if (row.draftId) setText_(sheet, r, COL.DRAFT_ID, '');
    return false;
  }
  setText_(sheet, r, COL.THREAD_ID, pick.threadId);
  if (!row.dateEmailed) setVal_(sheet, r, COL.DATE_EMAILED, 'Sent ' + d_(found[0].date));
  if (notSentYet_(row.status)) setVal_(sheet, r, COL.STATUS, statusLabel_(STATUS_WAITING) || STATUS_WAITING);
  logEvent_(sheet, r, 'Sent ' + d_(found[0].date) + ' (found in Gmail and linked)', { once: true });
  if (found.length > 1) {
    logEvent_(sheet, r, 'Warning: ' + found.length + ' separate ' + s.seasonTag + ' emails to this address; following up in the latest', { once: true });
  }
  if (row.draftId) {
    if (getDraft_(row.draftId)) logEvent_(sheet, r, 'A draft for this row is still in Gmail Drafts: delete it so it is not sent by mistake', { once: true });
    setText_(sheet, r, COL.DRAFT_ID, '');
  }
  setNext_(sheet, r, '', null);
  const meta = getThreadMeta_(pick.threadId);
  if (meta) {
    const fresh = readRow_(sheet, r);
    applyAnalysis_(sheet, r, fresh, analyzeThread_(meta, fresh.emails, ourAddresses_(), s), s, new Date());
  }
  return true;
}

/** Replies or bounce backs that arrived outside the thread. */
function activityElsewhere_(a, s) {
  const ours = ourAddresses_();
  const after = fmt_(new Date(a.first.date.getTime() - 86400000), 'yyyy/MM/dd');
  const ok = function (m) { return m.threadId !== a.threadId && m.date > a.first.date; };
  const people = a.recipients.slice(0, 10);
  if (people.length) {
    const hits = searchMessages_('{' + people.map(function (e) { return 'from:' + e; }).join(' ') + '} after:' + after +
      ' -in:sent -in:drafts -in:trash', 10).filter(function (m) { return ok(m) && !isBounce_(m) && !isAutoReply_(m); });
    if (hits.length) return { kind: 'reply', date: hits[0].date, from: extractEmails_(hits[0].from)[0] || hits[0].from };
  }
  const domain = firmDomain_(a.recipients);
  if (domain) {
    const hits = searchMessages_('from:' + domain + ' after:' + after + ' {"' + s.orgName.replace(/"/g, '') + '" partnership sponsorship sponsor}' +
      ' -in:sent -in:drafts -in:trash', 10).filter(function (m) {
      const f = extractEmails_(m.from)[0] || '';
      return ok(m) && !ours.has(f) && !isBounce_(m) && !isAutoReply_(m);
    });
    if (hits.length) return { kind: 'reply', date: hits[0].date, from: extractEmails_(hits[0].from)[0] || hits[0].from };
  }
  // Bounce backs outside the thread, checked address by address so one bad address among several
  // does not stop follow ups to the others.
  const live = a.sendTo.slice(0, 5);
  const failed = [];
  let lastDate = null;
  live.forEach(function (e) {
    const hits = searchMessages_('{from:mailer-daemon from:postmaster} "' + e + '" after:' + after, 5).filter(ok);
    if (hits.length) { failed.push(e); lastDate = hits[0].date; }
  });
  if (failed.length && failed.length >= live.length) return { kind: 'bounce', date: lastDate };
  if (failed.length) return { kind: 'partialBounce', date: lastDate, addresses: failed };
  return null;
}

// ===== 11. Gmail helpers ====================================================================

/** Season (26/27) threads where we emailed any of these addresses, oldest first. */
function findSeasonThreads_(emails, s) {
  emails = unique_(emails).slice(0, 10);
  if (!emails.length) return [];
  const terms = [];
  emails.forEach(function (e) { terms.push('to:' + e, 'cc:' + e, 'bcc:' + e); });
  return seasonThreadsMatching_('in:sent newer_than:2y {' + terms.join(' ') + '}', s, function (addr) {
    return emails.indexOf(addr) !== -1;
  });
}

/** Season threads to other people at the same firm domain. */
function domainSeasonThreads_(emails, s) {
  const domain = firmDomain_(emails);
  if (!domain) return [];
  return seasonThreadsMatching_('in:sent newer_than:2y {to:' + domain + ' cc:' + domain + '}', s, function (addr) {
    return domainOf_(addr) === domain && emails.indexOf(addr) === -1;
  });
}

function seasonThreadsMatching_(query, s, wanted) {
  const ours = ourAddresses_();
  const list = gmail_(function () { return Gmail.Users.Threads.list('me', { q: query, maxResults: 20 }); });
  const out = [];
  ((list && list.threads) || []).forEach(function (t) {
    const meta = getThreadMeta_(t.id);
    if (!meta) return;
    const msgs = (meta.messages || []).map(parseMessage_).sort(function (a, b) { return a.date - b.date; });
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (m.labels.indexOf('DRAFT') !== -1 || m.labels.indexOf('TRASH') !== -1) continue;
      if (!isOurs_(m, ours) || !s.seasonRe.test(m.subject)) continue;
      const hit = extractEmails_([m.to, m.cc, m.bcc].join(',')).filter(wanted);
      if (hit.length) { out.push({ threadId: t.id, date: m.date, to: hit, subject: m.subject }); break; }
    }
  });
  out.sort(function (a, b) { return a.date - b.date; });
  return out;
}

function getThreadMeta_(threadId) {
  if (!threadId) return null;
  try {
    return gmail_(function () { return Gmail.Users.Threads.get('me', threadId, { format: 'metadata', metadataHeaders: META_HEADERS }); });
  } catch (err) {
    if (/not found|404|invalid/i.test(msg_(err))) return null;
    throw err;
  }
}

function searchMessages_(query, max) {
  const list = gmail_(function () { return Gmail.Users.Messages.list('me', { q: query, maxResults: max || 10 }); });
  return ((list && list.messages) || []).map(function (m) {
    const full = gmail_(function () {
      return Gmail.Users.Messages.get('me', m.id, { format: 'metadata', metadataHeaders: META_HEADERS });
    });
    return parseMessage_(full);
  });
}

/** Retries Gmail API calls that hit a rate limit. */
function gmail_(fn) {
  for (let attempt = 1; ; attempt++) {
    try { return fn(); } catch (err) {
      if (attempt < 4 && /rate limit|quota|backend error|try again|500|503/i.test(msg_(err))) {
        Utilities.sleep(1500 * attempt);
        continue;
      }
      throw err;
    }
  }
}

function parseMessage_(m) {
  const h = {};
  ((m.payload && m.payload.headers) || []).forEach(function (x) { h[String(x.name).toLowerCase()] = String(x.value || ''); });
  return {
    id: m.id, threadId: m.threadId, labels: m.labelIds || [], date: new Date(Number(m.internalDate || 0)),
    from: h['from'] || '', to: h['to'] || '', cc: h['cc'] || '', bcc: h['bcc'] || '',
    subject: h['subject'] || '', messageId: h['message-id'] || '', references: h['references'] || '',
    autoSubmitted: h['auto-submitted'] || '', autoReply: h['x-autoreply'] || h['x-autorespond'] || '',
    precedence: h['precedence'] || '', contentType: h['content-type'] || '', failed: h['x-failed-recipients'] || '',
    snippet: String(m.snippet || '')
  };
}

/** Which of these addresses a bounce back names (its X-Failed-Recipients header or its opening text). */
function bouncedAddresses_(m, addresses) {
  const named = extractEmails_([m.failed, m.snippet, m.subject].join(' '));
  return addresses.filter(function (e) { return named.indexOf(e) !== -1; });
}

function isOurs_(m, ours) {
  if (m.labels.indexOf('SENT') !== -1) return true;
  const from = extractEmails_(m.from)[0] || '';
  return !!from && ours.has(from);
}

function isBounce_(m) {
  return /mailer-daemon|postmaster|mail delivery (subsystem|system)/i.test(m.from) ||
    /report-type="?delivery-status/i.test(m.contentType) || !!m.failed ||
    /^(undeliverable|undelivered|delivery status notification|mail delivery failed|returned mail|failure notice|delivery failure|message not delivered)/i
      .test(m.subject.trim());
}

function isAutoReply_(m) {
  const as = m.autoSubmitted.trim().toLowerCase();
  if (as && as !== 'no') return true;
  if (m.autoReply) return true;
  if (/auto_?reply|bulk|junk/i.test(m.precedence)) return true;
  const subject = m.subject.replace(/^((re|aw|fw|fwd)\s*:\s*)+/i, '').trim();
  return /^(automatic reply|auto[\s-]?reply|autoreply|out of (the )?office|ooo\b|away from|abwesenheit|r[ée]ponse automatique)/i.test(subject);
}

function buildMime_(o) {
  const boundary = 'wq_' + Utilities.getUuid().replace(/-/g, '');
  const lines = [
    'From: ' + displayName_(o.fromName) + ' <' + o.fromEmail + '>',
    'To: ' + o.to.join(', '),
    'Subject: ' + encodeHeader_(o.subject)
  ];
  if (o.replyTo) lines.push('Reply-To: ' + o.replyTo);
  if (o.inReplyTo) lines.push('In-Reply-To: ' + o.inReplyTo);
  if (o.references) lines.push('References: ' + o.references);
  lines.push('MIME-Version: 1.0', 'Content-Type: multipart/alternative; boundary="' + boundary + '"', '',
    '--' + boundary, 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '',
    wrap76_(b64_(o.text)),
    '--' + boundary, 'Content-Type: text/html; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '',
    wrap76_(b64_(o.html)),
    '--' + boundary + '--', '');
  return lines.join('\r\n');
}

function b64_(s) { return Utilities.base64Encode(String(s), Utilities.Charset.UTF_8); }
function wrap76_(s) { return s.replace(/(.{76})(?=.)/g, '$1\r\n'); }
function encodeHeader_(s) { return /^[\x20-\x7e]*$/.test(s) ? s : '=?UTF-8?B?' + b64_(s) + '?='; }
function displayName_(name) {
  return /^[\x20-\x7e]*$/.test(name) ? '"' + String(name).replace(/(["\\])/g, '\\$1') + '"' : encodeHeader_(name);
}

// ===== 12. Dates (always UK time) ===========================================================

function fmt_(date, pattern) { return Utilities.formatDate(date, APP.TZ, pattern); }
function d_(date) { return fmt_(date, 'dd/MM/yy'); }
function dt_(date) { return fmt_(date, 'EEE dd/MM/yy HH:mm'); }

function londonParts_(date) {
  const p = fmt_(date, 'yyyy-MM-dd-u-HH-mm').split('-').map(Number);
  return { y: p[0], m: p[1], d: p[2], dow: p[3], hh: p[4], mm: p[5] };
}

function londonOffsetMinutes_(date) {
  const z = fmt_(date, 'Z');
  const sign = z.charAt(0) === '-' ? -1 : 1;
  return sign * (parseInt(z.substr(1, 2), 10) * 60 + parseInt(z.substr(3, 2), 10));
}

/** The instant that is hh:mm UK time on the given calendar day. */
function londonTime_(y, m, d, hh, mm) {
  const wall = Date.UTC(y, m - 1, d, hh, mm || 0);
  let t = wall;
  for (let i = 0; i < 2; i++) t = wall - londonOffsetMinutes_(new Date(t)) * 60000;
  return new Date(t);
}

function addDays_(y, m, d, n) {
  const t = new Date(Date.UTC(y, m - 1, d + n, 12));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), dow: ((t.getUTCDay() + 6) % 7) + 1 };
}

function nextDayAt_(now, hour) {
  const p = londonParts_(now);
  const t = addDays_(p.y, p.m, p.d, 1);
  return londonTime_(t.y, t.m, t.d, hour, 0);
}

function nextMondayAt_(now, hour) {
  const p = londonParts_(now);
  if (p.dow === 1 && p.hh < hour) return londonTime_(p.y, p.m, p.d, hour, 0);
  const t = addDays_(p.y, p.m, p.d, p.dow === 1 ? 7 : 8 - p.dow);
  return londonTime_(t.y, t.m, t.d, hour, 0);
}

function followUpDue_(lastOutbound, days, hour, skipWeekends) {
  const p = londonParts_(lastOutbound);
  let t = addDays_(p.y, p.m, p.d, days);
  if (skipWeekends && t.dow === 6) t = addDays_(t.y, t.m, t.d, 2);
  if (skipWeekends && t.dow === 7) t = addDays_(t.y, t.m, t.d, 1);
  return londonTime_(t.y, t.m, t.d, hour, 0);
}

function inFollowUpWindow_(now, s) {
  const p = londonParts_(now);
  return p.hh === s.followUpHour && (!s.skipWeekends || p.dow <= 5);
}

function parseDate_(v) {
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  const str = String(v || '').trim();
  if (!str) return null;
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
}

// ===== 13. Small helpers ====================================================================

/** Every email address in a cell, lower case, without duplicates (links and notes are ignored). */
function extractEmails_(value) {
  const found = String(value == null ? '' : value).match(/[a-z0-9._%+'-]+@(?:[a-z0-9-]+\.)+[a-z]{2,}/gi) || [];
  return unique_(found.map(function (e) { return e.toLowerCase().replace(/^[.'-]+|[.'-]+$/g, ''); })
    .filter(function (e) { return !/\.(png|jpe?g|gif|svg|webp)$/.test(e) && /^[^@]+@[^@]+\.[a-z]{2,}$/.test(e); }));
}

/** Regex for the season tag: 26/27 also matches 2026/27, 2026-27, 2026/2027 and 26 / 27. */
function seasonRegex_(tag) {
  const m = String(tag || '').match(/(\d{2,4})\s*[\/\-\u2013]\s*(\d{2,4})/);
  if (!m) return new RegExp(String(tag || '26/27').replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&'), 'i');
  const a = m[1].slice(-2), b = m[2].slice(-2);
  return new RegExp('(?:^|\\D)(?:20)?' + a + '\\s*[\\/\\-\\u2013]\\s*(?:20)?' + b + '(?!\\d)', 'i');
}

function fill_(template, values) {
  const out = String(template).replace(/\{\{([A-Z_]+)\}\}/g, function (all, key) {
    return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : all;
  });
  const left = out.match(/\{\{[A-Z_]+\}\}/);
  if (left) throw new Error('template placeholder ' + left[0] + ' was not filled in');
  return out;
}

function htmlToText_(html) {
  return String(html)
    .replace(/<(style|script|head|title)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h\d)>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'').replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractJson_(text) {
  const t = String(text || '');
  const open = t.lastIndexOf('<json>');
  let body = open !== -1 ? t.slice(open + 6) : t;
  const close = body.indexOf('</json>');
  if (close !== -1) body = body.slice(0, close);
  const a = body.indexOf('{'), b = body.lastIndexOf('}');
  if (a === -1 || b <= a) throw new Error('the AI model did not return the expected JSON, try again');
  const raw = body.slice(a, b + 1);
  try { return JSON.parse(raw); } catch (err) {
    return JSON.parse(raw.replace(/,\s*([}\]])/g, '$1'));
  }
}

function possessive_(name) { return /s$/i.test(name) ? name + '\u2019' : name + '\u2019s'; }
function curly_(s) { return String(s || '').replace(/(\w)'(\w)/g, '$1\u2019$2').replace(/(\w)'(\s|$)/g, '$1\u2019$2'); }

function firstName_(name) {
  const parts = String(name || '').replace(/[,;(].*$/, '').trim().split(/\s+/).filter(function (p) {
    return !/^(mr|mrs|ms|miss|mx|dr|prof|professor|sir)\.?$/i.test(p);
  });
  const f = parts[0] || '';
  return /^[A-Za-z\u00C0-\u024F'\u2019-]{2,}$/.test(f) ? f : '';
}

function esc_(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function escAttr_(s) { return esc_(s).replace(/'/g, '&#39;'); }

function domainOf_(email) { const i = String(email || '').lastIndexOf('@'); return i === -1 ? '' : email.slice(i + 1).toLowerCase(); }
function firmDomain_(emails) {
  return (emails || []).map(domainOf_).filter(function (d) { return d && FREE_MAIL.indexOf(d) === -1; })[0] || '';
}

function text_(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return fmt_(v, 'dd/MM/yy');
  return String(v).trim();
}
function clean_(v) { const s = text_(v); return /^(null|none|n\/a|unknown)$/i.test(s) ? '' : s; }
function num_(v) { const n = typeof v === 'number' ? v : parseFloat(String(v || '')); return isNaN(n) ? 0 : n; }
function truthy_(v) { return v === true || /^(true|yes|y|on)$/i.test(String(v == null ? '' : v).trim()); }
function yes_(v) { return v === true || /^(yes|y|true|on|1)$/i.test(String(v == null ? '' : v).trim()); }
function clampInt_(v, lo, hi, def) { const n = parseInt(v, 10); return isNaN(n) ? def : Math.min(hi, Math.max(lo, n)); }
function unique_(arr) { return arr.filter(function (x, i) { return arr.indexOf(x) === i; }); }
function sameSet_(a, b) {
  const x = unique_(a).sort(), y = unique_(b).sort();
  return x.length === y.length && x.every(function (v, i) { return v === y[i]; });
}
function normChoice_(v) { return String(v == null ? '' : v).trim().toLowerCase(); }
function normStatus_(v) {
  return String(v == null ? '' : v).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
}
function isWaiting_(status) { return normStatus_(status) === 'sent and waiting'; }
/** Blank, or a status that means nothing has been sent yet (Not Contacted, Drafting and similar). */
function notSentYet_(status) {
  const s = normStatus_(status);
  return !s || /^(not contacted|to contact|not sent|to do|todo|new|drafting|draft|drafted|draft ready|ready to send|to send|researching|queued)$/.test(s);
}
function msg_(err) { return err && err.message ? err.message : String(err); }
function colLetter_(c) { let s = ''; while (c > 0) { const m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); } return s; }
