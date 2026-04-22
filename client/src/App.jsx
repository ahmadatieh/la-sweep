import { useState } from 'react';

const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

function formatLocalLA(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function ScheduleCard({ row }) {
  const {
    routeNo,
    dayIndex,
    startTime,
    endTime,
    boundaries,
    councilDistrict,
    nextSweep,
    gcalUrl,
  } = row;

  return (
    <div className="card">
      <div className="card-head">
        <div className="day">
          {dayIndex != null ? DAY_NAMES[dayIndex] : 'Unknown day'}
        </div>
        <div className="time">
          {startTime} – {endTime}
        </div>
      </div>
      <div className="meta">
        <div>
          <span className="label">Route</span> {routeNo || '—'}
        </div>
        {councilDistrict && (
          <div>
            <span className="label">Council District</span> {councilDistrict}
          </div>
        )}
      </div>
      {boundaries && <div className="bounds">{boundaries}</div>}

      {nextSweep && (
        <div className="next">
          <div className="label">Next sweep</div>
          <div className="next-time">
            {formatLocalLA(nextSweep.start)} → {formatLocalLA(nextSweep.end)}
          </div>
        </div>
      )}

      {gcalUrl && (
        <a className="gcal" href={gcalUrl} target="_blank" rel="noreferrer">
          Add to Google Calendar
        </a>
      )}
    </div>
  );
}

export default function App() {
  const [address, setAddress] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  async function onSubmit(e) {
    e.preventDefault();
    if (!address.trim()) return;
    setLoading(true);
    setError('');
    setResult(null);
    try {
      const res = await fetch('/api/lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: address.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      setResult(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="page">
      <header>
        <h1>LA Street Sweeping Lookup</h1>
        <p className="subtitle">
          Enter a Los Angeles address. We'll find the posted sweeping schedule
          and let you drop the next occurrence onto your Google Calendar.
        </p>
      </header>

      <form onSubmit={onSubmit}>
        <input
          type="text"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="e.g. 1234 Sunset Blvd, Los Angeles, CA"
          autoFocus
        />
        <button type="submit" disabled={loading || !address.trim()}>
          {loading ? 'Looking up…' : 'Look up'}
        </button>
      </form>

      {error && <div className="error">{error}</div>}

      {result && (
        <section className="result">
          <div className="matched">
            <span className="label">Matched address</span>{' '}
            {result.matchedAddress}
          </div>

          {result.schedules.length === 0 ? (
            <div className="empty">
              No posted sweeping route found within ~200m of that address. This
              means parking is likely fine here, or the street isn't on a
              posted route. Double-check the signs on your block.
            </div>
          ) : (
            <>
              <h2>Found {result.schedules.length} schedule{result.schedules.length === 1 ? '' : 's'} nearby</h2>
              <div className="cards">
                {result.schedules.map((row, i) => (
                  <ScheduleCard key={i} row={row} />
                ))}
              </div>
            </>
          )}
        </section>
      )}

      <footer>
        Data: <a href="https://data.lacity.org/City-Infrastructure-Service-Requests/Posted-Street-Sweeping-Routes/krk7-ayq2" target="_blank" rel="noreferrer">LA Open Data · Posted Street Sweeping Routes</a>. Geocoding: US Census Bureau.
      </footer>
    </div>
  );
}
