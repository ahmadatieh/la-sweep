# LA Street Sweeping Lookup

A tiny web app: type an LA address, see the posted street-sweeping schedule
for that block, and add the next sweep to your Google Calendar in one click.

- **Data**: LA's [Posted Street Sweeping Routes ArcGIS layer](https://www.arcgis.com/home/item.html?id=0e16fa641a0846a3ae29bffb150314dc) (`Posted_Street_Sweeping_Routes_Update/FeatureServer/0`), queried with a true point-in-polygon intersect so we return only the route(s) the address actually sits inside.
- **Geocoding**: US Census Bureau's free geocoder (no API key needed).
- **Calendar**: A prefilled `calendar.google.com` link — user clicks, reviews, saves. No OAuth.

## Layout

```
la-sweep/
├── server/          Express API (Node 18+)
│   ├── index.js        HTTP routes + CORS
│   ├── sweeping.js     geocode + ArcGIS point-in-polygon query
│   └── schedule.js     next-occurrence + gcal URL builder
├── client/          Vite + React frontend (standalone web app)
│   └── src/
│       ├── App.jsx
│       └── styles.css
└── framer/          Framer code component
    └── LAStreetSweepLookup.tsx
```

## Run it locally

Requires **Node 18+** (needs the built-in `fetch`).

```bash
cd la-sweep
npm install                    # installs `concurrently` at the root
npm run install:all            # installs server + client deps
npm run dev                    # runs both on :3001 (API) and :5173 (UI)
```

Open <http://localhost:5173>. The Vite dev server proxies `/api/*` to the
Express server.

## API

### `POST /api/lookup`

Body: `{ "address": "1234 Sunset Blvd, Los Angeles, CA" }`

Response (trimmed):

```json
{
  "matchedAddress": "1234 SUNSET BLVD, LOS ANGELES, CA, 90026",
  "coordinates": { "lat": 34.07, "lng": -118.25 },
  "schedules": [
    {
      "routeNo": "01P203",
      "dayIndex": 3,
      "dayAbbr": "W",
      "startTime": "8:00 AM",
      "endTime": "10:00 AM",
      "boundaries": "Sunset Blvd / Echo Park Ave …",
      "councilDistrict": "1",
      "nextSweep": {
        "start": "2026-04-22T15:00:00.000Z",
        "end":   "2026-04-22T17:00:00.000Z"
      },
      "gcalUrl": "https://calendar.google.com/calendar/render?..."
    }
  ]
}
```

Each schedule has its own `gcalUrl`. The UI shows one "Add to Google Calendar"
button per schedule.

## Caveats / things to improve

- **Match is a true point-in-polygon.** We hand the geocoded lat/lng to the
  ArcGIS layer with `spatialRel=esriSpatialRelIntersects`, so we only return
  the route(s) the address actually falls inside. If the geocoder puts the
  point slightly off the right side of the street you may miss a route — try
  a more precise address (with unit, or move across the street).
- Only the **next occurrence** is added to the calendar (per your
  preference). If you want a weekly recurring event, add
  `&recur=RRULE:FREQ=WEEKLY;BYDAY=WE` to the URL in `buildGcalUrl`.
- The LA dataset is mostly **weekly** schedules, but some routes carry a
  `Weeks` or `Odd_Even` flag for biweekly cadence (1st/3rd, 2nd/4th). The
  backend surfaces both fields on each schedule; if your street shows
  "Biweekly" on the posted sign, confirm the week before relying on the
  reminder.
- The Census Geocoder is US-only and has a query rate limit. For production
  use, swap in Google/Mapbox geocoding.
- No caching. For anything more than personal use, cache the ArcGIS layer
  nightly rather than hitting the FeatureServer on every request.

## Deploy the backend

You only need to deploy the `server/` folder. No secrets required.

Pick one:

**Render (easiest, free tier)**

1. Push `la-sweep/` to a GitHub repo.
2. On [render.com](https://render.com) → New → Web Service → pick your repo.
3. Root directory: `server`. Build command: `npm install`. Start command: `npm start`. Node version: 20.
4. Add env var `ALLOWED_ORIGINS` set to your Framer domains, comma-separated. E.g. `https://yoursite.framer.website,https://yoursite.com`.
5. Deploy. You'll get a URL like `https://la-sweep.onrender.com`.

**Railway / Fly / Vercel functions** all work the same way — point them at `server/`, set `ALLOWED_ORIGINS`, deploy.

Verify with:

```bash
curl -X POST https://your-api.onrender.com/api/lookup \
  -H 'Content-Type: application/json' \
  -d '{"address":"1234 Sunset Blvd, Los Angeles, CA"}'
```

### CORS

The server allows all origins when `ALLOWED_ORIGINS` is unset (good for local
dev). Set it in production so the API can only be called from your Framer
site. Don't forget both the preview URL (`*.framer.website`) and your custom
domain if you have one.

## Wire it into your Framer site

The `framer/` directory has a ready-to-drop code component. Framer will handle
TypeScript + JSX compilation automatically.

1. In your Framer project, open the left sidebar and go to **Assets → + → Code File**.
2. Name it `LAStreetSweepLookup`. Paste in the contents of [`framer/LAStreetSweepLookup.tsx`](./framer/LAStreetSweepLookup.tsx).
3. Save. The component now shows up in the insert menu.
4. Drop it onto any page. In the right-hand property panel:
   - Set **API URL** to your deployed backend (e.g. `https://la-sweep.onrender.com`) — **no trailing slash required, no `/api/lookup` suffix** (the component appends it).
   - Tweak colors, radius, font, labels, and max width to match your site.
5. Publish. Done.

The component stores its state internally (address, result, loading). Each
"Add to Google Calendar" button opens a prefilled Google Calendar page in a
new tab.

### Troubleshooting Framer

- **CORS error in the browser console**: Add your Framer preview/published
  origin to the backend's `ALLOWED_ORIGINS` env var and redeploy.
- **"Could not geocode"**: US Census Geocoder sometimes can't match partial
  addresses. Include city + state.
- **No schedules found**: Either the street isn't on a posted route (parking
  is likely fine) or the address resolved to a point >200m from any known
  route segment. The backend tries radii up to 200m.
