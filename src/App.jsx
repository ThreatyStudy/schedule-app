import React, { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import { supabase } from "./supabaseClient";
console.log("DEPLOY CHECK: NEW UI ACTIVE");

/**
 * Schedule Hub - Full Dashboard App.jsx
 * - Auth session handling
 * - Room (household) join/create
 * - Events CRUD (simple)
 * - Realtime subscriptions for events + members
 * - Dashboard UI: Clock, Weather, Next Event, Calendar Month Grid, Verse card, Status card
 * - Settings modal: copy code, leave household, location preference (local only)
 *
 * Notes:
 * - Weather uses Open-Meteo (no API key).
 * - Location choice is saved in localStorage.
 */

// ---------- Helpers ----------
const pad2 = (n) => String(n).padStart(2, "0");
const yyyyMmDd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}
function endOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0);
}
function addMonths(date, delta) {
  return new Date(date.getFullYear(), date.getMonth() + delta, 1);
}
function monthLabel(date) {
  return date.toLocaleString(undefined, { month: "long", year: "numeric" });
}
function dayLabel(date) {
  return date.toLocaleString(undefined, { weekday: "short" });
}
function fmtClock(date) {
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" });
}
function fmtDayLong(date) {
  return date.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

const LOCATIONS = [
  { key: "winchester", label: "Winchester, VA", lat: 39.1856597, lon: -78.1633341 },
  { key: "harrisonburg", label: "Harrisonburg, VA", lat: 38.449569, lon: -78.868915 },
  { key: "frederick", label: "Frederick, MD", lat: 39.414268, lon: -77.410540 },
  { key: "dc", label: "Washington, DC", lat: 38.9072, lon: -77.0369 },
];

// Open-Meteo mapping (simple)
function weatherCodeToText(code) {
  // Minimal mapping (good enough for dashboard)
  if (code === 0) return "Clear";
  if ([1, 2, 3].includes(code)) return "Partly cloudy";
  if ([45, 48].includes(code)) return "Fog";
  if ([51, 53, 55].includes(code)) return "Drizzle";
  if ([61, 63, 65].includes(code)) return "Rain";
  if ([71, 73, 75].includes(code)) return "Snow";
  if ([80, 81, 82].includes(code)) return "Showers";
  if ([95, 96, 99].includes(code)) return "Thunder";
  return "Weather";
}

// ---------- UI primitives ----------
function Card({ title, children, right }) {
  return (
    <div className="card" style={styles.card}>
      <div style={styles.cardHeader}>
        <div style={styles.cardTitle}>{title}</div>
        <div>{right}</div>
      </div>
      <div>{children}</div>
    </div>
  );
}

function Pill({ children, tone = "neutral" }) {
  const bg =
    tone === "good" ? "rgba(74, 222, 128, 0.15)" :
    tone === "bad" ? "rgba(248, 113, 113, 0.15)" :
    tone === "warn" ? "rgba(251, 191, 36, 0.15)" :
    "rgba(255,255,255,0.08)";
  const border =
    tone === "good" ? "rgba(74, 222, 128, 0.35)" :
    tone === "bad" ? "rgba(248, 113, 113, 0.35)" :
    tone === "warn" ? "rgba(251, 191, 36, 0.35)" :
    "rgba(255,255,255,0.18)";
  return (
    <span style={{ ...styles.pill, background: bg, borderColor: border }}>
      {children}
    </span>
  );
}

function Modal({ open, title, onClose, children, width = 720 }) {
  if (!open) return null;
  return (
    <div style={styles.modalOverlay} onMouseDown={onClose}>
      <div
        style={{ ...styles.modal, width }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div style={styles.modalHeader}>
          <div style={{ fontWeight: 700 }}>{title}</div>
          <button style={styles.btnGhost} onClick={onClose}>✕</button>
        </div>
        <div style={{ marginTop: 12 }}>{children}</div>
      </div>
    </div>
  );
}

// ---------- Main ----------
export default function App() {
  const [session, setSession] = useState(null);

  // Household state
  const [room, setRoom] = useState(null); // { id, code }
  const [roomMembers, setRoomMembers] = useState([]); // list rows
  const [joinCode, setJoinCode] = useState("");

  // Dashboard state
  const [now, setNow] = useState(new Date());
  const [monthCursor, setMonthCursor] = useState(() => startOfMonth(new Date()));
  const [selectedDate, setSelectedDate] = useState(() => new Date());
  const [eventsByDate, setEventsByDate] = useState({}); // { "YYYY-MM-DD": [events] }
  const [realtimeStatus, setRealtimeStatus] = useState({
    events: "CLOSED",
    members: "CLOSED",
  });

  // Weather
  const [locationKey, setLocationKey] = useState(() => localStorage.getItem("sh_location") || "winchester");
  const location = useMemo(() => LOCATIONS.find((l) => l.key === locationKey) || LOCATIONS[0], [locationKey]);
  const [weather, setWeather] = useState({ tempF: null, feelsF: null, windMph: null, code: null, text: "", hiF: null, loF: null });

  // Verse
  const [verseText, setVerseText] = useState(() => localStorage.getItem("sh_verse") || "We’ll wire a verse API later, or you can type your own.");
  const [verseDraft, setVerseDraft] = useState(verseText);

  // Modals
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [eventModalOpen, setEventModalOpen] = useState(false);

  // Event editor
  const [eventForm, setEventForm] = useState({ title: "", time: "", notes: "", id: null });
  const [eventBusy, setEventBusy] = useState(false);

  // ---------- Auth ----------
  useEffect(() => {
    let mounted = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      setSession(data.session || null);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession || null);
    });

    return () => {
      mounted = false;
      sub?.subscription?.unsubscribe?.();
    };
  }, []);

  // Clock tick
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  // Save verse
  useEffect(() => {
    localStorage.setItem("sh_verse", verseText);
  }, [verseText]);

  // Save location
  useEffect(() => {
    localStorage.setItem("sh_location", locationKey);
  }, [locationKey]);

  // ---------- Room bootstrap ----------
  useEffect(() => {
    if (!session?.user?.id) {
      setRoom(null);
      setRoomMembers([]);
      setEventsByDate({});
      return;
    }
    // Try to find a room this user belongs to (first match)
    (async () => {
      const uid = session.user.id;

      const { data: rm, error: rmErr } = await supabase
        .from("room_members")
        .select("room_id")
        .eq("user_id", uid)
        .limit(1);

      if (rmErr) {
        console.warn("room_members lookup error:", rmErr);
        return;
      }

      const roomId = rm?.[0]?.room_id;
      if (!roomId) {
        setRoom(null);
        return;
      }

      const { data: r, error: rErr } = await supabase
        .from("rooms")
        .select("id, code")
        .eq("id", roomId)
        .single();

      if (rErr) {
        console.warn("rooms fetch error:", rErr);
        return;
      }

      setRoom(r);
    })();
  }, [session?.user?.id]);

  // ---------- Weather ----------
  useEffect(() => {
    let cancelled = false;

    async function loadWeather() {
      try {
        // current + daily hi/lo
        const url =
          `https://api.open-meteo.com/v1/forecast` +
          `?latitude=${encodeURIComponent(location.lat)}` +
          `&longitude=${encodeURIComponent(location.lon)}` +
          `&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m` +
          `&daily=temperature_2m_max,temperature_2m_min` +
          `&temperature_unit=fahrenheit` +
          `&wind_speed_unit=mph` +
          `&timezone=auto`;

        const res = await fetch(url);
        const j = await res.json();

        if (cancelled) return;

        const cur = j.current || {};
        const daily = j.daily || {};
        const hiF = Array.isArray(daily.temperature_2m_max) ? daily.temperature_2m_max[0] : null;
        const loF = Array.isArray(daily.temperature_2m_min) ? daily.temperature_2m_min[0] : null;

        setWeather({
          tempF: cur.temperature_2m ?? null,
          feelsF: cur.apparent_temperature ?? null,
          windMph: cur.wind_speed_10m ?? null,
          code: cur.weather_code ?? null,
          text: weatherCodeToText(cur.weather_code),
          hiF,
          loF,
        });
      } catch (e) {
        console.warn("weather fetch failed:", e);
      }
    }

    loadWeather();
    const interval = setInterval(loadWeather, 10 * 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [location.lat, location.lon, locationKey]);

  // ---------- Load members + events when room changes ----------
  useEffect(() => {
    if (!room?.id) return;

    (async () => {
      const { data: m, error: mErr } = await supabase
        .from("room_members")
        .select("*")
        .eq("room_id", room.id);

      if (!mErr) setRoomMembers(m || []);
      else console.warn("members fetch error:", mErr);

      const start = new Date(monthCursor.getFullYear(), monthCursor.getMonth(), 1);
      const end = new Date(monthCursor.getFullYear(), monthCursor.getMonth() + 1, 0);

      // NOTE: assuming `date` column exists (date or text). If yours is `start_ts`, tell me and I’ll swap this.
      const { data: ev, error: evErr } = await supabase
        .from("events")
        .select("*")
        .eq("room_id", room.id)
        .gte("date", yyyyMmDd(start))
        .lte("date", yyyyMmDd(end))
        .order("date", { ascending: true });

      if (!evErr) {
        setEventsByDate(groupEvents(ev || []));
      } else {
        console.warn("events fetch error:", evErr);
      }
    })();
  }, [room?.id, monthCursor]);

  function groupEvents(events) {
    const map = {};
    for (const e of events) {
      const d = typeof e.date === "string" ? e.date : (e.date ? String(e.date).slice(0, 10) : null);
      if (!d) continue;
      if (!map[d]) map[d] = [];
      map[d].push(e);
    }
    return map;
  }

  // ---------- Realtime subscriptions ----------
  useEffect(() => {
    if (!room?.id) return;

    // Events channel
    const chEvents = supabase
      .channel(`events:${room.id}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "events", filter: `room_id=eq.${room.id}` },
        (payload) => {
          // Lightweight re-fetch for the month (simpler + reliable)
          setRealtimeStatus((s) => ({ ...s, events: "SUBSCRIBED" }));
          refreshMonthEvents(room.id, monthCursor);
        }
      )
      .subscribe((status) => {
        setRealtimeStatus((s) => ({ ...s, events: String(status).toUpperCase() }));
      });

    // Members channel
    const chMembers = supabase
      .channel(`members:${room.id}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "room_members", filter: `room_id=eq.${room.id}` },
        async () => {
          setRealtimeStatus((s) => ({ ...s, members: "SUBSCRIBED" }));
          const { data } = await supabase.from("room_members").select("*").eq("room_id", room.id);
          setRoomMembers(data || []);
        }
      )
      .subscribe((status) => {
        setRealtimeStatus((s) => ({ ...s, members: String(status).toUpperCase() }));
      });

    return () => {
      supabase.removeChannel(chEvents);
      supabase.removeChannel(chMembers);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room?.id]);

  async function refreshMonthEvents(roomId, monthDate) {
    const start = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1);
    const end = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0);
    const { data: ev } = await supabase
      .from("events")
      .select("*")
      .eq("room_id", roomId)
      .gte("date", yyyyMmDd(start))
      .lte("date", yyyyMmDd(end))
      .order("date", { ascending: true });

    setEventsByDate(groupEvents(ev || []));
  }

  // ---------- Actions: join/create/leave ----------
  async function createHousehold() {
    if (!session?.user?.id) return;
    const code = generateCode(5);

    // create room
    const { data: r, error: rErr } = await supabase
      .from("rooms")
      .insert([{ code }])
      .select("id, code")
      .single();

    if (rErr) {
      alert(rErr.message);
      return;
    }

    // add member
    const { error: mErr } = await supabase
      .from("room_members")
      .insert([{ room_id: r.id, user_id: session.user.id }]);

    if (mErr) {
      alert(mErr.message);
      return;
    }

    setRoom(r);
  }

  async function joinHousehold() {
    if (!session?.user?.id) return;
    const code = (joinCode || "").trim().toUpperCase();
    if (!code) return;

    const { data: r, error: rErr } = await supabase
      .from("rooms")
      .select("id, code")
      .eq("code", code)
      .single();

    if (rErr) {
      alert("Invalid code (room not found).");
      return;
    }

    const { error: mErr } = await supabase
      .from("room_members")
      .insert([{ room_id: r.id, user_id: session.user.id }]);

    if (mErr) {
      alert(mErr.message);
      return;
    }

    setRoom(r);
  }

  async function leaveHousehold() {
    if (!room?.id || !session?.user?.id) return;
    const ok = window.confirm("Leave this household?");
    if (!ok) return;

    const { error } = await supabase
      .from("room_members")
      .delete()
      .eq("room_id", room.id)
      .eq("user_id", session.user.id);

    if (error) {
      alert(error.message);
      return;
    }

    setRoom(null);
    setRoomMembers([]);
    setEventsByDate({});
    setSettingsOpen(false);
  }

  function copyHouseholdCode() {
    if (!room?.code) return;
    navigator.clipboard.writeText(room.code);
  }

  // ---------- Events ----------
  const selectedKey = useMemo(() => yyyyMmDd(selectedDate), [selectedDate]);
  const selectedEvents = eventsByDate[selectedKey] || [];

  const nextEvent = useMemo(() => {
    // Find next event from today onward in this month map
    const keys = Object.keys(eventsByDate).sort();
    const todayKey = yyyyMmDd(new Date());
    for (const k of keys) {
      if (k < todayKey) continue;
      const list = (eventsByDate[k] || []).slice().sort((a, b) => (a.time || "").localeCompare(b.time || ""));
      if (list.length) return { date: k, event: list[0] };
    }
    return null;
  }, [eventsByDate]);

  function openAddEvent(dateObj) {
    setSelectedDate(dateObj);
    setEventForm({ title: "", time: "", notes: "", id: null });
    setEventModalOpen(true);
  }

  async function saveEvent() {
    if (!room?.id || !session?.user?.id) return;
    const title = (eventForm.title || "").trim();
    if (!title) {
      alert("Add a title.");
      return;
    }

    setEventBusy(true);
    try {
      const payload = {
      room_id: room.id,
      title,
      date: selectedKey,
      time: (eventForm.time || "").trim() || null,
      notes: (eventForm.notes || "").trim() || null,
      // created_by: session.user.id,   // <-- REMOVE THIS LINE
    };

      if (eventForm.id) {
        const { error } = await supabase
          .from("events")
          .update(payload)
          .eq("id", eventForm.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("events").insert([payload]);
        if (error) throw error;
      }

      setEventModalOpen(false);
      await refreshMonthEvents(room.id, monthCursor);
    } catch (e) {
      alert(e.message || String(e));
    } finally {
      setEventBusy(false);
    }
  }

  async function deleteEvent(id) {
    if (!id) return;
    const ok = window.confirm("Delete this event?");
    if (!ok) return;

    const { error } = await supabase.from("events").delete().eq("id", id);
    if (error) {
      alert(error.message);
      return;
    }
    await refreshMonthEvents(room.id, monthCursor);
  }

  function editEvent(ev) {
    setEventForm({
      id: ev.id,
      title: ev.title || "",
      time: ev.time || "",
      notes: ev.notes || "",
    });
    setEventModalOpen(true);
  }

  // ---------- Calendar grid ----------
  const calendarCells = useMemo(() => {
    const first = startOfMonth(monthCursor);
    const last = endOfMonth(monthCursor);

    // Build a 6-week grid starting Sunday
    const start = new Date(first);
    start.setDate(first.getDate() - first.getDay());

    const cells = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const key = yyyyMmDd(d);
      const inMonth = d.getMonth() === monthCursor.getMonth();
      cells.push({
        date: d,
        key,
        inMonth,
        count: (eventsByDate[key] || []).length,
      });
    }
    return cells;
  }, [monthCursor, eventsByDate]);

  // ---------- UI: auth gate ----------
  if (!session) {
    return (
      <div style={styles.page}>
        <div style={{ maxWidth: 560, margin: "120px auto", padding: 24 }}>
          <h1 style={{ margin: 0, fontSize: 34 }}>Schedule Hub</h1>
          <p style={{ opacity: 0.8, marginTop: 10 }}>
            Sign in with your magic link to use your household dashboard.
          </p>
          <AuthBox />
        </div>
      </div>
    );
  }

  // ---------- UI: household gate ----------
  if (!room) {
    return (
      <div style={styles.page}>
        <TopBar
          room={null}
          onSettings={() => setSettingsOpen(true)}
          onSignOut={() => supabase.auth.signOut()}
        />

        <div style={{ maxWidth: 860, margin: "110px auto", padding: 24 }}>
          <Card title="HOUSEHOLD">
            <div style={{ opacity: 0.85, marginBottom: 14 }}>
              Join a household with a code, or create a new one.
            </div>

            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 6 }}>Join with code</div>
                <input
                  style={styles.input}
                  placeholder="Example: A1B2C3"
                  value={joinCode}
                  onChange={(e) => setJoinCode(e.target.value)}
                />
              </div>
              <button style={styles.btn} onClick={joinHousehold}>Join</button>
            </div>

            <div style={{ margin: "14px 0", opacity: 0.5 }}>Or</div>

            <button style={{ ...styles.btnWide }} onClick={createHousehold}>
              Create new household
            </button>

            <div style={{ marginTop: 10, fontSize: 12, opacity: 0.7 }}>
              After creating, share the code with your family.
            </div>
          </Card>
        </div>
      </div>
    );
  }

  // ---------- Main dashboard ----------
  return (
    <div style={styles.page}>
      <TopBar
        room={room}
        onSettings={() => setSettingsOpen(true)}
        onSignOut={() => supabase.auth.signOut()}
      />

      <div style={styles.dashboardWrap}>
        {/* Left column */}
        <div style={styles.leftCol}>
          <Card title="CLOCK">
            <div style={{ fontSize: 64, fontWeight: 800, lineHeight: 1 }}>{fmtClock(now)}</div>
            <div style={{ marginTop: 8, opacity: 0.85 }}>{fmtDayLong(now)}</div>
          </Card>

          <Card
            title="WEATHER"
            right={
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <button
                  style={styles.btnGhost}
                  onClick={() => {
                    const idx = LOCATIONS.findIndex((l) => l.key === locationKey);
                    const prev = LOCATIONS[(idx - 1 + LOCATIONS.length) % LOCATIONS.length];
                    setLocationKey(prev.key);
                  }}
                >
                  ◀
                </button>
                <div style={{ fontSize: 13, opacity: 0.9, minWidth: 140 }}>{location.label}</div>
                <button
                  style={styles.btnGhost}
                  onClick={() => {
                    const idx = LOCATIONS.findIndex((l) => l.key === locationKey);
                    const next = LOCATIONS[(idx + 1) % LOCATIONS.length];
                    setLocationKey(next.key);
                  }}
                >
                  ▶
                </button>
              </div>
            }
          >
            <div style={{ display: "flex", gap: 14, alignItems: "flex-end" }}>
              <div style={{ fontSize: 56, fontWeight: 800 }}>
                {weather.tempF == null ? "—" : `${Math.round(weather.tempF)}°`}
              </div>
              <div style={{ opacity: 0.85, marginBottom: 10 }}>
                <div style={{ display: "flex", gap: 10 }}>
                  <div style={{ minWidth: 60, opacity: 0.75 }}>Feels</div>
                  <div>{weather.feelsF == null ? "—" : `${Math.round(weather.feelsF)}°`}</div>
                </div>
                <div style={{ display: "flex", gap: 10 }}>
                  <div style={{ minWidth: 60, opacity: 0.75 }}>Wind</div>
                  <div>{weather.windMph == null ? "—" : `${Math.round(weather.windMph)} mph`}</div>
                </div>
                <div style={{ display: "flex", gap: 10 }}>
                  <div style={{ minWidth: 60, opacity: 0.75 }}>Today</div>
                  <div>{weather.loF == null || weather.hiF == null ? "—" : `${Math.round(weather.loF)}° / ${Math.round(weather.hiF)}°`}</div>
                </div>
                <div style={{ display: "flex", gap: 10 }}>
                  <div style={{ minWidth: 60, opacity: 0.75 }}>Sky</div>
                  <div>{weather.text || "—"}</div>
                </div>
              </div>
            </div>
          </Card>

          <Card title="NEXT EVENT">
            {nextEvent ? (
              <div>
                <div style={{ fontWeight: 800, fontSize: 18 }}>{nextEvent.event.title}</div>
                <div style={{ opacity: 0.8, marginTop: 6 }}>
                  {nextEvent.date}{nextEvent.event.time ? ` • ${nextEvent.event.time}` : ""}
                </div>
                {nextEvent.event.notes ? (
                  <div style={{ opacity: 0.75, marginTop: 10 }}>{nextEvent.event.notes}</div>
                ) : null}
              </div>
            ) : (
              <Pill tone="neutral">None</Pill>
            )}
            <div style={{ fontSize: 12, opacity: 0.65, marginTop: 10 }}>Click a day to add/edit.</div>
          </Card>
        </div>

        {/* Center calendar */}
        <div style={styles.centerCol}>
          <div style={styles.calendarHeader}>
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <button style={styles.btnGhost} onClick={() => setMonthCursor(addMonths(monthCursor, -1))}>◀</button>
              <div style={styles.monthTitle}>{monthLabel(monthCursor)}</div>
              <button style={styles.btnGhost} onClick={() => setMonthCursor(addMonths(monthCursor, +1))}>▶</button>
            </div>

            <div style={{ display: "flex", gap: 10 }}>
              <button style={styles.btnGhost} onClick={() => setSettingsOpen(true)}>Settings</button>
            </div>
          </div>

          <div style={styles.calendarWeekdays}>
            {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
              <div key={d} style={styles.weekday}>{d}</div>
            ))}
          </div>

          <div style={styles.calendarGrid}>
            {calendarCells.map((c) => {
              const isSelected = yyyyMmDd(selectedDate) === c.key;
              const isToday = yyyyMmDd(new Date()) === c.key;

              return (
                <div
                  key={c.key}
                  style={{
                    ...styles.dayCell,
                    opacity: c.inMonth ? 1 : 0.35,
                    outline: isSelected ? "2px solid rgba(255,255,255,0.25)" : "none",
                    boxShadow: isToday ? "0 0 0 2px rgba(74, 222, 128, 0.22) inset" : "none",
                  }}
                  onClick={() => {
                    setSelectedDate(c.date);
                    setEventModalOpen(true);
                    setEventForm({ title: "", time: "", notes: "", id: null });
                  }}
                >
                  <div style={styles.dayNum}>{c.date.getDate()}</div>
                  <div style={styles.dayEvents}>
                    {c.count > 0 ? <Pill tone="good">{c.count}</Pill> : null}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Selected day events panel */}
          <div style={{ marginTop: 16 }}>
            <Card
              title={`EVENTS • ${selectedKey}`}
              right={
                <button style={styles.btn} onClick={() => openAddEvent(selectedDate)}>
                  + Add event
                </button>
              }
            >
              {selectedEvents.length === 0 ? (
                <div style={{ opacity: 0.75 }}>No events yet for this day.</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {selectedEvents
                    .slice()
                    .sort((a, b) => (a.time || "").localeCompare(b.time || ""))
                    .map((ev) => (
                      <div key={ev.id} style={styles.eventRow}>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontWeight: 800 }}>
                            {ev.title}{" "}
                            {ev.time ? <span style={{ opacity: 0.7, fontWeight: 600 }}>• {ev.time}</span> : null}
                          </div>
                          {ev.notes ? <div style={{ opacity: 0.75, marginTop: 4 }}>{ev.notes}</div> : null}
                        </div>
                        <div style={{ display: "flex", gap: 8 }}>
                          <button style={styles.btnGhost} onClick={() => editEvent(ev)}>Edit</button>
                          <button style={styles.btnDanger} onClick={() => deleteEvent(ev.id)}>Delete</button>
                        </div>
                      </div>
                    ))}
                </div>
              )}
            </Card>
          </div>
        </div>

        {/* Right column */}
        <div style={styles.rightCol}>
          <Card title="VERSE OF THE DAY (PLACEHOLDER)">
            <textarea
              style={styles.textarea}
              value={verseDraft}
              onChange={(e) => setVerseDraft(e.target.value)}
              placeholder="Type a verse or note..."
            />
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
              <button
                style={styles.btn}
                onClick={() => setVerseText(verseDraft)}
              >
                Save
              </button>
            </div>
          </Card>

          <Card title="STATUS">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <Pill tone="good">Online</Pill>
              <div style={{ opacity: 0.8, fontSize: 13 }}>Local dev</div>
            </div>
            <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={styles.statusRow}>
                <div style={{ opacity: 0.7 }}>Realtime: Events</div>
                <Pill tone={String(realtimeStatus.events).includes("ERROR") ? "bad" : "neutral"}>
                  {realtimeStatus.events}
                </Pill>
              </div>
              <div style={styles.statusRow}>
                <div style={{ opacity: 0.7 }}>Realtime: Members</div>
                <Pill tone={String(realtimeStatus.members).includes("ERROR") ? "bad" : "neutral"}>
                  {realtimeStatus.members}
                </Pill>
              </div>
            </div>
          </Card>

          <Card title="HOUSEHOLD">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ opacity: 0.85 }}>Code</div>
              <div style={{ fontWeight: 900, letterSpacing: 1 }}>{room.code}</div>
            </div>

            <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
              <button style={styles.btnWide} onClick={copyHouseholdCode}>Copy household code</button>
            </div>

            <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
              <button style={styles.btnWideGhost} onClick={leaveHousehold}>Leave household</button>
            </div>

            <div style={{ marginTop: 14, fontSize: 12, opacity: 0.7 }}>
              Members: {roomMembers.length}
            </div>
          </Card>
        </div>
      </div>

      {/* Settings Modal */}
      <Modal open={settingsOpen} title="Settings" onClose={() => setSettingsOpen(false)} width={760}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <div>
            <div style={styles.sectionTitle}>Household</div>
            <div style={styles.miniRow}>
              <div style={{ opacity: 0.75 }}>Code</div>
              <div style={{ fontWeight: 900 }}>{room.code}</div>
            </div>
            <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
              <button style={styles.btn} onClick={copyHouseholdCode}>Copy code</button>
              <button style={styles.btnDanger} onClick={leaveHousehold}>Leave</button>
            </div>
          </div>

          <div>
            <div style={styles.sectionTitle}>Dashboard</div>
            <div style={{ opacity: 0.75, marginBottom: 8 }}>Location (Weather)</div>
            <select
              style={styles.select}
              value={locationKey}
              onChange={(e) => setLocationKey(e.target.value)}
            >
              {LOCATIONS.map((l) => (
                <option key={l.key} value={l.key}>{l.label}</option>
              ))}
            </select>

            <div style={{ opacity: 0.75, marginTop: 14, marginBottom: 8 }}>Verse text</div>
            <textarea
              style={styles.textarea}
              value={verseDraft}
              onChange={(e) => setVerseDraft(e.target.value)}
            />
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
              <button style={styles.btn} onClick={() => setVerseText(verseDraft)}>Save</button>
            </div>
          </div>
        </div>

        <div style={{ marginTop: 18, opacity: 0.7, fontSize: 12 }}>
          Tip: If realtime ever shows <b>CLOSED</b> or <b>CHANNEL_ERROR</b>, refresh the page and verify Realtime is enabled in Supabase for your tables.
        </div>
      </Modal>

      {/* Event Modal */}
      <Modal
        open={eventModalOpen}
        title={`Events for ${selectedKey}`}
        onClose={() => setEventModalOpen(false)}
        width={820}
      >
        <div style={{ display: "grid", gridTemplateColumns: "1.2fr 0.8fr", gap: 16 }}>
          <div>
            <div style={styles.sectionTitle}>Add / Edit Event</div>

            <div style={{ display: "flex", gap: 10 }}>
              <div style={{ flex: 1 }}>
                <div style={styles.label}>Title</div>
                <input
                  style={styles.input}
                  value={eventForm.title}
                  onChange={(e) => setEventForm((s) => ({ ...s, title: e.target.value }))}
                  placeholder="Example: Practice, homework, family dinner..."
                />
              </div>
              <div style={{ width: 150 }}>
                <div style={styles.label}>Time (optional)</div>
                <input
                  style={styles.input}
                  value={eventForm.time}
                  onChange={(e) => setEventForm((s) => ({ ...s, time: e.target.value }))}
                  placeholder="7:30 PM"
                />
              </div>
            </div>

            <div style={{ marginTop: 10 }}>
              <div style={styles.label}>Notes (optional)</div>
              <textarea
                style={styles.textarea}
                value={eventForm.notes}
                onChange={(e) => setEventForm((s) => ({ ...s, notes: e.target.value }))}
                placeholder="Anything else..."
              />
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 12 }}>
              <button style={styles.btnGhost} onClick={() => setEventModalOpen(false)}>Cancel</button>
              <button style={styles.btn} disabled={eventBusy} onClick={saveEvent}>
                {eventBusy ? "Saving..." : "Save event"}
              </button>
            </div>
          </div>

          <div>
            <div style={styles.sectionTitle}>This day</div>
            {selectedEvents.length === 0 ? (
              <div style={{ opacity: 0.75 }}>No events yet.</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {selectedEvents
                  .slice()
                  .sort((a, b) => (a.time || "").localeCompare(b.time || ""))
                  .map((ev) => (
                    <div key={ev.id} style={{ ...styles.eventRow, padding: 10 }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 800 }}>
                          {ev.title}{" "}
                          {ev.time ? <span style={{ opacity: 0.7, fontWeight: 600 }}>• {ev.time}</span> : null}
                        </div>
                        {ev.notes ? <div style={{ opacity: 0.75, marginTop: 4 }}>{ev.notes}</div> : null}
                      </div>
                      <div style={{ display: "flex", gap: 8 }}>
                        <button style={styles.btnGhost} onClick={() => editEvent(ev)}>Edit</button>
                        <button style={styles.btnDanger} onClick={() => deleteEvent(ev.id)}>Del</button>
                      </div>
                    </div>
                  ))}
              </div>
            )}

            <div style={{ marginTop: 12, fontSize: 12, opacity: 0.7 }}>
              Click a calendar day to open this panel.
            </div>
          </div>
        </div>
      </Modal>
    </div>
  );
}

