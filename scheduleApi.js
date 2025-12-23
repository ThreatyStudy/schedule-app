import { supabase } from "./supabaseClient";

// Load all events for a room (you can later optimize to month-range)
export async function loadRoomEvents(roomId) {
  const { data, error } = await supabase
    .from("events")
    .select("date_key,text,updated_at")
    .eq("room_id", roomId);

  if (error) throw error;

  const map = {};
  for (const row of data) map[row.date_key] = row.text;
  return map;
}

// Upsert event (insert or update if already exists)
export async function upsertEvent(roomId, dateKey, text) {
  const clean = text.trim();

  if (!clean) {
    // delete if cleared
    const { error } = await supabase
      .from("events")
      .delete()
      .eq("room_id", roomId)
      .eq("date_key", dateKey);

    if (error) throw error;
    return;
  }

  const { error } = await supabase
    .from("events")
    .upsert({ room_id: roomId, date_key: dateKey, text: clean }, { onConflict: "room_id,date_key" });

  if (error) throw error;
}
