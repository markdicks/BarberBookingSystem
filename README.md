# Braam Street Barbers booking

A small Node.js web app for 30-minute barber appointments. Customers choose a service and free slot, verify their phone on WhatsApp, and get a 30-day sign-in session. The same live availability powers the WhatsApp chat booking webhook. Duplicate bookings are blocked by a database unique index.

## Run locally

Requires Node.js 22 or later.

```bash
npm install
cp .env.example .env
npm start
```

Open `http://localhost:3000`. On a local development run, the app stores bookings in `data/bookings.sqlite` and prints verification codes in the terminal. Both are excluded from Git. `npm test` runs the booking flow test.

## Deploy on Hostinger Web App

1. In Hostinger, create a **Node.js Web App** from this GitHub repository. Use Node.js 22 or 24, npm, and `npm start`. The entry file is `app.js` and there is no build step.
2. Connect a **persistent PostgreSQL database**, for example through Hostinger's Supabase Database Connect Wizard. Set `DATABASE_URL` to the PostgreSQL connection string. The app creates its tables when it starts. Keep the database separate from the deployment folder; Hostinger replaces that folder on each deployment.
3. Create a Twilio account, a Verify Service, and a WhatsApp sender approved for your business. Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_VERIFY_SERVICE_SID` in Hostinger environment variables. Twilio Verify's WhatsApp channel needs a configured business sender.
4. Set `NODE_ENV=production`, `PUBLIC_BASE_URL=https://your-domain.example` (no trailing slash), and `BUSINESS_WHATSAPP_NUMBER=+27...` for the WhatsApp button. The number must be the Twilio WhatsApp sender customers can message. Set `DATABASE_SSL=true` for a TLS PostgreSQL connection, or `false` only if your trusted database connection specifically requires it.
5. In the Twilio WhatsApp sender's **incoming message webhook**, set an HTTP POST URL of `https://your-domain.example/api/whatsapp/webhook`. The app checks Twilio's signature in production. Users can send **BOOK**, **MY BOOKINGS**, or **CANCEL**.
6. Connect the domain and enable HTTPS. Test a booking on the live domain and an inbound WhatsApp message before sharing the link with customers.

The app fails to start in production if the database, site URL, or Twilio verification settings are missing. Store credentials only in Hostinger environment variables, never in Git.

## Business settings

The supplied screenshots set the default address and hours:

| Day | Hours |
| --- | --- |
| Monday–Thursday | 08:00–20:00 |
| Friday | 08:00–17:30 |
| Saturday | 08:00–14:30 |
| Sunday | Closed |

Times are in `Africa/Johannesburg`. A slot starts every 30 minutes, must end before closing, and can be booked up to 30 days ahead with at least one hour's notice. To change hours without editing code, set `SCHEDULE_JSON` as shown in `.env.example`. Weekdays are numbered 1 (Monday) to 7 (Sunday). Omit a closed day.

Prices in `src/config.js` are full cut R150, only fade R130, mullet taper R100, full beard work R20, and line ups R10. Online bookings reserve one 30-minute slot for any service. Bookings from 18:00 to 18:59 add R10; 19:00 to 19:59 add R20. The screenshot lists R30 after 20:00, but regular online hours end at 20:00, so the site directs customers to WhatsApp for later appointments by arrangement. A R30 late fee applies after 7 minutes. Cancellations within 3 hours are marked with an R80 fee, as are no-shows according to the displayed policy. **No payment collection or automated fee charging is included.**

The WhatsApp number wasn't present in the screenshots and must be supplied through `BUSINESS_WHATSAPP_NUMBER`. The supplied logo is in `public/assets/braam-street-logo.png`.
