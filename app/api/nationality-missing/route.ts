import { NextResponse } from "next/server";
import { XMLParser } from "fast-xml-parser";

export const runtime = "nodejs";
export const maxDuration = 30;

type XmlValue = string | number | XmlObject | XmlValue[] | null | undefined;
type XmlObject = { [key: string]: XmlValue };

const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
  isArray: (name) => name === "G_C12",
});

function asArray(value: XmlValue): XmlValue[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}
function child(node: XmlValue, key: string): XmlValue {
  if (!node || typeof node !== "object" || Array.isArray(node)) return undefined;
  return (node as XmlObject)[key];
}
function textValue(value: XmlValue): string {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  const text = child(value, "#text");
  return text == null ? "" : textValue(text);
}
function descendants(node: XmlValue, key: string): XmlValue[] {
  const found: XmlValue[] = [];
  if (!node || typeof node !== "object") return found;
  if (Array.isArray(node)) {
    for (const item of node) found.push(...descendants(item, key));
    return found;
  }
  for (const [name, value] of Object.entries(node as XmlObject)) {
    if (name === key) found.push(...asArray(value));
    else found.push(...descendants(value, key));
  }
  return found;
}
function firstText(node: XmlValue, key: string): string {
  const direct = child(node, key);
  return textValue(direct !== undefined ? direct : descendants(node, key)[0]).trim();
}

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "من فضلك ارفع تقرير Guest INH By Nationality بصيغة XML." }, { status: 400 });
    }
    if (!file.name.toLowerCase().endsWith(".xml")) {
      return NextResponse.json({ error: "الملف يجب أن يكون بصيغة XML." }, { status: 400 });
    }
    if (file.size > 20 * 1024 * 1024) {
      return NextResponse.json({ error: "حجم الملف يجب ألا يتجاوز 20 ميجابايت." }, { status: 413 });
    }

    let root: XmlValue;
    try {
      root = parser.parse(await file.text());
    } catch {
      throw new Error("تعذر قراءة ملف XML. تأكد أن التقرير سليم.");
    }
    const records = descendants(root, "G_C12");
    if (!records.length) {
      throw new Error("لم يتم العثور على سجلات G_C12. ارفع تقرير Guest INH By Nationality الصحيح.");
    }

    const rooms = new Set<string>();
    let missingNationalityRecords = 0;
    for (const record of records) {
      if (firstText(record, "C69")) continue;
      const rawRoom = firstText(record, "C15");
      if (!/^\\d+$/.test(rawRoom)) continue;
      rooms.add(rawRoom.padStart(4, "0"));
      missingNationalityRecords++;
    }

    const sortedRooms = [...rooms].sort((a, b) => Number(a) - Number(b));
    return NextResponse.json({
      rooms: sortedRooms,
      count: sortedRooms.length,
      missingNationalityRecords,
      recordsCount: records.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "حدث خطأ أثناء فحص تقرير الجنسيات.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