// ---------- Auth Box ----------
function AuthBox() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function sendLink() {
    const e = (email || "").trim();
    if (!e) return;
    setBusy(true);
    try {
      const { error } = await supabase.auth.signInWithOtp({
        email: e,
        options: {
          emailRedirectTo: window.location.origin,
        },
      });
      if (error) throw error;
      setSent(true);
    } catch (err) {
      alert(err.message || String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={styles.authBox}>
      <div style={{ fontWeight: 700, marginBottom: 8 }}>Sign in</div>
      <input
        style={styles.input}
        placeholder="you@email.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <button style={{ ...styles.btnWide, marginTop: 10 }} onClick={sendLink} disabled={busy}>
        {busy ? "Sending..." : "Send magic link"}
      </button>
      {sent ? (
        <div style={{ marginTop: 10, opacity: 0.75 }}>
          Check your email for the login link.
        </div>
      ) : null}
    </div>
  );
}

// ---------- Top Bar ----------
function TopBar({ room, onSettings, onSignOut }) {
  return (
    <div style={styles.topBar}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={styles.dot} />
        <div style={{ fontWeight: 900, fontSize: 18 }}>Schedule Hub</div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        {room?.code ? (
          <div style={{ opacity: 0.8, fontSize: 13 }}>
            Household • Code: <b style={{ letterSpacing: 1 }}>{room.code}</b>
          </div>
        ) : null}

        <button style={styles.btnGhost} onClick={onSettings}>Settings</button>
        <button style={styles.btnGhost} onClick={onSignOut}>Sign out</button>
      </div>
    </div>
  );
}

// ---------- Code generator ----------
function generateCode(len = 5) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no confusing 0/O/1/I
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

// ---------- Styles ----------
const styles = {
  page: {
    minHeight: "100vh",
    background: "radial-gradient(1200px 700px at 20% 10%, rgba(255,255,255,0.08), rgba(0,0,0,0)) , linear-gradient(180deg, rgba(0,0,0,0.35), rgba(0,0,0,0.65))",
    color: "rgba(255,255,255,0.92)",
  },
  topBar: {
    position: "sticky",
    top: 0,
    zIndex: 10,
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "18px 22px",
    backdropFilter: "blur(18px)",
    background: "rgba(0,0,0,0.25)",
    borderBottom: "1px solid rgba(255,255,255,0.08)",
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 999,
    background: "rgba(74, 222, 128, 0.9)",
    boxShadow: "0 0 18px rgba(74, 222, 128, 0.6)",
  },
  dashboardWrap: {
    maxWidth: 1500,
    margin: "22px auto",
    padding: "0 22px 40px",
    display: "grid",
    gridTemplateColumns: "360px 1fr 360px",
    gap: 16,
  },
  leftCol: { display: "flex", flexDirection: "column", gap: 16 },
  centerCol: { display: "flex", flexDirection: "column", gap: 0 },
  rightCol: { display: "flex", flexDirection: "column", gap: 16 },

  card: {
    borderRadius: 18,
    padding: 16,
    background: "rgba(255,255,255,0.06)",
    border: "1px solid rgba(255,255,255,0.10)",
    boxShadow: "0 16px 38px rgba(0,0,0,0.28)",
    backdropFilter: "blur(14px)",
  },
  cardHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 10,
  },
  cardTitle: {
    fontSize: 12,
    letterSpacing: 1.2,
    opacity: 0.75,
    fontWeight: 800,
  },

  calendarHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 10,
    padding: "8px 4px",
  },
  monthTitle: { fontWeight: 900, fontSize: 14, letterSpacing: 0.3, opacity: 0.9 },
  calendarWeekdays: {
    display: "grid",
    gridTemplateColumns: "repeat(7, 1fr)",
    gap: 10,
    marginBottom: 10,
    padding: "0 2px",
  },
  weekday: {
    opacity: 0.6,
    fontSize: 12,
    fontWeight: 700,
    textAlign: "center",
  },
  calendarGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(7, 1fr)",
    gap: 10,
  },
  dayCell: {
    height: 84,
    borderRadius: 16,
    padding: 10,
    cursor: "pointer",
    background: "rgba(255,255,255,0.05)",
    border: "1px solid rgba(255,255,255,0.09)",
    backdropFilter: "blur(10px)",
    transition: "transform 0.08s ease",
  },
  dayNum: { fontWeight: 900, opacity: 0.9 },
  dayEvents: { marginTop: 10 },

  pill: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    height: 26,
    padding: "0 10px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,0.18)",
    fontSize: 12,
    fontWeight: 800,
  },

  btn: {
    height: 38,
    padding: "0 14px",
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.18)",
    background: "rgba(255,255,255,0.10)",
    color: "rgba(255,255,255,0.92)",
    fontWeight: 800,
    cursor: "pointer",
  },
  btnGhost: {
    height: 36,
    padding: "0 12px",
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.16)",
    background: "rgba(255,255,255,0.06)",
    color: "rgba(255,255,255,0.9)",
    fontWeight: 800,
    cursor: "pointer",
  },
  btnDanger: {
    height: 36,
    padding: "0 12px",
    borderRadius: 12,
    border: "1px solid rgba(248,113,113,0.25)",
    background: "rgba(248,113,113,0.10)",
    color: "rgba(255,255,255,0.92)",
    fontWeight: 900,
    cursor: "pointer",
  },
  btnWide: {
    width: "100%",
    height: 44,
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,0.18)",
    background: "rgba(255,255,255,0.10)",
    color: "rgba(255,255,255,0.92)",
    fontWeight: 900,
    cursor: "pointer",
  },
  btnWideGhost: {
    width: "100%",
    height: 44,
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,0.16)",
    background: "rgba(255,255,255,0.06)",
    color: "rgba(255,255,255,0.92)",
    fontWeight: 900,
    cursor: "pointer",
  },

  input: {
    width: "100%",
    height: 42,
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.14)",
    outline: "none",
    padding: "0 12px",
    background: "rgba(0,0,0,0.18)",
    color: "rgba(255,255,255,0.92)",
  },
  select: {
    width: "100%",
    height: 42,
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.14)",
    outline: "none",
    padding: "0 12px",
    background: "rgba(0,0,0,0.18)",
    color: "rgba(255,255,255,0.92)",
  },
  textarea: {
    width: "100%",
    minHeight: 110,
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.14)",
    outline: "none",
    padding: 12,
    background: "rgba(0,0,0,0.18)",
    color: "rgba(255,255,255,0.92)",
    resize: "vertical",
  },

  modalOverlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.55)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
    zIndex: 50,
  },
  modal: {
    borderRadius: 18,
    padding: 16,
    background: "rgba(20, 25, 28, 0.92)",
    border: "1px solid rgba(255,255,255,0.10)",
    boxShadow: "0 22px 80px rgba(0,0,0,0.55)",
    backdropFilter: "blur(18px)",
    maxHeight: "86vh",
    overflow: "auto",
  },
  modalHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },

  authBox: {
    borderRadius: 18,
    padding: 16,
    background: "rgba(255,255,255,0.06)",
    border: "1px solid rgba(255,255,255,0.10)",
  },

  sectionTitle: {
    fontSize: 12,
    letterSpacing: 1.2,
    opacity: 0.75,
    fontWeight: 900,
    marginBottom: 10,
  },
  label: {
    fontSize: 12,
    opacity: 0.75,
    fontWeight: 800,
    marginBottom: 6,
  },
  miniRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "10px 0",
    borderBottom: "1px solid rgba(255,255,255,0.08)",
  },
  eventRow: {
    display: "flex",
    gap: 10,
    alignItems: "flex-start",
    padding: 12,
    borderRadius: 14,
    background: "rgba(255,255,255,0.05)",
    border: "1px solid rgba(255,255,255,0.08)",
  },
  statusRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },
};
