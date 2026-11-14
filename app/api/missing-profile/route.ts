import { NextResponse } from "next/server";
import { XMLParser } from "fast-xml-parser";

export const runtime = "nodejs";
export const maxDuration = 30;

type X = string | number | X[] | { [key: string]: X } | null | undefined;
const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
  isArray: (name) => name === "G_ROOM",
});

function value(node: X): string {
  if (node == null) return "";
  if (typeof node === "string" || typeof node === "number") return String(node).trim();
  if (Array.isArray(node)) return node.map(value).filter(Boolean).join(" ");
  return value(node["#text"]);
}
function field(node: X, name: string): string {
  if (!node || typeof node !== "object" || Array.isArray(node)) return "";
  return value((node as { [key: string]: X })[name]);
}
function roomCode(raw: string): string {
  const digits = raw.trim();
  return /^\d+$/.test(digits) ? digits.padStart(4, "0") : digits;
}
function splitNames(raw: string): string[] {
  return raw.split("/").map((name) => name.trim()).filter(Boolean);
}

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "من فضلك اختر تقرير Guests INH - By Room." }, { status: 400 });
    }
    if (file.size > 20 * 1024 * 1024) {
      return NextResponse.json({ error: "حجم الملف يجب ألا يتجاوز 20 ميجابايت." }, { status: 413 });
    }
    const xml = await file.text();
    let parsed: X;
    try { parsed = parser.parse(xml); }
    catch { return NextResponse.json({ error: "تعذر قراءة XML. تأكد أن الملف سليم." }, { status: 400 }); }

    const root = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as { [key: string]: X } : {};
    const data = root.GIBYROOM ?? root;
    const list = field(data, "LIST_G_ROOM") ? (data as { [key: string]: X }).LIST_G_ROOM : (data as { [key: string]: X }).LIST_G_ROOM;
    const listObj = list && typeof list === "object" && !Array.isArray(list) ? list as { [key: string]: X } : {};
    const rawRooms = listObj.G_ROOM;
    const records = Array.isArray(rawRooms) ? rawRooms : rawRooms ? [rawRooms] : [];

    if (!records.length) {
      return NextResponse.json({ error: "لم يتم العثور على سجلات G_ROOM داخل LIST_G_ROOM." }, { status: 400 });
    }

    const results = records.map((record) => {
      const room = roomCode(field(record, "ROOM"));
      const mainName = field(record, "GUEST_NAME") || field(record, "FULL_NAME");
      const accompanyingRaw = field(record, "ACCOMPANYING_NAMES");
      const accompanying = splitNames(accompanyingRaw);
      const names = [...(mainName ? [mainName] : []), ...accompanying];
      const adults = Math.max(0, Number(field(record, "ADULTS")) || 0);
      const children = Math.max(0, Number(field(record, "CHILDREN")) || 0);
      const expected = adults + children;
      const found = names.length;
      return {
        room,
        mainName,
        accompanyingNames: accompanying,
        names,
        adults,
        children,
        expected,
        found,
        difference: expected - found,
        company: field(record, "COMPANY_NAME"),
        arrival: field(record, "ARRIVAL"),
        departure: field(record, "DEPARTURE"),
        status: found < expected ? "missing" : found > expected ? "extra" : "complete",
      };
    }).filter((row) => row.room);

    const mismatches = results.filter((row) => row.status !== "complete");
    return NextResponse.json({
      totalRooms: results.length,
      checkedRooms: results.length,
      mismatchCount: mismatches.length,
      missingCount: mismatches.filter((row) => row.status === "missing").length,
      extraCount: mismatches.filter((row) => row.status === "extra").length,
      rows: mismatches.sort((a, b) => a.room.localeCompare(b.room, undefined, { numeric: true })),
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "حدث خطأ أثناء فحص التقرير." }, { status: 500 });
  }
}
