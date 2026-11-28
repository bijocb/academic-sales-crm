# Connecting lead sources — setup guide

Every source sends enquiries into the same intake pipeline. Each enquiry is validated and cleaned (phone in +91 / +971
format) and checked for duplicates. It is then credited to its source and campaign, allocated to an executive, and
given a first-call task and the first-response SLA. Bad data lands in **Leads → Rejected leads** for a person to fix.

All setup happens in **Sources & campaigns** (choose the brand first). It needs the `integration.manage` permission
(organization admins).

| Source                        | How leads arrive                                     | Speed                                                |
| ----------------------------- | ---------------------------------------------------- | ---------------------------------------------------- |
| Website / landing page        | The form posts to the intake API                     | Instant                                              |
| Google Ads lead forms         | Google calls the CRM webhook                         | Instant                                              |
| Facebook / Instagram Lead Ads | Meta calls the CRM webhook; the CRM fetches the lead | Within seconds (next scheduler run at most)          |
| Google Sheets / Google Forms  | A script in the sheet sends new rows                 | Every 5 minutes, or at once for a linked Google Form |
| Walk-in, phone, spreadsheets  | "New lead" or Import leads                           | —                                                    |

## 1. Website / landing page

1. Intake keys → name it (e.g. "Main website form"), source **Website** → Create key. Copy the key; it is shown once.
2. Give your web developer the key and this call (also shown on screen):
   `POST https://<your CRM>/api/v1/intake/leads` with header `Authorization: Bearer <key>` and a JSON body:
   `name`, `phone`, `email`, `course`, `city`, `message`, `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`,
   `utm_content`, `landingPage`, `referrer`.
3. Keep the key on the web server (not in browser JavaScript), or post through your own form handler.

## 2. Google Ads lead forms

1. Intake keys → source **Google Ads** → Create key. The screen shows the webhook URL
   (`…/api/v1/webhooks/google-ads/<keyId>`).
2. Google Ads → the lead form asset → **Webhook integration**: paste the URL and the key → **Send test data**. The test
   lead appears marked as a test.
3. To credit campaigns, create the campaign in the CRM with its **External id** = the Google Ads campaign id.

## 3. Facebook / Instagram Lead Ads (direct)

One-time platform setup by whoever runs the CRM:

1. In Meta for Developers, create (or use) the organization's **Business app**. Add the **Webhooks** product, object
   **Page**, field **leadgen**. Callback URL: `https://<your CRM>/api/v1/webhooks/meta`; verify token: any long random
   text.
2. On the API's hosting (Vercel), set `META_APP_SECRET` (App settings → Basic → App secret), `META_VERIFY_TOKEN` (the
   same text as above) and `SECRETS_KEY` (32 random bytes, e.g. `openssl rand -hex 32`; it encrypts page tokens). Then
   redeploy.
3. Request **Advanced Access** for `leads_retrieval`, `pages_manage_metadata` and `pages_show_list` (Meta App Review),
   and set the app to **Live**.

For each Facebook page:

4. Get a **page access token** for the page with those permissions. Use a long-lived token, e.g. from a system user in
   Meta Business Settings with the page assigned.
5. Sources & campaigns → **Facebook & Instagram Lead Ads** → page name, Page ID, source **Meta Ads**, token →
   **Connect page**. The CRM checks the token with Meta and subscribes the page. If Meta refuses, the reason is shown.
6. In Meta's **Lead Ads Testing Tool**, create a test lead; it appears in the CRM within moments.
7. To credit campaigns, create the campaign in the CRM with **External id** = the Meta campaign id.

The table shows each page's last lead and last problem. **Replace token** when a token expires, and **Pause** to stop a
page. Facebook and Instagram leads are told apart (`utm_source` facebook / instagram). Custom form questions are
saved in the enquiry message.

## 4. Google Sheets (and Google Forms)

1. Intake keys → source **Google Sheets** → Create key. The screen shows a ready **Apps Script** with your CRM address
   and key filled in (copy it now; the key is shown once).
2. Open the sheet → **Extensions → Apps Script** → replace the code with the script → **Save** → choose **setup** →
   **Run** → allow access.
3. Row 1 must hold headers. Recognised: Name / Full name, Phone / Mobile / WhatsApp, Email, Course, City, Language,
   Message / Notes / Comments, utm_source, utm_medium, utm_campaign (or Campaign), utm_term, utm_content.
4. The script adds a **CRM status** column and writes "Sent …" or "Rejected …: reason" for each row. Rows with a status
   are never sent again. To resend a fixed row, clear its status cell. A **CRM → Send new rows now** menu sends
   at once.
5. If the sheet receives Google Form responses, new rows go out the moment the form is submitted.

The script uses the first tab of the spreadsheet. Anyone who can edit the sheet's script can see the key, so share edit
access carefully. If the key leaks, revoke it and create a new one.

## Limits and monitoring

- Each intake key accepts 120 leads per minute (`INTAKE_PER_MINUTE`).
- A lead that cannot be fetched from Meta is retried several times, then shows as a failed job. The scheduler alert
  e-mails when that happens (`docs/RUNBOOK.md`).
- Reports → breakdown by **source** or **campaign** shows leads, contact rate, admissions and (with ad spend entered)
  cost per lead and per admission for every source.
