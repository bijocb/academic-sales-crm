/**
 * Google Apps Script that sends new Google Sheet rows to the CRM intake API (Google Sheets lead source).
 * Generated with the intake key, which is shown only once; anyone who can edit the sheet's script can see it,
 * so revoke the key if the sheet is shared widely.
 */
export function sheetScript(origin: string, key: string): string {
  return `/**
 * Academic Sales CRM — send new rows of this sheet to the CRM as leads.
 * Setup: Extensions → Apps Script → paste this file → Save → run "setup" once and allow access.
 * Columns are matched by their header (row 1): Name, Phone, Email, Course, City, Language, Message / Notes,
 * utm_source, utm_medium, utm_campaign, utm_term, utm_content. A "CRM status" column is added and filled in;
 * rows with a status are never sent again.
 */
const CRM_URL = '${origin}/api/v1/intake/leads';
const CRM_KEY = '${key}';
const STATUS_HEADER = 'CRM status';

const FIELDS = {
  name: ['name', 'full name', 'student name', 'full_name'],
  phone: ['phone', 'mobile', 'phone number', 'whatsapp', 'contact number', 'phone_number'],
  email: ['email', 'email address', 'e-mail'],
  course: ['course', 'course interested', 'program', 'programme'],
  city: ['city', 'location'],
  language: ['language'],
  message: ['message', 'notes', 'comments', 'remarks', 'query'],
  utm_source: ['utm_source'],
  utm_medium: ['utm_medium'],
  utm_campaign: ['utm_campaign', 'campaign'],
  utm_term: ['utm_term'],
  utm_content: ['utm_content'],
};

function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ScriptApp.getProjectTriggers().forEach((t) => ScriptApp.deleteTrigger(t));
  // Every 5 minutes, and immediately when a linked Google Form adds a row.
  ScriptApp.newTrigger('sendNewRows').timeBased().everyMinutes(5).create();
  ScriptApp.newTrigger('sendNewRows').forSpreadsheet(ss).onFormSubmit().create();
  sendNewRows();
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('CRM').addItem('Send new rows now', 'sendNewRows').addToUi();
}

function sendNewRows() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return;
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
    const data = sheet.getDataRange().getValues();
    if (data.length < 2) return;
    const headers = data[0].map((h) => String(h).trim().toLowerCase());
    let status = headers.indexOf(STATUS_HEADER.toLowerCase());
    if (status < 0) {
      status = headers.length;
      sheet.getRange(1, status + 1).setValue(STATUS_HEADER);
    }
    const col = {};
    Object.keys(FIELDS).forEach((f) => {
      const i = headers.findIndex((h) => FIELDS[f].indexOf(h) >= 0);
      if (i >= 0) col[f] = i;
    });
    const sheetId = SpreadsheetApp.getActiveSpreadsheet().getId();
    for (let r = 1; r < data.length; r++) {
      const row = data[r];
      if (row[status]) continue; // already sent or rejected
      if (row.every((v) => v === '' || v === null)) continue;
      const lead = { externalId: sheetId + ':' + sheet.getSheetId() + ':' + (r + 1) };
      Object.keys(col).forEach((f) => {
        const v = String(row[col[f]] ?? '').trim();
        if (v) lead[f] = v.slice(0, f === 'message' ? 2000 : 200);
      });
      if (!lead.phone && !lead.email) continue; // wait until the row has a phone or e-mail
      const res = UrlFetchApp.fetch(CRM_URL, {
        method: 'post',
        contentType: 'application/json',
        headers: { Authorization: 'Bearer ' + CRM_KEY },
        payload: JSON.stringify(lead),
        muteHttpExceptions: true,
      });
      const code = res.getResponseCode();
      const when = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
      let body = {};
      try { body = JSON.parse(res.getContentText()); } catch (e) {}
      if (code === 200 || code === 201) {
        sheet.getRange(r + 1, status + 1).setValue('Sent ' + when + ' (' + (body.outcome || 'ok') + ')');
      } else if (code === 202) {
        const why = (body.errors || []).map((x) => x.message).join('; ');
        sheet.getRange(r + 1, status + 1).setValue('Rejected ' + when + ': ' + why + ' — fix the row, clear this cell to resend');
      } else if (code === 429) {
        return; // rate limit: the next run continues
      } else if (code === 401) {
        sheet.getRange(r + 1, status + 1).setValue('Key not accepted — ask the CRM admin for a new key');
        return;
      } else {
        return; // CRM or network error: retried on the next run
      }
    }
  } finally {
    lock.releaseLock();
  }
}
`;
}
